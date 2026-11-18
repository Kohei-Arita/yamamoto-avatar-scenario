import assert from "node:assert/strict";
import test from "node:test";
import env from "../../config/env.js";
import { callUpstreamOpenAi } from "./openai-client.js";

test("LLMが無応答でも制限時間で終了し、会話を待たせ続けない", async (t) => {
  const previousTimeout = env.dialogueLlmTimeoutMs;
  env.dialogueLlmTimeoutMs = 20;
  t.after(() => {
    env.dialogueLlmTimeoutMs = previousTimeout;
  });
  // AbortSignal.timeout自体はイベントループを保持しないため、待機中の接続を模擬する。
  const connection = setInterval(() => {}, 1000);
  t.after(() => clearInterval(connection));
  t.mock.method(
    globalThis,
    "fetch",
    async (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
  );
  await assert.rejects(callUpstreamOpenAi([]), { name: "TimeoutError" });
});
