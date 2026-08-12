import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAssistantSurfaceText,
  sanitizeSpeechContent,
  sanitizeSubtitleContent
} from "./speech-content.js";
import { flushSpeechSegment, pullCompletedSpeechSegments } from "./streaming-speech.js";

test("pullCompletedSpeechSegments emits completed sentences and keeps unfinished remainder", () => {
  const result = pullCompletedSpeechSegments(
    "EGFR陽性の肺がんでは、ガイドラインで確認できた範囲では分子標的治療が基本です。副作用も確認します"
  );

  assert.deepEqual(result.segments, [
    {
      speechText:
        "イージーエフアール陽性のはいがんでは、ガイドラインで確認できた範囲ではぶんしひょうてきちりょうが基本です。",
      subtitleText: "EGFR陽性の肺がんでは、ガイドラインで確認できた範囲では分子標的治療が基本です。"
    }
  ]);
  assert.equal(result.remaining, "副作用も確認します");
});

test("pullCompletedSpeechSegments keeps closing quotes with the sentence", () => {
  const result = pullCompletedSpeechSegments("その点は心配ですよね。」次に検査の話をします。");

  assert.deepEqual(result.segments, [
    {
      speechText: "その点は心配ですよね。」",
      subtitleText: "その点は心配ですよね。」"
    },
    {
      speechText: "次に検査の話をします。",
      subtitleText: "次に検査の話をします。"
    }
  ]);
  assert.equal(result.remaining, "");
});

test("flushSpeechSegment removes leading labels and bullet markers", () => {
  assert.deepEqual(flushSpeechSegment("回答: - EGFR陽性なら主治医と相談してください"), {
    speechText: "イージーエフアール陽性ならしゅじいと相談してください",
    subtitleText: "EGFR陽性なら主治医と相談してください"
  });
});

test("normalizeAssistantSurfaceText removes AI backstage phrasing", () => {
  assert.equal(
    normalizeAssistantSurfaceText(
      "今回いただいた情報では、四期の小細胞肺がんについては治療が必要です。"
    ),
    "四期の小細胞肺がんについては治療が必要です。"
  );
  assert.equal(
    normalizeAssistantSurfaceText(
      "この取得結果からは、なお、その点についてはガイドラインでは明記されていませんが、一般的にはそう考えられます。"
    ),
    "一般的にはそう考えられます。"
  );
  assert.equal(
    normalizeAssistantSurfaceText(
      "小細胞肺がんの治療については今回いただいた情報には含まれていませんが、一般的には抗がん剤が中心です。"
    ),
    "小細胞肺がんの治療については、一般的には抗がん剤が中心です。"
  );
  assert.equal(
    normalizeAssistantSurfaceText(
      "この点はガイドラインで個別には触れられていません。治療は病期で変わります。"
    ),
    "この点はガイドラインで個別には触れられていません。治療は病期で変わります。"
  );
});

test("sanitizeSpeechContent also strips AI backstage phrasing", () => {
  assert.equal(
    sanitizeSpeechContent("今回いただいた情報では、EGFR陽性なら分子標的治療が中心です。"),
    "イージーエフアール陽性ならぶんしひょうてきちりょうが中心です。"
  );
});

test("sanitizeSubtitleContent keeps natural kanji while stripping backstage phrasing", () => {
  assert.equal(
    sanitizeSubtitleContent("今回いただいた情報では、EGFR陽性なら分子標的治療が中心です。"),
    "EGFR陽性なら分子標的治療が中心です。"
  );
});
