import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { validateGuidelineChunk } from "../src/features/rag/guideline-schema.js";

const PART_LABEL = "第1部．肺癌診療ガイドライン";
const DEFAULT_CQ_INPUT = path.resolve("./data/processed/lung-cancer-guideline-2025.cq.jsonl");
const OUTPUT_PATH = path.resolve(
  process.argv[2] || "./data/processed/lung-cancer-guideline-hybrid.jsonl"
);
const OVERVIEW_URLS = [
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/0/240100000000.html",
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/1/240101000000.html",
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/2/240102010100.html",
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/2/240102010100.html#souron",
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/2/240102020100.html",
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/2/240102030100.html",
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/2/240102030100.html#souron",
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/2/240102040100.html#souron",
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/2/240102060100.html#souron",
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/2/240102070100.html#souron",
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/3/240103000000.html",
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/4/240104000000.html",
  "https://www.haigan.gr.jp/publication/guideline/examination/2024/1/5/240105000000.html"
];

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
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<sup[\s\S]*?<\/sup>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|dt|dd|tr|table|ul|ol|dl|caption|h1|h2|h3|div|th|td)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\u3000/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeSpaces(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeText(text) {
  const normalized = normalizeSpaces(text);
  const match = normalized.match(/^(.{0,140}?[\u3002.!?！？])/u);
  return (match ? match[1] : normalized.slice(0, 140)).trim();
}

function buildRecordId(version, pagePath, slug) {
  return `lcg-hybrid-${version}-${pagePath.replace(/[^0-9a-z]+/gi, "-").replace(/^-+|-+$/g, "")}-${slug}`;
}

function inferChapterFromPath(pagePath) {
  if (/\/1\/1\//.test(pagePath)) {
    return "Ⅰ．肺癌の診断";
  }

  if (/\/1\/2\//.test(pagePath)) {
    return "Ⅱ．非小細胞肺癌（NSCLC）";
  }

  if (/\/1\/3\//.test(pagePath)) {
    return "Ⅲ．小細胞肺癌（SCLC）";
  }

  if (/\/1\/4\//.test(pagePath)) {
    return "Ⅳ．転移など各病態に対する治療";
  }

  if (/\/1\/5\//.test(pagePath)) {
    return "Ⅴ．緩和ケア";
  }

  return "第1部．肺癌診療ガイドライン";
}

function inferSection(pageHtml, fallbackTitle) {
  const sectionNumber = stripTags(
    pageHtml.match(/<div class="number-background_bk"><p>([\s\S]*?)<\/p><\/div>/i)?.[1] || ""
  );
  const sectionTitle = stripTags(
    pageHtml.match(/<div class="section__number">[\s\S]*?<h2>([\s\S]*?)<\/h2>/i)?.[1] || ""
  );

  if (sectionTitle) {
    return sectionNumber ? `${sectionNumber} ${sectionTitle}` : sectionTitle;
  }

  return fallbackTitle;
}

function extractCqRefs(html) {
  const refs = new Set();
  const normalized = stripTags(html);
  const matches = normalized.matchAll(/cq\s*([0-9]+(?:\s*-\s*[0-9a-z]+)?)/giu);

  for (const match of matches) {
    refs.add(`CQ${match[1].replace(/\s+/g, "")}`.toUpperCase());
  }

  return [...refs];
}

function buildTags(record) {
  const source = normalizeSpaces(
    [
      record.chapter,
      record.section,
      record.heading,
      record.subheading,
      record.title,
      record.recommendation,
      record.explanation,
      ...(record.relatedCqs || [])
    ].join(" ")
  );
  const tags = new Set(["lung-cancer"]);
  const rules = [
    ["diagnosis", /診断|検出|病理|生検|分子診断|病期診断/u],
    ["nsclc", /非小細胞肺癌|非小細胞肺がん|nsclc/u],
    ["sclc", /(?<!非)小細胞肺癌|(?<!非)小細胞肺がん|sclc/u],
    ["perioperative", /術後補助療法|術前治療|周術期/u],
    ["systemic-therapy", /化学療法|免疫療法|分子標的|薬物療法/u],
    ["radiation", /放射線治療|照射|pci/u],
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

  if (record.docType === "meta") {
    tags.add("meta");
  }

  return [...tags];
}

function stripLeadingHeading(blockHtml, heading) {
  if (!heading) {
    return blockHtml;
  }

  return blockHtml.replace(/<p class="midashi_3">[\s\S]*?<\/p>/i, "");
}

function parseOverviewRecords(pageHtml, pageUrl) {
  const normalizedUrl = new URL(pageUrl);
  normalizedUrl.hash = "";
  const cleanUrl = normalizedUrl.toString();
  const pagePath = normalizedUrl.pathname;
  const version = pagePath.match(/\/examination\/([0-9]{4})\//)?.[1] || "2024";
  const souronMatch = pageHtml.match(
    /<dl class="title_3(?:-1)?" id="souron">[\s\S]*?<dd>([\s\S]*?)<\/dd>[\s\S]*?<\/dl>/i
  );

  if (!souronMatch || souronMatch.index === undefined) {
    return [];
  }

  const souronTitle = normalizeSpaces(stripTags(souronMatch[1]));
  const afterSouron = pageHtml.slice(souronMatch.index + souronMatch[0].length);
  const subsectionIndex = afterSouron.search(/<dl class="title_3[^"]*" id="(?!souron)[^"]+"/i);
  const firstCqIndex = afterSouron.search(/<div class="cq" id="/i);
  const endCandidates = [subsectionIndex, firstCqIndex].filter((value) => value >= 0);
  const segment =
    endCandidates.length > 0 ? afterSouron.slice(0, Math.min(...endCandidates)) : afterSouron;
  const explanationStart = segment.search(/<div class="midashi_1">[\s\S]*?解 説[\s\S]*?<\/div>/i);
  const explanationSlice = explanationStart >= 0 ? segment.slice(explanationStart) : segment;
  const explanationEnd = explanationSlice.search(/<div class="title_1">/i);
  const explanationZone =
    explanationEnd >= 0 ? explanationSlice.slice(0, explanationEnd) : explanationSlice;
  const metaZone = explanationEnd >= 0 ? explanationSlice.slice(explanationEnd) : "";
  const chapter =
    stripTags(pageHtml.match(/<h1><span>([\s\S]*?)<\/span><\/h1>/i)?.[1] || "") ||
    inferChapterFromPath(pagePath);
  const section = inferSection(pageHtml, souronTitle);
  const records = [];
  let sourceIndex = 0;

  for (const match of explanationZone.matchAll(
    /<div class="text-layout_[23]">([\s\S]*?)<\/div>/gi
  )) {
    const blockHtml = match[1];
    const heading = normalizeSpaces(
      stripTags(blockHtml.match(/<p class="midashi_3">([\s\S]*?)<\/p>/i)?.[1] || "")
    );
    const body = normalizeSpaces(stripTags(stripLeadingHeading(blockHtml, heading)));

    if (!body) {
      continue;
    }

    sourceIndex += 1;
    const record = {
      id: buildRecordId(version, pagePath, `souron-${sourceIndex}`),
      version,
      part: PART_LABEL,
      chapter,
      section,
      cq: "",
      title: heading ? `${souronTitle} - ${heading}` : souronTitle,
      question: heading || souronTitle,
      recommendation: summarizeText(body),
      recommendationStrength: "",
      evidenceGrade: "",
      explanation: body,
      url: `${cleanUrl}#souron`,
      updatedAt: `${version}-01-01`,
      sourceType: "html",
      hasTable: /<table\b/i.test(blockHtml),
      hasFigure: /<figure\b|<img\b/i.test(blockHtml),
      docType: "souron",
      heading: souronTitle,
      subheading: heading,
      relatedCqs: extractCqRefs(blockHtml),
      priority: Math.max(4, 18 - sourceIndex)
    };

    record.tags = buildTags(record);
    records.push(record);
  }

  let metaIndex = 0;

  for (const match of metaZone.matchAll(
    /<div class="title_1"><p>([\s\S]*?)<\/p><\/div>([\s\S]*?)(?=<div class="title_1">|$)/gi
  )) {
    const heading = normalizeSpaces(stripTags(match[1]));
    const body = normalizeSpaces(stripTags(match[2]));

    if (!heading || !body) {
      continue;
    }

    metaIndex += 1;
    const record = {
      id: buildRecordId(version, pagePath, `meta-${metaIndex}`),
      version,
      part: PART_LABEL,
      chapter,
      section,
      cq: "",
      title: `${souronTitle} - ${heading}`,
      question: heading,
      recommendation: summarizeText(body),
      recommendationStrength: "",
      evidenceGrade: "",
      explanation: body,
      url: `${cleanUrl}#souron`,
      updatedAt: `${version}-01-01`,
      sourceType: "html",
      hasTable: /<table\b/i.test(match[2]),
      hasFigure: /<figure\b|<img\b/i.test(match[2]),
      docType: "meta",
      heading: souronTitle,
      subheading: heading,
      relatedCqs: [],
      priority: 2
    };

    record.tags = buildTags(record);
    records.push(record);
  }

  return records;
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "yamamotoavator-demo/0.1 hybrid ingestion"
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

const cqRaw = await fs.readFile(DEFAULT_CQ_INPUT, "utf-8");
const cqRecords = cqRaw
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .map((record) => ({
    ...record,
    docType: "cq",
    heading: record.heading || "",
    subheading: record.subheading || "",
    relatedCqs: Array.isArray(record.relatedCqs) ? record.relatedCqs : [],
    priority: Number.isFinite(record.priority) ? record.priority : 10
  }));

const overviewRecords = [];
const uniqueOverviewUrls = [
  ...new Set(
    OVERVIEW_URLS.map((url) => {
      const normalizedUrl = new URL(url);
      normalizedUrl.hash = "";
      return normalizedUrl.toString();
    })
  )
];

for (const cleanUrl of uniqueOverviewUrls) {
  const pageHtml = await fetchHtml(cleanUrl);

  overviewRecords.push(...parseOverviewRecords(pageHtml, cleanUrl));
}

const records = [...cqRecords, ...overviewRecords];
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

console.log(
  `Wrote ${records.length} hybrid guideline chunks (${cqRecords.length} CQ + ${overviewRecords.length} overview/meta) to ${OUTPUT_PATH}`
);
