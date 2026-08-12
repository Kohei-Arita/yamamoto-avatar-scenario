import test from "node:test";
import assert from "node:assert/strict";
import { buildRetrievalQuery, isLikelyFollowUpUtterance } from "./follow-up-context.js";
import { buildRagContext, buildRagSystemPrompt } from "./prompts/answer-prompt.js";
import { getQueryProfile } from "./query-normalizer.js";
import { decideNeedRag } from "./rag-router.js";
import { retrieveGuidelineChunks } from "./retrievers/guideline-retriever.js";
import { normalizeMedicalTranscript } from "./transcript-normalizer.js";

test("normalizes common ASR errors for the hilar sputum cytology question", () => {
  const transcript = normalizeMedicalTranscript(
    "ハイリスク分を対象とした 背門部肺癌の検出に 喀痰細胞診は有用ですか"
  );

  assert.equal(
    transcript.normalizedText,
    "ハイリスク群を対象とした 肺門部肺癌の検出に 喀痰細胞診は有用ですか"
  );
  assert.deepEqual(
    transcript.repairs.map((repair) => repair.type),
    ["high_risk_group_homophone", "hilar_lung_homophone"]
  );
});

test("normalizes lung-cancer homophones in broad explanation requests", () => {
  const transcript = normalizeMedicalTranscript("対岸について教えてください");

  assert.equal(transcript.normalizedText, "肺がんについて教えてください");
  assert.deepEqual(transcript.repairs.map((repair) => repair.type), ["lung_cancer_homophone"]);
});

test("normalizes ASR errors for prophylactic whole-brain irradiation dose questions", () => {
  const transcript = normalizeMedicalTranscript("予防的全能消者の進められる占領は何ですか");

  assert.equal(transcript.normalizedText, "予防的全脳照射の勧められる線量は何ですか");
  assert.deepEqual(
    transcript.repairs.map((repair) => repair.type),
    [
      "pci_whole_brain_irradiation_homophone",
      "recommendation_wording_homophone",
      "radiation_dose_homophone"
    ]
  );
});

test("normalizes additional ASR variants for prophylactic whole-brain irradiation dose questions", () => {
  const transcript = normalizeMedicalTranscript("予防的全能照射を進め合える占領は何ですか");

  assert.equal(transcript.normalizedText, "予防的全脳照射を勧められる線量は何ですか");
  assert.deepEqual(
    transcript.repairs.map((repair) => repair.type),
    [
      "pci_whole_brain_irradiation_homophone",
      "recommendation_wording_homophone",
      "radiation_dose_homophone"
    ]
  );
});

test("keeps cancer terms intact while expanding clinically useful aliases", () => {
  const profile = getQueryProfile("EGFR陽性の非小細胞肺がんの一次治療は？");

  assert.ok(profile.queryTerms.includes("非小細胞肺がん"));
  assert.ok(profile.queryTerms.includes("非小細胞肺癌"));
  assert.ok(profile.queryTerms.includes("egfr"));
  assert.ok(profile.queryTerms.includes("一次治療"));
});

test("expands broad lung-cancer treatment questions into concrete treatment query terms", () => {
  const profile = getQueryProfile("肺がん治療について教えてください");

  assert.ok(profile.matchedCanonicalTerms.includes("肺がん治療"));
  assert.ok(profile.queryTerms.includes("薬物療法"));
  assert.ok(profile.queryTerms.includes("手術"));
  assert.ok(profile.queryTerms.includes("放射線治療"));
  assert.ok(profile.matchedTagTerms.includes("systemic-therapy"));
});

test("expands PCI aliases to prophylactic whole-brain irradiation without keeping recommendation filler", () => {
  const profile = getQueryProfile("PCIは勧められますか");

  assert.ok(profile.queryTerms.includes("pci"));
  assert.ok(profile.queryTerms.includes("予防的全脳照射"));
  assert.ok(profile.matchedCanonicalTerms.includes("予防的全脳照射"));
  assert.ok(!profile.queryTerms.includes("勧められ"));
});

test("routes sputum cytology questions to RAG even without explicit lung context", () => {
  assert.deepEqual(decideNeedRag("喀痰細胞診は有用ですか"), {
    needsRag: true,
    reason: "forced_keyword:診断"
  });
});

test("routes PCI recommendation questions to RAG", () => {
  assert.deepEqual(decideNeedRag("PCIは勧められますか"), {
    needsRag: true,
    reason: "forced_keyword:予防的全脳照射"
  });
});

test("routes normalized lung-cancer overview requests to RAG", () => {
  const transcript = normalizeMedicalTranscript("対岸について教えてください");

  assert.deepEqual(decideNeedRag(transcript.normalizedText), {
    needsRag: true,
    reason: "forced_keyword:肺がん"
  });
});

test("routes convex probe EBUS-TBNA questions to RAG", () => {
  assert.deepEqual(
    decideNeedRag(
      "肺門縦隔リンパ節及び気管中枢気管支に接する病変に対してコンベックス型EBUS-TBNAは勧められますか"
    ),
    {
      needsRag: true,
      reason: "forced_keyword:コンベックス型EBUS-TBNA"
    }
  );
});

