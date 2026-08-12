import test from "node:test";
import assert from "node:assert/strict";
import { buildDeviationLines, classifyDeviation } from "./deviation-handler.js";

test("予後の断定要求は medical_advice に分類される", () => {
  assert.equal(classifyDeviation("あと何年生きられますか"), "medical_advice");
  assert.equal(classifyDeviation("余命を教えてください"), "medical_advice");
  assert.equal(classifyDeviation("治療の費用はいくらかかりますか"), "medical_advice");
});

test("薬剤選択・投与量・未承認治療の質問も medical_advice に分類される", () => {
  assert.equal(classifyDeviation("どの薬を使うんですか"), "medical_advice");
  assert.equal(classifyDeviation("投与量はどれくらいですか"), "medical_advice");
  assert.equal(classifyDeviation("未承認の治療は受けられますか"), "medical_advice");
});

test("症例設定と矛盾する発言は case_conflict に分類される", () => {
  assert.equal(classifyDeviation("昔、肺の手術を受けたことがあります"), "case_conflict");
});

test("雑談は off_topic、空発話は unclear に分類される", () => {
  assert.equal(classifyDeviation("今日はいい天気ですね"), "off_topic");
  assert.equal(classifyDeviation(""), "unclear");
  assert.equal(classifyDeviation("あ"), "unclear");
});

test("medical_advice の応答は定型文の後に現在ノードの質問を再提示する", () => {
  const node = {
    id: "s1_symptoms",
    doctorLines: ["現在、咳、痰、血痰、息切れ、胸の痛み、発熱、体重減少などはありますか。"]
  };
  const scenario = {
    globalDeviationReplies: {
      medical_advice: "詳しくは専門のチームで検討し、あらためてご説明しますね。"
    }
  };

  const lines = buildDeviationLines("medical_advice", node, scenario);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], scenario.globalDeviationReplies.medical_advice);
  assert.equal(lines[1], node.doctorLines[0]);
});

test("unclear は聞き返しのみで質問を再提示しない", () => {
  const node = { id: "s1_symptoms", doctorLines: ["症状はありますか。"] };
  const lines = buildDeviationLines("unclear", node, {});
  assert.equal(lines.length, 1);
});

test("ノード個別のonDeviationがグローバル定型文を上書きする", () => {
  const node = {
    id: "s1_voting1_wait",
    doctorLines: ["会場に伺います。"],
    onDeviation: { off_topic: "このあとすぐ続けますね。" }
  };
  const lines = buildDeviationLines("off_topic", node, {
    globalDeviationReplies: { off_topic: "そうなんですね。" }
  });
  assert.equal(lines[0], "このあとすぐ続けますね。");
});
