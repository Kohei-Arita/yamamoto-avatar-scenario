// アバター自身の発話が会場スピーカー経由でマイクに回り込み、
// 「患者の発話」として文字起こしされてしまう事故(エコー)を検知するガード。
// 直近にアバターへ送った発話テキストと、入ってきた文字起こしの文字2-gram一致率を比較し、
// ほぼ全体が含まれている場合はエコーとみなす。

const DEFAULT_TTL_MS = 20_000;
const DEFAULT_MIN_LENGTH = 5;
const DEFAULT_CONTAINMENT_THRESHOLD = 0.8;
const MAX_REMEMBERED_ENTRIES = 16;

function normalizeForEchoComparison(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s、。，．・…‥！？!?,.「」『』（）()［\][〜~ー-]/gu, "");
}

function toBigrams(text) {
  const bigrams = new Set();

  for (let index = 0; index < text.length - 1; index += 1) {
    bigrams.add(text.slice(index, index + 2));
  }

  return bigrams;
}

export function createEchoGuard({
  ttlMs = DEFAULT_TTL_MS,
  minLength = DEFAULT_MIN_LENGTH,
  threshold = DEFAULT_CONTAINMENT_THRESHOLD,
  now = () => Date.now()
} = {}) {
  let entries = [];

  function prune() {
    const currentTime = now();
    entries = entries.filter((entry) => entry.expiresAt > currentTime);
  }

  function rememberAvatarSpeech(text) {
    const normalized = normalizeForEchoComparison(text);

    if (!normalized) {
      return;
    }

    prune();

    const existing = entries.find((entry) => entry.text === normalized);

    if (existing) {
      existing.expiresAt = now() + ttlMs;
      return;
    }

    entries.push({ text: normalized, expiresAt: now() + ttlMs });

    while (entries.length > MAX_REMEMBERED_ENTRIES) {
      entries.shift();
    }
  }

  function isLikelyEcho(transcript) {
    const normalized = normalizeForEchoComparison(transcript);

    if (normalized.length < minLength) {
      return false;
    }

    prune();

    if (entries.length === 0) {
      return false;
    }

    const rememberedText = entries.map((entry) => entry.text).join("\n");

    if (rememberedText.includes(normalized)) {
      return true;
    }

    const bigrams = toBigrams(normalized);

    if (bigrams.size === 0) {
      return false;
    }

    let containedCount = 0;

    for (const bigram of bigrams) {
      if (rememberedText.includes(bigram)) {
        containedCount += 1;
      }
    }

    return containedCount / bigrams.size >= threshold;
  }

  function reset() {
    entries = [];
  }

  return {
    rememberAvatarSpeech,
    isLikelyEcho,
    reset
  };
}
