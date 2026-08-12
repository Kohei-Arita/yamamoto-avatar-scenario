import crypto from "node:crypto";
import env from "../../config/env.js";
import { createOpenAiCompatibleResponse } from "./adapters/openai-chat-response.js";
import { getLastUserMessage } from "./chat-message.js";
import { bindDebugSession, getDialogueLogs } from "./dialogue-log.store.js";
import { subscribeDialogueEvents } from "./dialogue-events.js";
import {
  answerUserText,
  bindDialogueSession,
  handleChatCompletion,
  streamChatCompletion
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

function isAuthorized(req) {
  if (!env.dialogueEndpointApiKey) {
    return true;
  }

  const authHeader = req.headers.authorization || "";
  return authHeader === `Bearer ${env.dialogueEndpointApiKey}`;
}

export function postBindDialogueSession(req, res) {
  const { sessionId } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "sessionId is required" });
  }

  bindDebugSession(sessionId, { source: "browser_debug_ui" });
  const session = bindDialogueSession(sessionId);
  console.log("[dialogue] bind_session", JSON.stringify({ sessionId }));

  return res.json({ ok: true, sessionId, messageCount: session.messageCount });
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
  subscribeDialogueEvents(sessionId, res);
  console.log("[dialogue] events_subscribed", JSON.stringify({ sessionId: sessionId || null }));
}

export async function postRespondWithDialogue(req, res) {
  const { sessionId, text } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({ ok: false, error: "text is required" });
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
  const { sessionId, text } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({ ok: false, error: "text is required" });
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
        userTextPreview: text.slice(0, 120)
      })
    );

    const result = await streamChatCompletion(
      {
        messages: [{ role: "user", content: text }],
        metadata: sessionId ? { sessionId } : {}
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
        speechContent: result.speechContent
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

export async function postChatCompletions(req, res) {
  if (!isAuthorized(req)) {
    console.warn(
      "[dialogue] chat_completion_unauthorized",
      JSON.stringify({
        authPresent: Boolean(req.headers.authorization),
        sessionId: req.body?.metadata?.sessionId || null
      })
    );

    return res.status(401).json({
      error: {
        message: "Unauthorized",
        type: "invalid_request_error"
      }
    });
  }

  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const userText = getLastUserMessage(messages);

    console.log(
      "[dialogue] chat_completion_request",
      JSON.stringify({
        sessionId: req.body?.metadata?.sessionId || null,
        messageCount: messages.length,
        userTextPreview: userText.slice(0, 120)
      })
    );

    const result = await handleChatCompletion(req.body);

    return res.json(
      createOpenAiCompatibleResponse({
        model: env.openAiModel,
        content: result.content
      })
    );
  } catch (error) {
    console.error(
      "[dialogue] chat_completion_error",
      JSON.stringify({
        sessionId: req.body?.metadata?.sessionId || null,
        message: error.message,
        details: error.details || null
      })
    );

    return res.status(500).json({
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: env.openAiModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "内部エラーが発生しました。もう一度お願いします。"
          },
          finish_reason: "stop"
        }
      ]
    });
  }
}
