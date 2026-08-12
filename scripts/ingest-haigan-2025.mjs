import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { validateGuidelineChunk } from "../src/features/rag/guideline-schema.js";

const BASE_URL = "https://www.haigan.gr.jp/publication/guideline/examination/2025/";
const INDEX_URL = new URL("./", BASE_URL).toString();
const OUTPUT_PATH = path.resolve(
  process.argv[2] || "./data/processed/lung-cancer-guideline-2025.cq.jsonl"
);
const UPDATED_AT = "2025-11-06";
const PART_LABEL = "第1部．肺癌診療ガイドライン";

function decodeHtmlEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }

    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }

    return named[entity.toLowerCase()] || full;
  });
}

function stripTags(html) {
  return decodeHtmlEntities(
    (html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<sup[\s\S]*?<\/sup>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|dt|dd|tr|table|ul|ol|dl|caption|h1|h2|h3|div)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\u3000/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeSpaces(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function sanitizeRecommendation(text) {
  return normalizeSpaces(
    text
      .replace(/〔推奨の強さ[\s\S]*?〕/g, "")
      .replace(/^推\s*奨\s*/u, "")
      .trim()
  );
}

function buildTags(record) {
  const source = normalizeSpaces(
    [
      record.chapter,
      record.section,
      record.cq,
      record.title,
      record.question,
      record.recommendation
    ].join(" ")
  );

  const tags = new Set(["lung-cancer"]);
  const rules = [
    ["diagnosis", /診断|検出|病理|生検|分子診断|病期診断/u],
    ["nsclc", /非小細胞肺癌|非小細胞肺がん|nsclc/u],
    ["sclc", /(?<!非)小細胞肺癌|(?<!非)小細胞肺がん|sclc/u],
    ["perioperative", /術後補助療法|術前治療|周術期/u],
    ["systemic-therapy", /化学療法|免疫療法|分子標的|薬物療法/u],
    ["radiation", /放射線治療|照射/u],
    ["surgery", /外科|切除|手術/u],
    ["egfr", /egfr/iu],
    ["alk", /alk/iu],
    ["ros1", /ros1/iu],
    ["kras", /kras/iu],
    ["braf", /braf/iu],
    ["met", /\bmet\b|exon14/iu],
    ["ret", /\bret\b/iu],
    ["ntrk", /\bntrk\b/iu],
    ["her2", /her2|erbb2/iu],
    ["pd-l1", /pd-l1|pdl1/iu]
  ];

  for (const [tag, pattern] of rules) {
    if (pattern.test(source)) {
      tags.add(tag);
    }
  }

  return [...tags];
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "yamamotoavator-demo/0.1 internal evaluation"
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

function extractPartOnePageUrls(indexHtml) {
  const hrefs = indexHtml.matchAll(/href="(1\/[^"#?]+\.html)(?:#[^"]*)?"/g);

  return [...new Set([...hrefs].map((match) => match[1]))];
}

function buildRecordId(pagePath, cqId) {
  return `lcg2025-${pagePath.replace(/[^0-9a-z]+/gi, "-").replace(/^-+|-+$/g, "")}-${cqId}`;
}

function parseStrengths(html) {
  const flattened = stripTags(html);
  const recommendationStrength = flattened.match(/推奨の強さ[:：]\s*([^\s,，〕]+)/u)?.[1] || "不明";
  const evidenceGrade = flattened.match(/エビデンスの強さ[:：]\s*([^\s,，〕]+)/u)?.[1] || "不明";

  return { recommendationStrength, evidenceGrade };
}

function parseSectionPage(pageHtml, pageUrl) {
  const chapter = stripTags(pageHtml.match(/<h1><span>([\s\S]*?)<\/span><\/h1>/i)?.[1] || "");
  const sectionNumber = stripTags(
    pageHtml.match(/<div class="number-background_bk"><p>([\s\S]*?)<\/p><\/div>/i)?.[1] || ""
  );
  const section = stripTags(
    pageHtml.match(/<div class="section__number">[\s\S]*?<h2>([\s\S]*?)<\/h2>/i)?.[1] || ""
  );
  const pagePath = new URL(pageUrl).pathname.split("/2025/")[1] || "";
  const parts = pageHtml.split(/<div class="cq" id="(cq[0-9-]+)">/i);
  const records = [];

  for (let index = 1; index < parts.length; index += 2) {
    const cqAnchor = parts[index];
    const segment = parts[index + 1] || "";
    const titleBlock = segment.match(
      /<div class="cq__title">[\s\S]*?<p>([\s\S]*?)<\/p>[\s\S]*?<p>([\s\S]*?)<\/p>[\s\S]*?<\/div>/i
    );
    const recommendBlock = segment.match(/<dl class="cq__recommend">([\s\S]*?)<\/dl>/i)?.[1] || "";
    const explanationBlock =
      segment.match(/<div class="text-layout_2">([\s\S]*?)<\/div>/i)?.[1] || "";

    if (!titleBlock || !recommendBlock || !explanationBlock) {
      continue;
    }

    const cqLabel = normalizeSpaces(stripTags(titleBlock[1]).replace(/[．.]/g, ""));
    const question = normalizeSpaces(stripTags(titleBlock[2]));
    const recommendationText = sanitizeRecommendation(stripTags(recommendBlock));
    const explanationText = normalizeSpaces(stripTags(explanationBlock));
    const strengths = parseStrengths(recommendBlock);
    const record = {
      id: buildRecordId(pagePath, cqAnchor),
      version: "2025",
      part: PART_LABEL,
      chapter,
      section: sectionNumber ? `${sectionNumber} ${section}` : section,
      cq: cqLabel || cqAnchor.toUpperCase(),
      title: question,
      question,
      recommendation: recommendationText,
      recommendationStrength: strengths.recommendationStrength,
      evidenceGrade: strengths.evidenceGrade,
      explanation: explanationText,
      url: `${pageUrl}#${cqAnchor}`,
      updatedAt: UPDATED_AT,
      sourceType: "html",
      hasTable: /<table\b/i.test(segment),
      hasFigure: /<figure\b|<img\b/i.test(segment)
    };

    record.tags = buildTags(record);
    records.push(record);
  }

  return records;
}

const indexHtml = await fetchHtml(INDEX_URL);
const pagePaths = extractPartOnePageUrls(indexHtml);
const records = [];

for (const pagePath of pagePaths) {
  const pageUrl = new URL(pagePath, BASE_URL).toString();
  const pageHtml = await fetchHtml(pageUrl);

  records.push(...parseSectionPage(pageHtml, pageUrl));
}

const validationErrors = [];

records.forEach((record, index) => {
  for (const issue of validateGuidelineChunk(record)) {
    validationErrors.push(`Record ${index + 1} (${record.id}): ${issue}`);
  }
});

if (validationErrors.length > 0) {
  throw new Error(validationErrors.join("\n"));
}

await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await fs.writeFile(OUTPUT_PATH, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

console.log(`Wrote ${records.length} CQ chunks to ${OUTPUT_PATH}`);
