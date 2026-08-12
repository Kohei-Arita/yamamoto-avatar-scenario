import env from "../../config/env.js";
import { getMessageText } from "./chat-message.js";

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

function supportsTemperature(model) {
  return !/^(o[1-9]|gpt-5)/i.test(String(model || ""));
}

function buildChatCompletionsPayload(messages, { temperature, model, stream = false } = {}) {
  const resolvedModel = model || env.openAiModel;
  const payload = {
    model: resolvedModel,
    messages
  };

  if (stream) {
    payload.stream = true;
  }

  if (supportsTemperature(resolvedModel) && temperature !== undefined) {
    payload.temperature = temperature;
  }

  return payload;
}

function isRetryableError(error) {
  if (error.name === "AbortError") {
    return false;
  }

  if (RETRYABLE_STATUS_CODES.has(error.status)) {
    return true;
  }

  return error.code === "ECONNRESET" || error.code === "ETIMEDOUT";
}

async function withRetry(fn, { maxRetries = MAX_RETRIES, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (signal?.aborted || attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }

      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;

      console.warn(
        "[rag] llm_retry",
        JSON.stringify({ attempt: attempt + 1, delay, error: error.message })
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function buildUpstreamError(message, status, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

async function postChatCompletions(payload, { signal, errorMessage }) {
  const response = await fetch(`${env.openAiApiBaseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.openAiApiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw buildUpstreamError(errorMessage, response.status, data);
  }

  return response;
}

export async function callUpstreamOpenAi(messages, { temperature = 0.2, signal, model } = {}) {
  return withRetry(
    async () => {
      const response = await postChatCompletions(
        buildChatCompletionsPayload(messages, { temperature, model }),
        { signal, errorMessage: "Upstream LLM call failed" }
      );
      const data = await response.json().catch(() => ({}));

      return getMessageText(data?.choices?.[0]?.message?.content);
    },
    { signal }
  );
}

export async function callUpstreamOpenAiStream(
  messages,
  { temperature = 0.2, signal, onContentDelta = () => {}, model } = {}
) {
  const response = await withRetry(
    () =>
      postChatCompletions(buildChatCompletionsPayload(messages, { temperature, model, stream: true }), {
        signal,
        errorMessage: "Upstream LLM stream failed"
      }),
    { signal }
  );

  if (!response.body) {
    throw new Error("Upstream LLM stream body is missing");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r/g, "");

    while (true) {
      const boundary = buffer.indexOf("\n\n");

      if (boundary < 0) {
        break;
      }

      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();

      if (!data) {
        continue;
      }

      if (data === "[DONE]") {
        return content;
      }

      const parsed = JSON.parse(data);
      const delta = getMessageText(parsed?.choices?.[0]?.delta?.content);

      if (!delta) {
        continue;
      }

      content += delta;
      await onContentDelta(delta, content);
    }

    if (done) {
      break;
    }
  }

  return content;
}

export async function generateAssistantContent(
  messages,
  { temperature = 0.2, signal, onContentDelta, model } = {}
) {
  if (typeof onContentDelta === "function") {
    let hasDeliveredDelta = false;

    try {
      return await callUpstreamOpenAiStream(messages, {
        temperature,
        signal,
        onContentDelta: async (delta, content) => {
          hasDeliveredDelta = true;
          await onContentDelta(delta, content);
        },
        model
      });
    } catch (error) {
      if (hasDeliveredDelta) {
        throw error;
      }

      console.warn(
        "[rag] upstream_stream_fallback",
        JSON.stringify({
          message: error.message,
          details: error.details || null,
          model: model || env.openAiModel
        })
      );
    }
  }

  return callUpstreamOpenAi(messages, { temperature, signal, model });
}
