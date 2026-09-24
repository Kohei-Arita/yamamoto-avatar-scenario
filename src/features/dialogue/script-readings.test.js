import test from "node:test";
import assert from "node:assert/strict";
import { loadScenarioFromFile } from "../scenario/scenario-loader.js";
import { sanitizeSpeechContent, sanitizeSubtitleContent } from "./speech-content.js";

const scenario = loadScenarioFromFile("./data/scenarios/haigan-2026.json");
const spokenLines = [
  ...Object.values(scenario.globalDeviationReplies),
  ...scenario.nodes.flatMap((node) => node.doctorLines)
];

test("台本の全セリフが読み上げ時には漢字・数字・英字を含まない", () => {
  for (const line of spokenLines) {
    for (const sentence of line.match(/[^。！？!?]+[。！？!?]?/gu)) {
      const speech = sanitizeSpeechContent(sentence);
      assert.doesNotMatch(
        speech,
        /[\p{Script=Han}0-9A-Za-z#]/u,
        `読み未登録: ${sentence} → ${speech}`
      );
    }
  }
});

test("字幕は漢字の台本のまま", () => {
  const line = "こんにちは。山本です。本日はよろしくお願いします。";
  assert.equal(sanitizeSubtitleContent(line), line);
  assert.equal(
    sanitizeSpeechContent(line),
    "こんにちは。やまもとです。ほんじつはよろしくおねがいします。"
  );
});
