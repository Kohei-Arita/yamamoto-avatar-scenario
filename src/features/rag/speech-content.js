import { normalizeSpeechPronunciation } from "./speech-pronunciation.js";

const BACKSTAGE_STYLE_RULES = [
  [
    /(今回いただいた情報|今いただいている情報|現時点の情報|現在の情報|今の情報)には含まれていませんが[、,\s]*/gu,
    "、"
  ],
  [
    /(今回いただいた情報|今いただいている情報|現時点の情報|現在の情報|今の情報)にはありませんが[、,\s]*/gu,
    "、"
  ],
  [
    /(?:なお[、,\s]*)?その点についてはガイドライン(?:では|に)明記されていませんが[、,\s]*一般的には/gu,
    "一般的には"
  ],
  [/ガイドライン(?:では|に)明記されていませんが[、,\s]*一般的には/gu, "一般的には"],
  [/今回いただいた情報では[、,\s]*/gu, ""],
  [/今いただいている情報では[、,\s]*/gu, ""],
  [/現時点の情報では[、,\s]*/gu, ""],
  [/現在の情報では[、,\s]*/gu, ""],
  [/今の情報では[、,\s]*/gu, ""],
  [/この取得結果からは[、,\s]*/gu, ""],
  [/取得結果からは[、,\s]*/gu, ""],
  [/情報が足りないため[、,\s]*/gu, ""],
  [/情報が限られているため[、,\s]*/gu, ""]
];

export function normalizeAssistantSurfaceText(content = "") {
  let normalized = String(content || "");

  for (const [pattern, replacement] of BACKSTAGE_STYLE_RULES) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized
    .replace(/(^|[。！？!?]\s*)[、,]\s*/gmu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function stripDisplayDecorations(content = "") {
  return normalizeAssistantSurfaceText(content)
    .replace(/\n+出典:[\s\S]*$/u, "")
    .replace(/^(回答|根拠|注意)\s*[:：]\s*/gmu, "")
    .replace(/^\d+\.\s*/gmu, "")
    .replace(/^-+\s*/gmu, "")
    .trim();
}

export function sanitizeSubtitleContent(content = "") {
  return stripDisplayDecorations(content);
}

export function sanitizeSpeechContent(content = "") {
  return normalizeSpeechPronunciation(stripDisplayDecorations(content));
}
