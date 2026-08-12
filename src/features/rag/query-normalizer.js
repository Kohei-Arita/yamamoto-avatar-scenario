const SYNONYM_GROUPS = [
  {
    canonical: "肺がん",
    variants: ["肺がん", "肺癌", "lung cancer", "lung carcinoma"],
    tagTerms: ["lung-cancer"]
  },
  {
    canonical: "肺がん治療",
    variants: ["肺がん治療", "肺癌治療", "肺がんの治療", "肺癌の治療"],
    pattern: /肺(?:がん|癌)(?:の)?治療/u,
    queryTerms: [
      "薬物療法",
      "手術",
      "外科治療",
      "放射線治療",
      "術前治療",
      "術後補助療法",
      "治療方針",
      "分子標的治療",
      "免疫療法",
      "化学療法"
    ],
    tagTerms: ["nsclc", "sclc", "systemic-therapy", "surgery", "radiation", "perioperative"]
  },
  {
    canonical: "非小細胞肺癌",
    variants: ["非小細胞肺癌", "非小細胞肺がん", "nsclc"],
    pattern: /非小細胞肺癌|非小細胞肺がん|nsclc/u,
    tagTerms: ["nsclc"]
  },
  {
    canonical: "小細胞肺癌",
    variants: ["小細胞肺癌", "小細胞肺がん", "sclc"],
    pattern: /(?<!非)小細胞肺癌|(?<!非)小細胞肺がん|sclc/u,
    tagTerms: ["sclc"]
  },
  { canonical: "egfr", variants: ["egfr", "egfr変異", "上皮成長因子受容体"], tagTerms: ["egfr"] },
  { canonical: "alk", variants: ["alk", "alk融合"], tagTerms: ["alk"] },
  { canonical: "ros1", variants: ["ros1", "ros-1"], tagTerms: ["ros1"] },
  { canonical: "kras", variants: ["kras", "kras変異"], tagTerms: ["kras"] },
  { canonical: "braf", variants: ["braf", "braf変異"], tagTerms: ["braf"] },
  {
    canonical: "met",
    variants: ["met", "met exon14", "met exon 14", "met exon14 skipping"],
    tagTerms: ["met"]
  },
  { canonical: "ret", variants: ["ret", "ret融合"], tagTerms: ["ret"] },
  { canonical: "ntrk", variants: ["ntrk", "trk融合"], tagTerms: ["ntrk"] },
  { canonical: "her2", variants: ["her2", "erbb2"], tagTerms: ["her2"] },
  { canonical: "pd-l1", variants: ["pd-l1", "pdl1", "pd l1"], tagTerms: ["pd-l1"] },
  { canonical: "病期", variants: ["病期", "ステージ", "stage", "clinical stage", "cstage"] },
  {
    canonical: "術後補助療法",
    variants: ["術後補助療法", "アジュバント", "adjuvant"],
    tagTerms: ["perioperative"]
  },
  {
    canonical: "術前治療",
    variants: ["術前治療", "ネオアジュバント", "neoadjuvant"],
    tagTerms: ["perioperative"]
  },
  {
    canonical: "免疫療法",
    variants: ["免疫療法", "免疫チェックポイント"],
    tagTerms: ["systemic-therapy"]
  },
  {
    canonical: "化学療法",
    variants: ["化学療法", "抗がん剤", "細胞障害性抗癌剤"],
    tagTerms: ["systemic-therapy"]
  },
  {
    canonical: "予防的全脳照射",
    variants: [
      "予防的全脳照射",
      "予防的頭蓋内照射",
      "pci",
      "p c i",
      "ピーシーアイ",
      "ぴーしーあい",
      "prophylactic cranial irradiation"
    ],
    tagTerms: ["radiation", "sclc"]
  },
  {
    canonical: "分子標的治療",
    variants: ["分子標的治療", "分子標的療法", "分子標的"],
    tagTerms: ["systemic-therapy"]
  },
  { canonical: "放射線治療", variants: ["放射線治療", "照射"], tagTerms: ["radiation"] },
  { canonical: "外科治療", variants: ["外科治療", "手術"], tagTerms: ["surgery"] },
  { canonical: "緩和ケア", variants: ["緩和ケア", "支持療法", "best supportive care"] },
  {
    canonical: "診断",
    variants: ["診断", "検出", "病理", "生検", "分子診断", "細胞診", "喀痰細胞診"],
    tagTerms: ["diagnosis"]
  },
  {
    canonical: "経気管支生検",
    variants: ["経気管支生検", "気管支生検", "bronchoscopic biopsy"],
    tagTerms: ["diagnosis"]
  },
  {
    canonical: "ラジアル型EBUS",
    variants: ["ラジアル型ebus", "ラジアルebus", "radial ebus"],
    tagTerms: ["diagnosis"]
  },
  {
    canonical: "コンベックス型EBUS-TBNA",
    variants: [
      "コンベックス型ebus-tbna",
      "コンベックス型ebustbna",
      "コンベックスebus-tbna",
      "ebus-tbna",
      "convex probe ebus-tbna"
    ],
    tagTerms: ["diagnosis"]
  },
  {
    canonical: "仮想気管支鏡ナビゲーション",
    variants: [
      "仮想気管支鏡ナビゲーション",
      "仮想気管支鏡",
      "vbn",
      "virtual bronchoscopic navigation"
    ],
    tagTerms: ["diagnosis"]
  },
  { canonical: "一次治療", variants: ["一次治療", "初回治療", "first line", "1st line"] }
];

