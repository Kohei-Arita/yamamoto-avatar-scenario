import env from "../../config/env.js";
import { callUpstreamOpenAi } from "../dialogue/openai-client.js";

export const OFF_SCRIPT = "OFF_SCRIPT";

function normalizeForMatching(text = "") {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .trim();
}

export function matchIntentByRules(text, intentAdvances = []) {
  const normalized = normalizeForMatching(text);

  if (!normalized) {
    return null;
  }

  let best = null;

  for (const [index, advance] of intentAdvances.entries()) {
    const keywords = Array.isArray(advance.keywords) ? advance.keywords : [];
    const matchedKeywords = keywords.filter((keyword) =>
      normalized.includes(normalizeForMatching(keyword))
    );

    if (matchedKeywords.length === 0) {
      continue;
    }

    // 同点なら定義順の早いadvanceを優先する
    if (!best || matchedKeywords.length > best.matchedKeywords.length) {
      best = { advance, matchedKeywords, index };
    }
  }

  if (!best) {
    return null;
  }

  return {
    intent: best.advance.intent,
    next: best.advance.next,
    matchedKeywords: best.matchedKeywords,
    method: "rule"
  };
}

function extractJsonObject(text = "") {
  const trimmed = String(text || "").trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);

  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

export function buildIntentClassificationMessages(text, intentAdvances, { doctorLine = "" } = {}) {
  const options = intentAdvances.map((advance) => ({
    intent: advance.intent,
    keywords: Array.isArray(advance.keywords) ? advance.keywords : []
  }));

  return [
    {
      role: "system",
      content: [
        "あなたは模擬診療シナリオの進行を助ける発話分類器です。",
        "役割は、患者の発話が以下の選択肢のどれに最も近いかを判定することだけです。",
        "回答文の生成は禁止です。医学的な助言も禁止です。",
        `どの選択肢にも当てはまらない場合は "${OFF_SCRIPT}" と答えてください。`,
        '出力は JSON のみとし、形式は {"intent":"..."} に厳密に従ってください。'
      ].join("\n")
    },
    {
      role: "user",
      content: [
        doctorLine ? `直前の医師の発話:\n${doctorLine}` : "",
        `患者の発話:\n${String(text || "").trim()}`,
        "",
        "選択肢:",
        ...options.map(
          (option) =>
            `- ${option.intent}${option.keywords.length > 0 ? `（例: ${option.keywords.join("、")}）` : ""}`
        ),
        `- ${OFF_SCRIPT}（上記のどれにも当てはまらない）`,
        "",
        "JSON のみを返してください。"
      ]
        .filter((line) => line !== "")
        .join("\n")
    }
  ];
}

export function parseIntentClassificationResponse(content, intentAdvances) {
  try {
    const parsed = JSON.parse(extractJsonObject(content));
    const intent = String(parsed?.intent || "").trim();
    const matched = intentAdvances.find((advance) => advance.intent === intent);

    if (matched) {
      return {
        intent: matched.intent,
        next: matched.next,
        matchedKeywords: [],
        method: "llm"
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function classifyIntentWithLlm(text, intentAdvances, { doctorLine, signal } = {}) {
  const content = await callUpstreamOpenAi(
    buildIntentClassificationMessages(text, intentAdvances, { doctorLine }),
    { temperature: 0, signal }
  );

  return parseIntentClassificationResponse(content, intentAdvances);
}

export async function matchIntent(text, intentAdvances, { doctorLine, signal } = {}) {
  const ruleMatch = matchIntentByRules(text, intentAdvances);

  if (ruleMatch) {
    return ruleMatch;
  }

  if (!env.scenarioIntentLlm || !env.openAiApiKey) {
    return null;
  }

  try {
    return await classifyIntentWithLlm(text, intentAdvances, { doctorLine, signal });
  } catch (error) {
    console.warn(
      "[scenario] intent_llm_error",
      JSON.stringify({ message: error.message, details: error.details || null })
    );
    return null;
  }
}
