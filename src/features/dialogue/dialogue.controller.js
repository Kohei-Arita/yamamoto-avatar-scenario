import { appendDialogueLog, getDialogueLogs } from "./dialogue-log.store.js";
import { broadcastScenarioState, subscribeDialogueEvents } from "./dialogue-events.js";
import { isAllowedDialogueSession, isRegisteredSessionId } from "./session-registry.js";
import { getScenarioEngine } from "../scenario/scenario-engine.js";
import {
  answerUserText,
  bindDialogueSession,
  streamScenarioReply,
  toSpeechSegments
} from "./dialogue.service.js";

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function toSpeechSegmentPayload(segment) {
  if (typeof segment === "string") {
    return {
      text: segment,
      speechText: segment,
      subtitleText: segment
    };
  }

  return {
    state: segment?.state,
    text: segment?.speechText || "",
    speechText: segment?.speechText || "",
    subtitleText: segment?.subtitleText || segment?.speechText || ""
  };
}

function setSseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

// LiveAvatarセッションを発行済みのサーバーでは、未知のsessionIdからの
// 対話リクエストを拒否する(公開URLへの野良リクエスト対策)。
function rejectUnknownSession(req, res) {
  const sessionId = req.body?.sessionId || null;

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
  const { sessionId, expectedVersion } = req.body || {};
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
  if (current.version !== expectedVersion) {
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

export function getDialogueEventsController(req, res) {
  const { sessionId } = req.query;

  setSseHeaders(res);
  const engine = getScenarioEngine();
  subscribeDialogueEvents(
    sessionId,
    res,
    engine.getInputState(sessionId),
    toSpeechSegments(engine.getNodeLines(sessionId).lines.join("\n"))
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
  const { sessionId, text, revision, expectedVersion } = req.body || {};

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
        expectedVersion
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
