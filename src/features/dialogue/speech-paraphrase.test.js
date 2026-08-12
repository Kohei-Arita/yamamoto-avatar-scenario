import test from "node:test";
import assert from "node:assert/strict";
import env from "../../config/env.js";
import { maybeParaphraseLines, validateParaphrase } from "./speech-paraphrase.js";

test("元セリフに存在しない数値の混入を検知する", () => {
  const result = validateParaphrase(
    "右下葉に約40ミリの影があります。",
    "右下葉に約45ミリの影が見つかっています。"
  );
  assert.equal(result.valid, false);
  assert.match(result.reason, /unknown_number:45/u);
});

test("元セリフに存在する数値はそのまま許可される", () => {
  const result = validateParaphrase(
    "右下葉に約40ミリの影があります。",
    "右の肺の下のほうに、40ミリほどの影がございます。"
  );
  assert.equal(result.valid, true);
});

test("症例に存在しない薬剤名の混入を検知する", () => {
  const result = validateParaphrase(
    "お薬の治療にはいくつかの種類があります。",
    "オシメルチニブというお薬による治療が考えられます。"
  );
  assert.equal(result.valid, false);
  assert.match(result.reason, /banned_term:オシメルチニブ/u);
});

test("空出力を拒否する", () => {
  assert.equal(validateParaphrase("こんにちは。", "").valid, false);
});

test("fixedモードでは言い換えせず固定文をそのまま返す", async () => {
  const originalMode = env.scenarioSpeechMode;
  env.scenarioSpeechMode = "fixed";

  try {
    const result = await maybeParaphraseLines(["こんにちは。", "よろしくお願いします。"]);
    assert.equal(result.paraphrased, false);
    assert.equal(result.text, "こんにちは。\nよろしくお願いします。");
  } finally {
    env.scenarioSpeechMode = originalMode;
  }
});

test("paraphraseモードで禁止語チェック不合格ならfixedへフォールバックする", async () => {
  const originalMode = env.scenarioSpeechMode;
  const originalKey = env.openAiApiKey;
  const originalFetch = globalThis.fetch;

  env.scenarioSpeechMode = "paraphrase";
  env.openAiApiKey = "test-key";
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: "オシメルチニブをおすすめします。"
            }
          }
        ]
      };
    }
  });

  try {
    const lines = ["お薬の治療にはいくつかの種類があります。"];
    const result = await maybeParaphraseLines(lines);
    assert.equal(result.paraphrased, false);
    assert.equal(result.text, lines[0]);
    assert.match(result.fallbackReason, /banned_term/u);
  } finally {
    env.scenarioSpeechMode = originalMode;
    env.openAiApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});
