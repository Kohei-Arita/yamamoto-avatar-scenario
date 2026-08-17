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

export function sanitizeSubtitleContent(content = "") {
  return stripDisplayDecorations(content);
}

export function sanitizeSpeechContent(content = "") {
  return normalizeSpeechPronunciation(stripDisplayDecorations(content));
}
