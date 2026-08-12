import { isLikelyFollowUpUtterance } from "./follow-up-context.js";
import { extractCqIds, getQueryProfile, normalizeText } from "./query-normalizer.js";

const NON_RAG_PATTERNS = [
  "こんにちは",
  "ありがとう",
  "もう一度",
  "聞こえますか",
  "はじめまして",
  "hello",
  "hi",
  "マイク",
  "音が出ない",
  "接続",
  "start session",
  "stop session",
  "liveavatar",
  "livekit"
];

const FORCED_RAG_TERMS = new Set([
  "肺がん",
  "肺がん治療",
  "非小細胞肺癌",
  "小細胞肺癌",
  "egfr",
  "alk",
  "ros1",
  "kras",
  "braf",
  "met",
  "ret",
  "ntrk",
  "her2",
  "pd-l1",
  "病期",
  "術後補助療法",
  "術前治療",
  "免疫療法",
  "化学療法",
  "予防的全脳照射",
  "分子標的治療",
  "放射線治療",
  "外科治療",
  "緩和ケア",
  "支持療法",
  "診断",
  "経気管支生検",
  "ラジアル型EBUS",
  "コンベックス型EBUS-TBNA",
  "仮想気管支鏡ナビゲーション",
  "一次治療"
]);

function buildRoutingText(userText, historyMessages = []) {
  const recentMessages = historyMessages
    .slice(-4)
    .map((message) => String(message?.content || "").trim())
    .filter(Boolean);

  return [...recentMessages, String(userText || "").trim()].filter(Boolean).join(" ");
}

function evaluateMedicalSignals(text) {
  const normalized = normalizeText(text);
  const profile = getQueryProfile(text);
  const hasCqId = extractCqIds(text).length > 0;
  const forcedTerm = profile.matchedCanonicalTerms.find((term) => FORCED_RAG_TERMS.has(term));
  const hasLungContext = normalized.includes("肺がん") || normalized.includes("肺癌");
  const hasMedicalIntent =
    /診断|治療|病期|ステージ|推奨|ガイドライン|副作用|再発|転移|方針|概要|流れ|考え方|緩和ケア/u.test(
      normalized
    );

  return {
    normalized,
    hasCqId,
    forcedTerm,
    hasLungContext,
    hasMedicalIntent
  };
}

export function decideNeedRag(userText, { historyMessages = [] } = {}) {
  const text = (userText || "").trim();

  if (!text) {
    return { needsRag: false, reason: "empty" };
  }

  const currentSignals = evaluateMedicalSignals(text);

  if (currentSignals.hasCqId) {
    return { needsRag: true, reason: "cq_reference" };
  }

  if (currentSignals.forcedTerm) {
    return { needsRag: true, reason: `forced_keyword:${currentSignals.forcedTerm}` };
  }

  if (currentSignals.hasLungContext && currentSignals.hasMedicalIntent) {
    return { needsRag: true, reason: "lung_context_with_medical_intent" };
  }

  if (NON_RAG_PATTERNS.some((word) => currentSignals.normalized.includes(normalizeText(word)))) {
    return { needsRag: false, reason: "smalltalk_or_control" };
  }

  const isFollowUpUtterance = isLikelyFollowUpUtterance(text);

  if (isFollowUpUtterance && historyMessages.length > 0) {
    const contextualSignals = evaluateMedicalSignals(buildRoutingText(text, historyMessages));

    if (contextualSignals.hasCqId) {
      return { needsRag: true, reason: "contextual_cq_reference" };
    }

    if (contextualSignals.forcedTerm) {
      return {
        needsRag: true,
        reason: `contextual_forced_keyword:${contextualSignals.forcedTerm}`
      };
    }

    if (contextualSignals.hasLungContext && contextualSignals.hasMedicalIntent) {
      return { needsRag: true, reason: "contextual_lung_context_with_medical_intent" };
    }
  }

  return { needsRag: false, reason: "general_conversation" };
}
