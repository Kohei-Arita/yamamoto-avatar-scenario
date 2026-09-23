import { appendDialogueLog, getDialogueLogs, bindDebugSession } from "./dialogue-log.store.js";
import { broadcastScenarioState, subscribeDialogueEvents } from "./dialogue-events.js";
import {
  isAllowedDialogueSession,
  isRegisteredSessionId,
  registerKnownSessionId
} from "./session-registry.js";
import { SERVER_EPOCH } from "../scenario/scenario.store.js";
import { writeSseEvent, setSseHeaders } from "../../shared/http/sse.js";
import { getScenarioEngine } from "../scenario/scenario-engine.js";
import {
  answerUserText,
  bindDialogueSession,
  streamScenarioReply,
  toSpeechBatch
} from "./dialogue.service.js";

function toSpeechSegmentPayload(segment) {
  if (typeof segment === "string") {
    return {
      text: segment,
      speechText: segment,
      subtitleText: segment
    };
  }

  return {
    speechId: segment?.speechId,
    segmentIndex: segment?.segmentIndex,
    segmentCount: segment?.segmentCount,
    state: segment?.state,
    text: segment?.speechText || "",
    speechText: segment?.speechText || "",
    subtitleText: segment?.subtitleText || segment?.speechText || ""
  };
}

// 起動直後も未知・未指定のsessionIdを拒否し、別セッションへの暗黙の操作を防ぐ。
function rejectUnknownSession(req, res) {
  const sessionId = req.body?.sessionId || req.query?.sessionId || null;

  if (isAllowedDialogueSession(sessionId)) {
    return false;
  }

  console.warn(
    "[dialogue] unknown_session_rejected",
    JSON.stringify({ sessionId, path: req.path })
  );
  res.status(403).json({ ok: false, error: "Unknown session" });
  return true;
}

export function postBindDialogueSession(req, res) {
  const { sessionId } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "sessionId is required" });
  }

  if (rejectUnknownSession(req, res)) {
    return undefined;
  }

  const session = bindDialogueSession(sessionId);
  console.log("[dialogue] bind_session", JSON.stringify({ sessionId }));

  return res.json({ ok: true, ...session });
}

// 有効な文字起こしがないまま受付上限に達した会場画面から、入力停止だけを受け付ける。
export function postInputTimeout(req, res) {
  const { sessionId, expectedVersion, expectedEpoch } = req.body || {};
  if (
    typeof sessionId !== "string" ||
    !sessionId ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    return res.status(400).json({ ok: false, error: "sessionId and expectedVersion are required" });
  }
  if (!isRegisteredSessionId(sessionId)) {
    return res.status(403).json({ ok: false, error: "Unknown session" });
  }
  const engine = getScenarioEngine();
  const current = engine.getInputState(sessionId);
  if (current.version !== expectedVersion || (expectedEpoch && current.epoch !== expectedEpoch)) {
    return res.status(409).json({ ok: false, error: "Scenario has changed", state: current });
  }
  if (!current.acceptsPatientInput) return res.json({ ok: true, state: current });

  const state = engine.setInputPaused(sessionId, true);
  appendDialogueLog({
    sessionId,
    kind: "input_timeout",
    nodeId: state.nodeId,
    reason: "no_transcript_within_30s"
  });
  broadcastScenarioState(sessionId, state);
  console.log("[dialogue] input_timeout", JSON.stringify({ sessionId, nodeId: state.nodeId }));
  return res.json({ ok: true, state });
}

export function getDialogueLogsController(req, res) {
  const { sessionId } = req.query;

  return res.json({
    ok: true,
    logs: getDialogueLogs(sessionId)
  });
}

export function postPlaybackState(req, res) {
  const { sessionId, status, message = "", sequence, expectedEpoch } = req.body || {};
  if (rejectUnknownSession(req, res)) return;
  if (
    !["speaking", "idle", "error"].includes(status) ||
    typeof message !== "string" ||
    message.length > 500 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    typeof expectedEpoch !== "string"
  ) {
    return res.status(400).json({ ok: false, error: "Invalid playback status" });
  }
  const applied = getScenarioEngine().reportPlayback(sessionId, {
    status,
    message,
    sequence,
    expectedEpoch
  });
  if (applied && status === "error")
    appendDialogueLog({ sessionId, kind: "playback_error", answerPreview: message });
  return res.json({ ok: true, applied });
}