const QUERY_TERM_SPLIT_PATTERNS = [
  /を対象とした|を対象にした|を対象とする/gu,
  /について|に対して|として|とは|では|での|など/gu,
  /ですか|ますか|でしょうか|です|ます|でした|ください|教えて/gu,
  /[はをにへでとやも]/gu,
  /の/gu
];

const QUERY_TERM_STOPWORDS = new Set([
  "こと",
  "もの",
  "よう",
  "ため",
  "これ",
  "それ",
  "あれ",
  "どれ",
  "なに",
  "何",
  "対象",
  "有用",
  "勧められ",
  "勧められる",
  "推奨"
]);

const NO_CANONICAL_QUERY_EXPANSION = new Set(["肺がん", "診断"]);

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

export function normalizeText(text) {
  return normalizeWhitespace(
    (text || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[()［］[\]{}]/g, " ")
      .replace(/[／/]/g, " ")
      .replace(/[\u3000]/g, " ")
      .replace(/[，、,:：;；。.!?！？]/g, " ")
  );
}

export function compactText(text) {
  return normalizeText(text).replace(/\s+/g, "");
}

export function extractCqIds(text) {
  const normalized = normalizeText(text);
  const matches = normalized.matchAll(/\bcq\s*([0-9]+(?:\s*-\s*[0-9]+)?)\b/gi);

  return [...new Set([...matches].map((match) => `cq${match[1].replace(/\s+/g, "")}`))];
}

function groupMatches(group, normalized) {
  if (group.pattern) {
    return group.pattern.test(normalized);
  }

  return group.variants
    .map((variant) => normalizeText(variant))
    .some((variant) => variant && normalized.includes(variant));
}

function extractQueryTerms(normalized) {
  if (!normalized) {
    return [];
  }

  const clauseTerms = normalized
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4);
  const segmentedTerms = QUERY_TERM_SPLIT_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, " "),
    normalized
  )
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => {
      if (term.length < 2) {
        return false;
      }

      return !QUERY_TERM_STOPWORDS.has(term);
    });

  return [...new Set([...clauseTerms, ...segmentedTerms])];
}

export function getQueryProfile(query) {
  const normalized = normalizeText(query);
  const cqIds = extractCqIds(normalized);
  const tokenSet = new Set(extractQueryTerms(normalized));
  const matchedCanonicalTerms = new Set();
  const matchedTagTerms = new Set();

  for (const cqId of cqIds) {
    tokenSet.add(cqId);
  }

  for (const group of SYNONYM_GROUPS) {
    if (groupMatches(group, normalized)) {
      matchedCanonicalTerms.add(group.canonical);

      if (!NO_CANONICAL_QUERY_EXPANSION.has(group.canonical)) {
        tokenSet.add(normalizeText(group.canonical));
      }

      for (const queryTerm of group.queryTerms || []) {
        tokenSet.add(normalizeText(queryTerm));
      }

      for (const tagTerm of group.tagTerms || []) {
        matchedTagTerms.add(normalizeText(tagTerm));
      }
    }
  }

  return {
    normalized,
    compactNormalized: compactText(normalized),
    cqIds,
    queryTerms: [...tokenSet].sort((left, right) => right.length - left.length),
    queryPhrases: [
      ...new Set(extractQueryTerms(normalized).filter((term) => term.length >= 4))
    ].sort((left, right) => right.length - left.length),
    matchedCanonicalTerms: [...matchedCanonicalTerms].sort(
      (left, right) => right.length - left.length
    ),
    matchedTagTerms: [...matchedTagTerms].sort((left, right) => right.length - left.length)
  };
}