test("treats generic guideline review requests as follow-up utterances", () => {
  assert.equal(isLikelyFollowUpUtterance("ガイドライン見てくれよ 一回"), true);
  assert.equal(
    isLikelyFollowUpUtterance(
      "肺末梢小型病変の経気管支生検に仮想気管支鏡ナビゲーションは勧められますか"
    ),
    false
  );
});

test("does not treat short standalone medical questions as follow-up utterances", () => {
  assert.equal(isLikelyFollowUpUtterance("ALKは？"), false);
  assert.equal(isLikelyFollowUpUtterance("EGFRは？"), false);
});

test("routes guideline review follow-ups to RAG using prior lung-cancer context", () => {
  const decision = decideNeedRag("ガイドライン見てくれよ 一回", {
    historyMessages: [
      {
        role: "user",
        content: "肺末梢小型病変の経気管支生検に仮想気管支鏡ナビゲーションは勧められますか"
      }
    ]
  });

  assert.equal(decision.needsRag, true);
  assert.match(decision.reason, /^contextual_/u);
});

test("builds retrieval queries from the prior user turn for generic guideline follow-ups", () => {
  assert.equal(
    buildRetrievalQuery("ガイドライン見てくれよ 一回", [
      {
        role: "assistant",
        content: "まず病変の大きさや位置を教えてください。"
      },
      {
        role: "user",
        content: "肺末梢小型病変の経気管支生検に仮想気管支鏡ナビゲーションは勧められますか"
      }
    ]),
    [
      "肺末梢小型病変の経気管支生検に仮想気管支鏡ナビゲーションは勧められますか",
      "ガイドライン見てくれよ 一回"
    ].join("\n")
  );
});

test("builds retrieval queries from assistant clarifications when the follow-up answer is generic", () => {
  assert.equal(
    buildRetrievalQuery("検診で影があり詳しく調べる予定です", [
      {
        role: "user",
        content: "症病変の景気監視整形にラジアル型EBUFは進められますか"
      },
      {
        role: "assistant",
        content:
          "経気管支鏡検査でのラジアル型EBUSのことですね。現在、どのような症状や検査結果があって、その検査を検討されているのでしょうか？"
      }
    ]),
    [
      "症病変の景気監視整形にラジアル型EBUFは進められますか",
      "経気管支鏡検査でのラジアル型EBUSのことですね。現在、どのような症状や検査結果があって、その検査を検討されているのでしょうか？",
      "検診で影があり詳しく調べる予定です"
    ].join("\n")
  );
});

test("retrieves CQ2 as the top hit for the repaired high-risk hilar lung cancer question", async () => {
  const transcript = normalizeMedicalTranscript(
    "ハイリスク分を対象とした 背門部肺癌の検出に 喀痰細胞診は有用ですか"
  );
  const retrieval = await retrieveGuidelineChunks(transcript.normalizedText, 3);

  assert.equal(retrieval.hits[0]?.cq, "CQ2");
  assert.match(retrieval.hits[0]?.title || "", /喀痰細胞診/u);
});

test("retrieves CQ15 from the repaired prophylactic whole-brain irradiation dose question", async () => {
  const transcript = normalizeMedicalTranscript("予防的全能消者の進められる占領は何ですか");
  const retrieval = await retrieveGuidelineChunks(transcript.normalizedText, 3);

  assert.equal(retrieval.hits[0]?.cq, "CQ15");
  assert.match(retrieval.hits[0]?.title || "", /線量/u);
});

test("retrieves CQ15 from an additional repaired prophylactic whole-brain irradiation dose variant", async () => {
  const transcript = normalizeMedicalTranscript("予防的全能照射を進め合える占領は何ですか");
  const retrieval = await retrieveGuidelineChunks(transcript.normalizedText, 3);

  assert.equal(retrieval.hits[0]?.cq, "CQ15");
  assert.match(retrieval.hits[0]?.title || "", /線量/u);
});

test("retrieves CQ12 for a generic guideline follow-up once prior context is included", async () => {
  const retrieval = await retrieveGuidelineChunks(
    buildRetrievalQuery("ガイドライン見てくれよ 一回", [
      {
        role: "user",
        content: "肺末梢小型病変の経気管支生検に仮想気管支鏡ナビゲーションは勧められますか"
      }
    ]),
    3
  );

  assert.equal(retrieval.hits[0]?.cq, "CQ12");
  assert.match(retrieval.hits[0]?.title || "", /仮想気管支鏡ナビゲーション/u);
});

test("retrieves CQ11 for convex probe EBUS-TBNA questions", async () => {
  const retrieval = await retrieveGuidelineChunks(
    "肺門縦隔リンパ節及び気管中枢気管支に接する病変に対してコンベックス型EBUS-TBNAは勧められますか",
    3
  );

  assert.equal(retrieval.hits[0]?.cq, "CQ11");
  assert.match(retrieval.hits[0]?.title || "", /コンベックス型EBUS-TBNA/u);
});

