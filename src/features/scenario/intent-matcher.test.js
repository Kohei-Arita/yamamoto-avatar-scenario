import test from "node:test";
import assert from "node:assert/strict";
import env from "../../config/env.js";
import {
  buildIntentClassificationMessages,
  matchIntentByRules,
  matchIntent,
  parseIntentClassificationResponse
} from "./intent-matcher.js";

const INTENT_ADVANCES = [
  {
    type: "patient_intent",
    intent: "no_symptoms",
    keywords: ["ない", "ありません", "特に"],
    next: "s1_adl"
  },
  {
    type: "patient_intent",
    intent: "has_symptoms",
    keywords: ["咳", "痰", "血", "痛", "熱"],
    next: "s1_symptoms_redirect"
  }
];

test("「特にありません」は no_symptoms にルールマッチする", () => {
  const match = matchIntentByRules("特にありません", INTENT_ADVANCES);
  assert.equal(match?.intent, "no_symptoms");
  assert.equal(match?.next, "s1_adl");
  assert.equal(match?.method, "rule");
});

test("完全一致のキーワードは否定や疑問文の一部だけでは一致しない", () => {
  const advances = [
    {
      intent: "present_imaging",
      matchMode: "exact",
      keywords: ["PET画像を提示します"],
      next: "imaging"
    }
  ];
  assert.equal(
    matchIntentByRules(" ＰＥＴ画像を提示します。", advances)?.intent,
    "present_imaging"
  );
  for (const text of [
    "画像はまだ準備中です",
    "PET画像を提示しますか？",
    "PET画像を提示しません",
    "PET画像を提示しますという合図です"
  ]) {
    assert.equal(matchIntentByRules(text, advances), null, text);
  }
});

test("合図のルール限定照合はLLMが有効でも外部分類を呼ばない", async (t) => {
  const original = { enabled: env.scenarioIntentLlm, key: env.openAiApiKey };
  env.scenarioIntentLlm = true;
  env.openAiApiKey = "test-key";
  const fetch = t.mock.method(globalThis, "fetch", () => {
    throw new Error("LLM must not be called");
  });
  try {
    const result = await matchIntent(
      "画像はまだ準備中です",
      [
        {
          intent: "present_imaging",
          matchMode: "exact",
          keywords: ["PET画像を提示します"],
          next: "imaging"
        }
      ],
      { allowLlm: false }
    );
    assert.equal(result, null);
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    env.scenarioIntentLlm = original.enabled;
    env.openAiApiKey = original.key;
  }
});

test("「咳が出ます」は has_symptoms にルールマッチする", () => {
  const match = matchIntentByRules("咳が出ます", INTENT_ADVANCES);
  assert.equal(match?.intent, "has_symptoms");
});

test("症状語を否定した返答は、症状ありに分類しない", () => {
  const match = matchIntentByRules("咳はありません", INTENT_ADVANCES);
  assert.equal(match?.intent, "no_symptoms");
  assert.equal(matchIntentByRules("咳も痰もありません", INTENT_ADVANCES)?.intent, "no_symptoms");
});

test("否定後の追加症状や複数候補は、キーワードの個数で即決しない", () => {
  assert.equal(matchIntentByRules("特にないんですけど、咳が出ます", INTENT_ADVANCES), null);
  assert.equal(matchIntentByRules("咳はありませんが、熱があります", INTENT_ADVANCES), null);
  for (const text of ["咳が止まらない", "熱が下がらない", "咳がないわけではない"]) {
    assert.equal(matchIntentByRules(text, INTENT_ADVANCES), null, text);
  }
});

test("否定された操作合図はルールで進めない", () => {
  const advances = [{ intent: "present_imaging", keywords: ["画像", "提示"], next: "imaging" }];
  assert.equal(matchIntentByRules("まだ画像を提示しないでください", advances), null);
  assert.equal(matchIntentByRules("画像を提示します", advances)?.intent, "present_imaging");
});

test("選択肢外の発話はルール層でnullを返す", () => {
  assert.equal(matchIntentByRules("今日はいい天気ですね", INTENT_ADVANCES), null);
});

test("LLM分類プロンプトは選択肢とOFF_SCRIPTを含み、JSON出力を強制する", () => {
  const messages = buildIntentClassificationMessages("咳が出ます", INTENT_ADVANCES, {
    doctorLine: "症状はありますか。"
  });

  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /OFF_SCRIPT/u);
  assert.match(messages[0].content, /\{"intent":"\.\.\."\}/u);
  assert.match(messages[1].content, /no_symptoms/u);
  assert.match(messages[1].content, /has_symptoms/u);
});

test("LLM応答のintentが選択肢内なら採用し、OFF_SCRIPT・選択肢外はnull(逸脱扱い)", () => {
  const accepted = parseIntentClassificationResponse('{"intent":"has_symptoms"}', INTENT_ADVANCES);
  assert.equal(accepted?.intent, "has_symptoms");
  assert.equal(accepted?.method, "llm");

  assert.equal(parseIntentClassificationResponse('{"intent":"OFF_SCRIPT"}', INTENT_ADVANCES), null);
  assert.equal(parseIntentClassificationResponse('{"intent":"unknown"}', INTENT_ADVANCES), null);
  assert.equal(parseIntentClassificationResponse("壊れた出力", INTENT_ADVANCES), null);
});
