import crypto from "node:crypto";
import env from "../../config/env.js";
import { createOpenAiCompatibleResponse } from "./adapters/openai-chat-response.js";
import { getLastUserMessage } from "./chat-message.js";
import { initializeConversationSession } from "./conversation.store.js";
import { bindDebugSession, getRagLogs } from "./rag-log.store.js";
import {
  answerUserText,
  handleChatCompletion,
  streamChatCompletion,
  toSpeechContent
} from "./rag.service.js";

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

function isAuthorized(req) {
  if (!env.ragEndpointApiKey) {
    return true;
  }

  const authHeader = req.headers.authorization || "";
  const expected = `Bearer ${env.ragEndpointApiKey}`;
  return authHeader === expected;
}

export function postBindRagSession(req, res) {
  const { sessionId } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "sessionId is required" });
  }

  bindDebugSession(sessionId, { source: "browser_debug_ui" });
  const session = initializeConversationSession(sessionId, {
    openingGreeting: env.liveAvatarOpeningGreeting
  });
  console.log("[rag] bind_session", JSON.stringify({ sessionId }));

  return res.json({ ok: true, sessionId, messageCount: session.messageCount });
}

export function getRagLogsController(req, res) {
  const { sessionId } = req.query;

  return res.json({
    ok: true,
    logs: getRagLogs(sessionId)
  });
}

export async function postRespondWithRag(req, res) {
  const { sessionId, text } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({ ok: false, error: "text is required" });
  }

  try {
    console.log(
      "[rag] respond_request",
      JSON.stringify({
        sessionId: sessionId || null,
        userTextPreview: text.slice(0, 120)
      })
    );

    const result = await answerUserText(text, sessionId || null);
    const speechContent = result.speechContent || toSpeechContent(result.content);

    console.log(
      "[rag] respond_response",
      JSON.stringify({
        sessionId: sessionId || null,
        speechPreview: speechContent.slice(0, 160)
      })
    );

    return res.json({
      ok: true,
      content: result.content,
      speechContent
    });
  } catch (error) {
    console.error(
      "[rag] respond_error",
      JSON.stringify({
        sessionId: sessionId || null,
        message: error.message,
        details: error.details || null
      })
    );

    return res.status(500).json({
      ok: false,
      error: "RAG answer generation failed"
    });
  }
}

export async function postRespondWithRagStream(req, res) {
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

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  try {
    console.log(
      "[rag] respond_stream_request",
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
        "[rag] respond_stream_done",
        JSON.stringify({
          sessionId: sessionId || null,
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
      "[rag] respond_stream_error",
      JSON.stringify({
        sessionId: sessionId || null,
        message: error.message,
        details: error.details || null
      })
    );

    writeSseEvent(res, "error", {
      ok: false,
      error: "RAG answer stream failed"
    });
    res.end();
    return undefined;
  }
}

export async function postChatCompletions(req, res) {
  if (!isAuthorized(req)) {
    console.warn(
      "[rag] chat_completion_unauthorized",
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
      "[rag] chat_completion_request",
      JSON.stringify({
        sessionId: req.body?.metadata?.sessionId || null,
        authPresent: Boolean(req.headers.authorization),
        messageCount: messages.length,
        userTextPreview: userText.slice(0, 120)
      })
    );

    const result = await handleChatCompletion(req.body);

    console.log(
      "[rag] chat_completion_response",
      JSON.stringify({
        sessionId: req.body?.metadata?.sessionId || null,
        contentPreview: result.content.slice(0, 160)
      })
    );

    return res.json(
      createOpenAiCompatibleResponse({
        model: env.openAiModel,
        content: result.content
      })
    );
  } catch (error) {
    console.error(
      "[rag] chat_completion_error",
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
            content: "内部エラーが発生しました。ガイドライン根拠付き回答を生成できませんでした。"
          },
          finish_reason: "stop"
        }
      ]
    });
  }
}
