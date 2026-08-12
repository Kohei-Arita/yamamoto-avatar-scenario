import { extractCqIds, getQueryProfile, normalizeText } from "./query-normalizer.js";

const EXPLICIT_FOLLOW_UP_PATTERN =
  /それ|その|前|今の|さっき|この話|この件|同じ|続き|引き続き|追加|補足|もう一度|詳しく|改めて/u;
const GENERIC_REQUEST_PATTERN =
  /ガイドライン|解説|教えて|見て|みて|確認|確認して|お願い|お願いします|一回|くれよ|くれる/u;
const STANDALONE_MEDICAL_ANCHOR_PATTERN =
  /肺がん|肺癌|非小細胞|小細胞|egfr|alk|ros1|kras|braf|met|ret|ntrk|her2|pd-l1|病期|ステージ|喀痰細胞診|予防的全脳照射|仮想気管支鏡|経気管支|ラジアル型ebus|放射線治療|化学療法|免疫療法/u;

function hasStandaloneMedicalAnchor(text = "") {
  if (extractCqIds(text).length > 0) {
    return true;
  }

  const profile = getQueryProfile(text);

  if (profile.matchedCanonicalTerms.some((term) => term !== "診断")) {
    return true;
  }

  return STANDALONE_MEDICAL_ANCHOR_PATTERN.test(normalizeText(text));
}

export function isLikelyFollowUpUtterance(text = "") {
  const currentText = String(text || "").trim();

  if (!currentText) {
    return false;
  }

  const normalized = normalizeText(currentText);

  if (!normalized) {
    return false;
  }

  if (EXPLICIT_FOLLOW_UP_PATTERN.test(normalized)) {
    return true;
  }

  if (hasStandaloneMedicalAnchor(currentText)) {
    return false;
  }

  if (normalized.length < 24) {
    return true;
  }

  return GENERIC_REQUEST_PATTERN.test(normalized);
}

export function buildRetrievalQuery(userText, historyMessages = []) {
  const currentText = String(userText || "").trim();

  if (!isLikelyFollowUpUtterance(currentText)) {
    return currentText;
  }

  const recentContext = historyMessages
    .slice(-4)
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: String(message?.content || "").trim()
    }))
    .filter((message) => {
      if (!message.content) {
        return false;
      }

      if (message.role === "user") {
        return true;
      }

      return hasStandaloneMedicalAnchor(message.content);
    })
    .map((message) => message.content);

  return [...new Set([...recentContext, currentText].filter(Boolean))].join("\n");
}
