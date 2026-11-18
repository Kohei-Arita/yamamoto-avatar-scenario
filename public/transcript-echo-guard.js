// アバター自身の発話が会場スピーカー経由でマイクに回り込み、
// 「患者の発話」として文字起こしされてしまう事故(エコー)を検知するガード。
// 直近にアバターへ送った発話テキストと、入ってきた文字起こしの文字2-gram一致率を比較し、
// ほぼ全体が含まれている場合はエコーとみなす。

const DEFAULT_TTL_MS = 20_000;
// 短い返答や質問中の選択肢の復唱は、文字列だけではエコーと区別できない。
const DEFAULT_MIN_LENGTH = 12;
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
    rememberSentence(text);
    // 複数の文の単語を寄せ集めて、患者の新しい返答をエコー扱いしない。
    for (const sentence of String(text || "").split(/[。！？!?\n]/u)) {
      rememberSentence(sentence);
    }
  }

  function rememberSentence(text) {
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

    if (
      normalized.length < minLength ||
      /^(?:はい|ええ|こちらこそ)*よろしくお願い(?:します|いたします)$/u.test(normalized)
    ) {
      return false;
    }

    prune();

    if (entries.length === 0) {
      return false;
    }

    const bigrams = toBigrams(normalized);

    if (bigrams.size === 0) {
      return false;
    }

    return entries.some(({ text }) => {
      const sourceBigrams = toBigrams(text);
      const shared = [...bigrams].filter((bigram) => sourceBigrams.has(bigram)).length;
      // 質問の一部を答えただけなら通す。文全体が双方で似ている場合に限って除外する。
      return shared / bigrams.size >= threshold && shared / sourceBigrams.size >= threshold;
    });
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
