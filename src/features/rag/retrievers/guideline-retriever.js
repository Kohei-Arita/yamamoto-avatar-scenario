import fs from "node:fs/promises";
import path from "node:path";
import env from "../../../config/env.js";
import { compactText, getQueryProfile, normalizeText } from "../query-normalizer.js";

let cachedChunks = null;

function uniqueBy(items, selector) {
  const seen = new Set();

  return items.filter((item) => {
    const key = selector(item);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function normalizeDocType(value) {
  return value === "souron" || value === "meta" ? value : "cq";
}

function buildCharacterNgrams(text) {
  const compact = compactText(text);
  const grams = new Set();

  for (const size of [2, 3]) {
    if (compact.length < size) {
      continue;
    }

    for (let index = 0; index <= compact.length - size; index += 1) {
      grams.add(compact.slice(index, index + size));
    }
  }

  return grams;
}

function diceCoefficient(left, right) {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  let overlap = 0;

  for (const gram of smaller) {
    if (larger.has(gram)) {
      overlap += 1;
    }
  }

  return (2 * overlap) / (left.size + right.size);
}

function buildTermStatistics(queryTerms, chunks) {
  const statistics = new Map();

  for (const term of queryTerms) {
    let documentFrequency = 0;

    for (const chunk of chunks) {
      if (chunk.normalized.searchableText.includes(term) || chunk.normalized.tags.includes(term)) {
        documentFrequency += 1;
      }
    }

    statistics.set(term, {
      documentFrequency,
      specificity: Math.max(1, 1 + Math.log((chunks.length + 1) / (documentFrequency + 1)))
    });
  }

  return statistics;
}

function getTermSpecificity(term, termStatistics) {
  return termStatistics.get(term)?.specificity || 1;
}

function isBroadTerm(term, termStatistics, totalChunks) {
  if (totalChunks <= 0) {
    return false;
  }

  return (termStatistics.get(term)?.documentFrequency || 0) / totalChunks > 0.5;
}

function scoreExactMatches(profile, chunk, termStatistics, totalChunks) {
  let score = 0;
  const matchedTerms = new Set();

  for (const term of profile.queryTerms) {
    if (!term) {
      continue;
    }

    const specificity = getTermSpecificity(term, termStatistics);

    if (chunk.normalized.cq === term) {
      score += 40;
      matchedTerms.add(term);
      continue;
    }

    if (chunk.normalized.title.includes(term)) {
      score += Math.round(8 * specificity);
      matchedTerms.add(term);
    }

    if (chunk.normalized.question.includes(term)) {
      score += Math.round(7 * specificity);
      matchedTerms.add(term);
    }

    if (chunk.normalized.recommendation.includes(term)) {
      score += Math.round(4 * specificity);
      matchedTerms.add(term);
    }

    if (chunk.normalized.section.includes(term) || chunk.normalized.chapter.includes(term)) {
      score += Math.round(2 * specificity);
      matchedTerms.add(term);
    }

    if (chunk.normalized.explanation.includes(term)) {
      score += Math.max(1, Math.round(specificity));
      matchedTerms.add(term);
    }
  }

  for (const tagTerm of profile.matchedTagTerms) {
    if (isBroadTerm(tagTerm, termStatistics, totalChunks)) {
      continue;
    }

    if (chunk.normalized.tags.includes(tagTerm)) {
      score += Math.round(2 * getTermSpecificity(tagTerm, termStatistics));
      matchedTerms.add(tagTerm);
    }
  }

  return {
    score,
    matchedTerms
  };
}

function scorePhraseMatches(profile, chunk) {
  let score = 0;
  const matchedTerms = new Set();

  for (const phrase of profile.queryPhrases) {
    const compactPhrase = compactText(phrase);

    if (compactPhrase.length < 4) {
      continue;
    }

    if (chunk.normalized.compactTitle.includes(compactPhrase)) {
      score += Math.min(36, compactPhrase.length * 3);
      matchedTerms.add(phrase);
      continue;
    }

    if (chunk.normalized.compactQuestion.includes(compactPhrase)) {
      score += Math.min(32, compactPhrase.length * 2);
      matchedTerms.add(phrase);
    }
  }

  if (!profile.compactNormalized) {
    return {
      score,
      matchedTerms
    };
  }

  if (chunk.normalized.compactQuestion === profile.compactNormalized) {
    score += 80;
  } else if (chunk.normalized.compactQuestion.includes(profile.compactNormalized)) {
    score += 42;
  }

  if (chunk.normalized.compactTitle === profile.compactNormalized) {
    score += 72;
  } else if (chunk.normalized.compactTitle.includes(profile.compactNormalized)) {
    score += 36;
  }

  return {
    score,
    matchedTerms
  };
}

function scoreFuzzySimilarity(profile, chunk) {
  if (profile.ngrams.size === 0) {
    return {
      score: 0,
      similarity: {
        title: 0,
        question: 0,
        titleQuestion: 0
      }
    };
  }

  const similarity = {
    title: diceCoefficient(profile.ngrams, chunk.ngrams.title),
    question: diceCoefficient(profile.ngrams, chunk.ngrams.question),
    titleQuestion: diceCoefficient(profile.ngrams, chunk.ngrams.titleQuestion)
  };
  let score = 0;

  if (similarity.titleQuestion >= 0.12) {
    score += Math.round(similarity.titleQuestion * 70);
  }

  const strongestPrimarySimilarity = Math.max(similarity.title, similarity.question);

  if (strongestPrimarySimilarity >= 0.16) {
    score += Math.round(strongestPrimarySimilarity * 45);
  }

  return {
    score,
    similarity
  };
}

function scoreBroadTreatmentIntent(profile, chunk) {
  if (!profile.matchedCanonicalTerms.includes("肺がん治療")) {
    return 0;
  }

  const chapterSection = `${chunk.normalized.chapter} ${chunk.normalized.section}`;
  const treatmentTagCount = chunk.normalized.tags.filter((tag) =>
    ["systemic-therapy", "surgery", "radiation", "perioperative", "nsclc", "sclc"].includes(tag)
  ).length;
  let score = 0;

  if (treatmentTagCount > 0) {
    score += 6 + treatmentTagCount;
  }

  if (/薬物療法|周術期|放射線治療|小細胞肺癌|非小細胞肺癌/u.test(chapterSection)) {
    score += 10;
  }

  if (/診断|病理・細胞診断/u.test(chapterSection)) {
    score -= 12;
  }

  return score;
}

function inferQueryIntent(query, profile) {
  const normalized = normalizeText(query);

  if (/文献検索|検索式|採択方法|作成方法|エビデンス|略語|用語|改訂/u.test(normalized)) {
    return "meta";
  }

  if (
    profile.cqIds.length > 0 ||
    /勧められる|推奨|有用|適応|線量|行う|行わない|何か/u.test(normalized)
  ) {
    return "specific";
  }

  if (
    profile.matchedCanonicalTerms.includes("肺がん治療") ||
    /総論|全体|全般|概要|方針|流れ|考え方|まとめ|教えて/u.test(normalized)
  ) {
    return "broad";
  }

  return "specific";
}

function scoreHeadingMatches(profile, chunk) {
  let score = 0;
  const matchedTerms = new Set();

  for (const term of profile.queryTerms) {
    if (!term) {
      continue;
    }

    if (chunk.normalized.heading.includes(term)) {
      score += 5;
      matchedTerms.add(term);
    }

    if (chunk.normalized.subheading.includes(term)) {
      score += 4;
      matchedTerms.add(term);
    }
  }

  return {
    score,
    matchedTerms
  };
}

function scoreSourcePrior(queryIntent, chunk) {
  const docType = chunk.docType;

  if (queryIntent === "meta") {
    if (docType === "meta") {
      return 80;
    }

    return docType === "souron" ? 12 : -12;
  }

  if (queryIntent === "broad") {
    if (docType === "souron") {
      return 50;
    }

    if (docType === "cq") {
      return 5;
    }

    return -12;
  }

  if (docType === "cq") {
    return 24;
  }

  if (docType === "souron") {
    return 0;
  }

  return -24;
}

function getQuotaOrder(queryIntent) {
  if (queryIntent === "broad") {
    return ["souron", "cq", "meta"];
  }

  if (queryIntent === "meta") {
    return ["meta", "souron", "cq"];
  }

  return ["cq", "souron", "meta"];
}

function getQuotaLimits(queryIntent, topK) {
  if (queryIntent === "broad") {
    return {
      souron: Math.max(2, Math.min(topK, 3)),
      cq: Math.min(topK, 2),
      meta: 1
    };
  }

  if (queryIntent === "meta") {
    return {
      meta: Math.max(2, Math.min(topK, 3)),
      souron: 1,
      cq: 1
    };
  }

  return {
    cq: Math.max(2, Math.min(topK, 3)),
    souron: Math.min(topK, 2),
    meta: 1
  };
}

function pickPreferredDocTypeCandidate(chunks, preferredDocType, profile, queryIntent) {
  const candidates = chunks
    .filter((chunk) => chunk.docType === preferredDocType)
    .map((chunk) => {
      let score = scoreSourcePrior(queryIntent, chunk);
      const text = `${chunk.title || ""} ${chunk.heading || ""} ${chunk.section || ""} ${chunk.explanation || ""}`;

      for (const term of profile.queryTerms) {
        if (!term) {
          continue;
        }

        if (
          chunk.normalized.searchableText.includes(term) ||
          chunk.normalized.heading.includes(term) ||
          chunk.normalized.subheading.includes(term)
        ) {
          score += 6;
        }
      }

      for (const tagTerm of profile.matchedTagTerms) {
        if (chunk.normalized.tags.includes(tagTerm)) {
          score += 4;
        }
      }

      if (
        queryIntent === "broad" &&
        preferredDocType === "souron" &&
        /治療|方針|総論|解説|診断|病期|放射線|外科|薬物/u.test(text)
      ) {
        score += 8;
      }

      if (
        queryIntent === "meta" &&
        /略語|用語|文献検索|採択/u.test(
          `${chunk.title || ""} ${chunk.subheading || ""} ${chunk.explanation || ""}`
        )
      ) {
        score += 8;
      }

      return {
        ...chunk,
        score,
        matchedTerms: [],
        similarity: {
          title: 0,
          question: 0,
          titleQuestion: 0
        }
      };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score);

  return candidates[0] || null;
}

function normalizeSelectedChunk(chunk) {
  if (!chunk) {
    return null;
  }

  return {
    ...chunk,
    score: chunk.score || 1,
    matchedTerms: chunk.matchedTerms || [],
    similarity: chunk.similarity || {
      title: 0,
      question: 0,
      titleQuestion: 0
    }
  };
}

function ensureLeadingPreferredDocType(
  selected,
  chunks,
  preferredDocType,
  profile,
  queryIntent,
  topK
) {
  const preferred = normalizeSelectedChunk(
    pickPreferredDocTypeCandidate(chunks, preferredDocType, profile, queryIntent)
  );

  if (!preferred) {
    return selected.slice(0, topK);
  }

  return [preferred, ...selected.filter((item) => item.id !== preferred.id)].slice(0, topK);
}

function scoreChunk(profile, queryIntent, chunk, termStatistics, totalChunks) {
  const exactMatch = scoreExactMatches(profile, chunk, termStatistics, totalChunks);
  const phraseMatch = scorePhraseMatches(profile, chunk);
  const fuzzyMatch = scoreFuzzySimilarity(profile, chunk);
  const headingMatch = scoreHeadingMatches(profile, chunk);
  const matchedTerms = new Set([
    ...exactMatch.matchedTerms,
    ...phraseMatch.matchedTerms,
    ...headingMatch.matchedTerms
  ]);

  return {
    score:
      exactMatch.score +
      phraseMatch.score +
      fuzzyMatch.score +
      headingMatch.score +
      scoreBroadTreatmentIntent(profile, chunk) +
      scoreSourcePrior(queryIntent, chunk) +
      Math.max(-4, Math.min(8, Number(chunk.priority || 0))),
    matchedTerms: [...matchedTerms].sort((left, right) => right.length - left.length),
    similarity: fuzzyMatch.similarity
  };
}

function enrichChunk(chunk) {
  const title = normalizeText(chunk.title);
  const question = normalizeText(chunk.question || chunk.title);

  return {
    ...chunk,
    docType: normalizeDocType(chunk.docType),
    heading: chunk.heading || "",
    subheading: chunk.subheading || "",
    relatedCqs: Array.isArray(chunk.relatedCqs) ? [...new Set(chunk.relatedCqs)] : [],
    priority: Number.isFinite(chunk.priority) ? chunk.priority : 0,
    normalized: {
      cq: normalizeText(chunk.cq),
      title,
      question,
      recommendation: normalizeText(chunk.recommendation),
      explanation: normalizeText(chunk.explanation),
      chapter: normalizeText(chunk.chapter),
      section: normalizeText(chunk.section),
      heading: normalizeText(chunk.heading),
      subheading: normalizeText(chunk.subheading),
      tags: Array.isArray(chunk.tags) ? chunk.tags.map((tag) => normalizeText(tag)) : [],
      relatedCqs: Array.isArray(chunk.relatedCqs)
        ? chunk.relatedCqs.map((cq) => normalizeText(cq))
        : [],
      searchableText: normalizeText(
        [
          chunk.title,
          chunk.heading,
          chunk.subheading,
          chunk.question || chunk.title,
          chunk.recommendation,
          chunk.explanation,
          chunk.chapter,
          chunk.section
        ]
          .filter(Boolean)
          .join(" ")
      ),
      compactTitle: compactText(title),
      compactQuestion: compactText(question)
    },
    ngrams: {
      title: buildCharacterNgrams(title),
      question: buildCharacterNgrams(question),
      titleQuestion: buildCharacterNgrams(`${title} ${question}`)
    }
  };
}

async function loadChunks() {
  if (cachedChunks) {
    return cachedChunks;
  }

  const absolutePath = path.resolve(env.ragDataPath);
  const raw = await fs.readFile(absolutePath, "utf-8");

  cachedChunks = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((chunk) => enrichChunk(chunk));

  return cachedChunks;
}

export async function retrieveGuidelineChunks(query, topK = env.ragTopK) {
  const chunks = await loadChunks();
  const baseProfile = getQueryProfile(query);
  const queryIntent = inferQueryIntent(query, baseProfile);
  const profile = {
    ...baseProfile,
    ngrams: buildCharacterNgrams(baseProfile.compactNormalized)
  };
  const termStatistics = buildTermStatistics(
    [...new Set([...profile.queryTerms, ...profile.matchedTagTerms])],
    chunks
  );
  const scored = chunks
    .map((chunk) => {
      const score = scoreChunk(profile, queryIntent, chunk, termStatistics, chunks.length);

      return {
        ...chunk,
        score: score.score,
        matchedTerms: score.matchedTerms,
        similarity: score.similarity
      };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.similarity.titleQuestion - left.similarity.titleQuestion;
    });
  const grouped = {
    cq: scored.filter((chunk) => chunk.docType === "cq"),
    souron: scored.filter((chunk) => chunk.docType === "souron"),
    meta: scored.filter((chunk) => chunk.docType === "meta")
  };
  const seededCqIds = new Set(
    grouped.cq.slice(0, Math.max(2, topK)).map((chunk) => chunk.normalized.cq)
  );
  const rescored = scored
    .map((chunk) => {
      if (chunk.docType !== "souron" || chunk.normalized.relatedCqs.length === 0) {
        return chunk;
      }

      const overlapCount = chunk.normalized.relatedCqs.filter((cq) => seededCqIds.has(cq)).length;

      if (overlapCount === 0) {
        return chunk;
      }

      return {
        ...chunk,
        score: chunk.score + 10 + overlapCount * 4,
        graphBoost: overlapCount
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.similarity.titleQuestion - left.similarity.titleQuestion;
    });
  const strictHits = uniqueBy(
    rescored.filter((chunk) => {
      if (chunk.score < env.ragMinScore) {
        return false;
      }

      if (queryIntent === "broad" && chunk.docType === "souron") {
        return true;
      }

      if (queryIntent === "meta" && chunk.docType === "meta") {
        return true;
      }

      return chunk.matchedTerms.length > 0 || chunk.similarity.titleQuestion >= 0.2;
    }),
    (chunk) => chunk.id
  );
  const fallbackHits = uniqueBy(rescored, (chunk) => chunk.id);
  const selected = [];
  const perTypeCount = {
    cq: 0,
    souron: 0,
    meta: 0
  };
  const quotaOrder = getQuotaOrder(queryIntent);
  const quotaLimits = getQuotaLimits(queryIntent, topK);

  for (const docType of quotaOrder) {
    for (const candidate of strictHits.filter((chunk) => chunk.docType === docType)) {
      if (selected.length >= topK || perTypeCount[docType] >= quotaLimits[docType]) {
        break;
      }

      if (selected.some((item) => item.id === candidate.id)) {
        continue;
      }

      selected.push(candidate);
      perTypeCount[docType] += 1;
    }
  }

  for (const candidate of [...strictHits, ...fallbackHits]) {
    if (selected.length >= topK) {
      break;
    }

    if (selected.some((item) => item.id === candidate.id)) {
      continue;
    }

    selected.push(candidate);
  }

  let finalSelected = selected.slice(0, topK);

  if (queryIntent === "broad") {
    finalSelected = ensureLeadingPreferredDocType(
      finalSelected,
      chunks,
      "souron",
      profile,
      queryIntent,
      topK
    );
  }

  const retrievalStage =
    finalSelected.length === 0
      ? "no_hit"
      : strictHits.length >= Math.min(topK, 2)
        ? "strict"
        : "fallback";

  const diagnostics = {
    queryIntent,
    retrievalStage,
    matchedTerms: [...new Set(finalSelected.flatMap((chunk) => chunk.matchedTerms))].slice(0, 12),
    strictCandidateCount: strictHits.length,
    fallbackCandidateCount: fallbackHits.length,
    sourceIds: finalSelected.map((chunk) => chunk.id),
    docTypes: finalSelected.map((chunk) => chunk.docType)
  };

  return {
    hits: finalSelected.map(({ normalized, ngrams, ...chunk }) => chunk),
    diagnostics
  };
}
