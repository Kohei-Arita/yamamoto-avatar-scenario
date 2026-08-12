import env from "../../config/env.js";
import { callUpstreamOpenAi } from "./openai-client.js";

// シナリオに存在しない病期・薬剤名の混入を検知するための禁止語リスト。
// 元のセリフに含まれている語は許可される。
const BANNED_TERMS = [
  "オシメルチニブ",
  "ゲフィチニブ",
  "エルロチニブ",
  "アファチニブ",
  "シスプラチン",
  "カルボプラチン",
  "ペメトレキセド",
  "ドセタキセル",
  "パクリタキセル",
  "ニボルマブ",
  "ペムブロリズマブ",
  "アテゾリズマブ",
  "デュルバルマブ",
  "イピリムマブ",
  "ステージ1",
  "ステージ2",
  "ステージ3",
  "ステージ4",
  "Ⅰ期",
  "Ⅱ期",
  "Ⅲ期",
  "Ⅳ期",
  "余命"
];

function extractNumbers(text = "") {
  return new Set(
    String(text)
      .normalize("NFKC")
      .match(/\d+(?:\.\d+)?/gu) || []
  );
}

export function validateParaphrase(originalText, paraphrasedText) {
  const original = String(originalText || "").normalize("NFKC");
  const paraphrased = String(paraphrasedText || "").normalize("NFKC");

  if (!paraphrased.trim()) {
    return { valid: false, reason: "empty_output" };
  }

  const originalNumbers = extractNumbers(original);

  for (const number of extractNumbers(paraphrased)) {
    if (!originalNumbers.has(number)) {
      return { valid: false, reason: `unknown_number:${number}` };
    }
  }

  for (const term of BANNED_TERMS) {
    if (paraphrased.includes(term) && !original.includes(term)) {
      return { valid: false, reason: `banned_term:${term}` };
    }
  }

  return { valid: true, reason: null };
}

export function buildParaphraseMessages(lines) {
  return [
    {
      role: "system",
      content: [
        "あなたは模擬診療の医師セリフを、意味を変えずに自然な話し言葉に言い換える編集者です。",
        "以下を厳守してください。",
        "- 新しい情報・数値・検査結果・薬剤名・病名・治療推奨を追加しない",
        "- 既存の数値や固有名詞は一字一句変えない",
        "- 文の順序と文の数を保つ",
        "- 医師のやさしく断定しない口調を保つ",
        "- 出力は言い換え後のセリフ本文のみとし、前置きや説明を付けない"
      ].join("\n")
    },
    {
      role: "user",
      content: ["次のセリフを自然に言い換えてください。", "", ...lines].join("\n")
    }
  ];
}

export async function maybeParaphraseLines(lines, { signal } = {}) {
  if (env.scenarioSpeechMode !== "paraphrase" || !env.openAiApiKey) {
    return { text: lines.join("\n"), paraphrased: false, fallbackReason: null };
  }

  const originalText = lines.join("\n");

  try {
    const paraphrasedText = await callUpstreamOpenAi(buildParaphraseMessages(lines), {
      temperature: 0.3,
      signal
    });
    const { valid, reason } = validateParaphrase(originalText, paraphrasedText);

    if (!valid) {
      console.warn("[dialogue] paraphrase_rejected", JSON.stringify({ reason }));
      return { text: originalText, paraphrased: false, fallbackReason: reason };
    }

    return { text: paraphrasedText.trim(), paraphrased: true, fallbackReason: null };
  } catch (error) {
    console.warn(
      "[dialogue] paraphrase_error",
      JSON.stringify({ message: error.message, details: error.details || null })
    );
    return { text: originalText, paraphrased: false, fallbackReason: "llm_error" };
  }
}
