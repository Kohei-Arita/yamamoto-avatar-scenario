import { buildConversationSystemPrompt } from "./prompts/answer-prompt.js";
import {
  normalizeAssistantSurfaceText,
  sanitizeSpeechContent,
  sanitizeSubtitleContent
} from "./speech-content.js";

export function formatSources(chunks) {
  if (!chunks.length) {
    return "出典:\nなし";
  }

  return [
    "出典:",
    ...chunks.map((chunk, index) => {
      const path = [
        `肺癌診療ガイドライン${chunk.version || ""}`,
        chunk.chapter,
        chunk.section,
        chunk.cq || chunk.heading || chunk.title
      ]
        .filter(Boolean)
        .join(" / ");
      const sourceLabel =
        chunk.docType === "souron" ? "総論" : chunk.docType === "meta" ? "メタ情報" : "CQ";

      return `${index + 1}. [${sourceLabel}] ${path}\n   ${chunk.url || ""}`;
    })
  ].join("\n");
}

export function buildNoEvidenceResponse() {
  return "一般的には病状や体の状態で考え方が変わります。気になる点をもう少し具体的に教えてください。";
}

export function buildNoEvidenceFallbackPrompt({ assistantName, assistantPersona }) {
  return [
    buildConversationSystemPrompt({ assistantName, assistantPersona }),
    "",
    "追加ルール:",
    "- 今回は該当するガイドライン断片が検索で見つからなかった",
    "- 返答は、短い相づちや受け止めをひとこと入れてから、答えを先に簡潔に述べる",
    "- ガイドラインに明記がないことは毎回ことわらず、必要なときだけ短く触れる",
    "- 固定の断り文だけで終わらず、一般的な説明や考え方を2〜4文で伝える",
    "- 「今回いただいた情報では」「今いただいている情報では」「この取得結果からは」などのAIっぽい言い回しは禁止",
    "- 『ガイドラインでは明記されていませんが』を定型句にしない",
    "- 患者個別の診断や治療決定はしない",
    "- 一般論として説明する際は、肺がんの病期、組織型、遺伝子変異、治療歴で答えが変わることを必要に応じて短く添える",
    "- 主治医への相談は毎回の締めに入れない",
    "- 次に確認したい情報を聞く場合でも1つだけにする"
  ].join("\n");
}

export function toSpeechContent(content = "") {
  return sanitizeSpeechContent(content);
}

export function toSubtitleContent(content = "") {
  return sanitizeSubtitleContent(content);
}

export function finalizeAssistantTexts(rawContent = "", { fallbackText = "" } = {}) {
  const content = normalizeAssistantSurfaceText(rawContent || fallbackText);

  return {
    content,
    speechContent: toSpeechContent(content)
  };
}