test("retrieves CQ10 from a generic answer when the assistant clarified radial EBUS", async () => {
  const decision = decideNeedRag("検診で影があり詳しく調べる予定です", {
    historyMessages: [
      {
        role: "user",
        content: "症病変の景気監視整形にラジアル型EBUFは進められますか"
      },
      {
        role: "assistant",
        content:
          "経気管支鏡検査でのラジアル型EBUSのことですね。現在、どのような症状や検査結果があって、その検査を検討されているのでしょうか？"
      }
    ]
  });

  assert.equal(decision.needsRag, true);

  const retrieval = await retrieveGuidelineChunks(
    buildRetrievalQuery("検診で影があり詳しく調べる予定です", [
      {
        role: "user",
        content: "症病変の景気監視整形にラジアル型EBUFは進められますか"
      },
      {
        role: "assistant",
        content:
          "経気管支鏡検査でのラジアル型EBUSのことですね。現在、どのような症状や検査結果があって、その検査を検討されているのでしょうか？"
      }
    ]),
    3
  );

  assert.equal(retrieval.hits[0]?.cq, "CQ10");
  assert.match(retrieval.hits[0]?.title || "", /ラジアル型EBUS/u);
});

test("retrieves CQ2 from the short query about sputum cytology alone", async () => {
  const retrieval = await retrieveGuidelineChunks("喀痰細胞診は有用ですか", 3);

  assert.equal(retrieval.hits[0]?.cq, "CQ2");
});

test("retrieves PCI-specific CQs for a short PCI query without unrelated recommendation hits", async () => {
  const retrieval = await retrieveGuidelineChunks("PCIは勧められますか", 3);
  const cqIds = retrieval.hits.slice(0, 3).map((hit) => hit.cq);

  assert.deepEqual(new Set(cqIds), new Set(["CQ14", "CQ15", "CQ16"]));
});

test("retrieves guideline chunks for broad lung-cancer treatment overview questions", async () => {
  const retrieval = await retrieveGuidelineChunks("肺がん治療について教えてください", 4);

  assert.ok(retrieval.hits.length > 0);
  assert.equal(retrieval.diagnostics.queryIntent, "broad");
  assert.ok(retrieval.hits.filter((hit) => hit.docType === "souron").length >= 1);
  assert.match(
    retrieval.hits
      .map((hit) => `${hit.chapter || ""} ${hit.section || ""} ${hit.title || ""}`)
      .join("\n"),
    /薬物療法|周術期|放射線|術後補助療法|術前治療/u
  );
});

test("keeps recommendation questions CQ-first even when souron chunks exist", async () => {
  const retrieval = await retrieveGuidelineChunks("予防的全脳照射の線量は何ですか", 4);

  assert.equal(retrieval.diagnostics.queryIntent, "specific");
  assert.equal(retrieval.hits[0]?.docType, "cq");
  assert.equal(retrieval.hits[0]?.cq, "CQ15");
});

test("classifies glossary and methodology-style questions as meta intent", async () => {
  const retrieval = await retrieveGuidelineChunks("外科治療の略語を教えてください", 3);

  assert.equal(retrieval.diagnostics.queryIntent, "meta");
  assert.ok(retrieval.hits.length > 0);
  assert.match(retrieval.hits.map((hit) => hit.title || "").join("\n"), /外科治療|略語/u);
});

test("RAG system prompt explicitly prioritizes retrieved evidence over history and prior knowledge", () => {
  const prompt = buildRagSystemPrompt();

  assert.match(prompt, /現在与えられたガイドライン情報を最優先する/u);
  assert.match(prompt, /番号の若い情報ほど関連度が高いので、まず上位を重視する/u);
  assert.match(prompt, /薬剤名、比較、数値、条件は、与えられた情報にない限り足さない/u);
  assert.match(prompt, /ガイドラインに触れていないことを毎回ことわらない/u);
  assert.match(prompt, /『ガイドラインでは明記されていませんが』を定型句にしない/u);
});

test("RAG context includes rank and relevance metadata for retrieved chunks", () => {
  const context = buildRagContext([
    {
      chapter: "肺癌診療ガイドライン2025",
      section: "IV 非小細胞肺癌 薬物療法",
      title: "EGFR遺伝子変異陽性例の一次治療は？",
      cq: "CQ12",
      question: "EGFR遺伝子変異陽性例の一次治療は？",
      recommendation: "EGFR阻害薬を推奨する",
      recommendationStrength: "1",
      evidenceGrade: "B",
      explanation: "EGFR阻害薬で無増悪生存期間の延長が示されている",
      updatedAt: "2025-01-01",
      url: "https://example.com/cq12",
      score: 87
    }
  ]);

  assert.match(context, /rank: 1/u);
  assert.match(context, /relevanceScore: 87/u);
});
