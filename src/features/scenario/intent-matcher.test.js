import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIntentClassificationMessages,
  matchIntentByRules,
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

test("「咳が出ます」は has_symptoms にルールマッチする", () => {
  const match = matchIntentByRules("咳が出ます", INTENT_ADVANCES);
  assert.equal(match?.intent, "has_symptoms");
});

test("マッチ数が同点のときは定義順の早いintentを優先する", () => {
  const match = matchIntentByRules("咳はありません", INTENT_ADVANCES);
  assert.equal(match?.intent, "no_symptoms");
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
