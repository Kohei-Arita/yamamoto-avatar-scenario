import env from "../../config/env.js";
import { callUpstreamOpenAi } from "../dialogue/openai-client.js";

export const OFF_SCRIPT = "OFF_SCRIPT";

function normalizeForMatching(text = "") {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .trim();
}

// 合図や短い否定の返答は文全体で照合する。疑問符は残し、
// 「提示しますか？」を「提示します」の合図として受理しない。
function normalizeExactPhrase(text) {
  return normalizeForMatching(text)
    .replace(/[\s、,]/gu, "")
    .replace(/[。.!！]+$/u, "");
}

const NEGATION = /ない|なく|ありません|ません|なし|無い|不要|違います/u;
// 症状の否定ではなく「症状が続く」意味や二重否定は、ルールで反転させず分類器へ。
const COMPLEX_NEGATION =
  /止ま(?:らない|りません)|治(?:らない|りません)|(?:下が|減|良くな|よくな)(?:らない|りません)|ないわけ|ないとは|なくは|ないこと|なくない|ませんか|ないですか|ではなく|じゃなく/u;
const CLAUSE_BOUNDARY =
  /[、,。！？!?\n]|けれども?|けど|ですが|ただ(?:し)?|しかし|でも|(?<=ない|ません|です|ます)が/u;

function hasAffirmedKeyword(text, keyword) {
  // 「咳も痰もありません」のような列挙全体への否定も見る。
  // 否定語自体が選択肢のキーワードなら、その一致は保持する。
  const word = normalizeForMatching(keyword);
  if (!word) return false;
  return text.split(CLAUSE_BOUNDARY).some((clause) => {
    let index = clause.indexOf(word);
    while (index >= 0) {
      if (NEGATION.test(word) || !NEGATION.test(clause.slice(index + word.length))) return true;
      index = clause.indexOf(word, index + word.length);
    }
    return false;
  });
}

export function matchIntentByRules(text, intentAdvances = []) {
  const normalized = normalizeForMatching(text);

  if (!normalized) {
    return null;
  }

  const candidates = [];

  for (const advance of intentAdvances) {
    const keywords = Array.isArray(advance.keywords) ? advance.keywords : [];
    const matchedKeywords = keywords.filter((keyword) =>
      advance.matchMode === "exact"
        ? normalizeExactPhrase(normalized) === normalizeExactPhrase(keyword)
        : !COMPLEX_NEGATION.test(normalized) && hasAffirmedKeyword(normalized, keyword)
    );

    if (matchedKeywords.length === 0) {
      continue;
    }

    candidates.push({ advance, matchedKeywords });
  }

  // 複数の意図を含む言い直しは単語の個数で決めず、文全体の分類へ回す。
  if (candidates.length !== 1) {
    return null;
  }
  const [best] = candidates;

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
        "単語の一致より文全体の意味を優先し、否定・訂正・逆接の後の内容を考慮してください。",
        "否定された行動を実行の合図と解釈しないでください。保留・中止の希望はOFF_SCRIPTです。",
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

export async function matchIntent(
  text,
  intentAdvances,
  { doctorLine, signal, allowLlm = true } = {}
) {
  const ruleMatch = matchIntentByRules(text, intentAdvances);

  if (ruleMatch) {
    return ruleMatch;
  }

  if (!allowLlm || !env.scenarioIntentLlm || !env.openAiApiKey) {
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
