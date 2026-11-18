import { normalizeSpeechPronunciation } from "./speech-pronunciation.js";

// paraphraseモードのLLM出力に混入しうる箇条書き・ラベルなどの装飾を落とす安全網。
// fixedモードの固定セリフには影響しない。
function stripDisplayDecorations(content = "") {
  return String(content || "")
    .replace(/^(回答|根拠|注意)\s*[:：]\s*/gmu, "")
    .replace(/^\d+\.\s*/gmu, "")
    .replace(/^-+\s*/gmu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// エコー判定用の原文。既存のAPI/SSEのsubtitleText・subtitleContent形式を維持する。
export function sanitizeSubtitleContent(content = "") {
  return stripDisplayDecorations(content);
}

export function sanitizeSpeechContent(content = "") {
  return normalizeSpeechPronunciation(stripDisplayDecorations(content));
}