export function getDialogueEventsController(req, res) {
  const { sessionId, epoch } = req.query;
  const engine = getScenarioEngine();
  // 認証済みの会場画面が旧プロセスから再接続した場合。勝手に冒頭を読まず操作待ちにする。
  if (
    !isRegisteredSessionId(sessionId) &&
    typeof epoch === "string" &&
    epoch.length > 0 &&
    epoch.length <= 128 &&
    epoch !== SERVER_EPOCH
  ) {
    registerKnownSessionId(sessionId);
    if (isRegisteredSessionId(sessionId)) {
      engine.requireRecovery(sessionId);
      bindDebugSession(sessionId, { source: "server-recovery" });
    }
  }
  if (rejectUnknownSession(req, res)) return;

  setSseHeaders(res);
  subscribeDialogueEvents(
    sessionId,
    res,
    engine.getInputState(sessionId),
    toSpeechBatch(engine.getNodeLines(sessionId).lines.join("\n"), engine.getInputState(sessionId))
  );
  console.log("[dialogue] events_subscribed", JSON.stringify({ sessionId: sessionId || null }));
}

export async function postRespondWithDialogue(req, res) {
  const { sessionId, text } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({ ok: false, error: "text is required" });
  }

  if (rejectUnknownSession(req, res)) {
    return undefined;
  }

  try {
    console.log(
      "[dialogue] respond_request",
      JSON.stringify({
        sessionId: sessionId || null,
        userTextPreview: text.slice(0, 120)
      })
    );

    const result = await answerUserText(text, sessionId || null);

    return res.json({
      ok: true,
      content: result.content,
      speechContent: result.speechContent
    });
  } catch (error) {
    console.error(
      "[dialogue] respond_error",
      JSON.stringify({
        sessionId: sessionId || null,
        message: error.message,
        details: error.details || null
      })
    );

    return res.status(500).json({
      ok: false,
      error: "Dialogue answer generation failed"
    });
  }
}

export async function postRespondWithDialogueStream(req, res) {
  const { sessionId, text, revision, expectedVersion, expectedEpoch } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({ ok: false, error: "text is required" });
  }

  if (rejectUnknownSession(req, res)) {
    return undefined;
  }

  const abortController = new AbortController();
  let responseClosed = false;

  res.on("close", () => {
    responseClosed = true;
    abortController.abort();
  });

  setSseHeaders(res);

  try {
    console.log(
      "[dialogue] respond_stream_request",
      JSON.stringify({
        sessionId: sessionId || null,
        revision: Boolean(revision),
        userTextPreview: text.slice(0, 120)
      })
    );

    const result = await streamScenarioReply(
      {
        text,
        sessionId: sessionId || null,
        revision: Boolean(revision),
        expectedVersion,
        expectedEpoch
      },
      {
        signal: abortController.signal,
        onSpeechSegment: async (segment) => {
          if (!responseClosed) {
            writeSseEvent(res, "speech_segment", toSpeechSegmentPayload(segment));
          }
        }
      }
    );

    if (!responseClosed) {
      console.log(
        "[dialogue] respond_stream_done",
        JSON.stringify({
          sessionId: sessionId || null,
          nodeId: result.engineResult?.nodeId || null,
          kind: result.engineResult?.kind || null,
          speechPreview: result.speechContent.slice(0, 160)
        })
      );

      writeSseEvent(res, "done", {
        ok: true,
        content: result.content,
        speechContent: result.speechContent,
        state: result.engineResult.state
      });
    }

    res.end();
    return undefined;
  } catch (error) {
    if (abortController.signal.aborted) {
      res.end();
      return undefined;
    }

    console.error(
      "[dialogue] respond_stream_error",
      JSON.stringify({
        sessionId: sessionId || null,
        message: error.message,
        details: error.details || null
      })
    );

    writeSseEvent(res, "error", {
      ok: false,
      error: "Dialogue answer stream failed"
    });
    res.end();
    return undefined;
  }
}
