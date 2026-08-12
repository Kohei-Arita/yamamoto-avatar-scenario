import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLlmTranscriptNormalization,
  buildMedicalTranscriptNormalizationMessages,
  parseMedicalTranscriptNormalizationResponse
} from "./llm-transcript-normalizer.js";

test("builds transcript-normalization prompt with raw text and rule-based candidate", () => {
  const messages = buildMedicalTranscriptNormalizationMessages("予防的全能照射", {
    candidateText: "予防的全脳照射",
    historyMessages: [{ role: "user", content: "放射線治療について聞きたいです" }]
  });

  assert.equal(messages.length, 2);
  assert.match(messages[1]?.content || "", /音声認識原文:\n予防的全能照射/u);
  assert.match(messages[1]?.content || "", /ルールベース補正候補:\n予防的全脳照射/u);
  assert.match(messages[1]?.content || "", /放射線治療について聞きたいです/u);
});

test("parses strict JSON transcript-normalization responses", () => {
  const parsed = parseMedicalTranscriptNormalizationResponse(
    '{"normalizedText":"予防的全脳照射の勧められる線量は何ですか"}',
    "fallback"
  );

  assert.equal(parsed, "予防的全脳照射の勧められる線量は何ですか");
});

test("parses fenced JSON transcript-normalization responses", () => {
  const parsed = parseMedicalTranscriptNormalizationResponse(
    '```json\n{"normalizedText":"PCIは勧められますか"}\n```',
    "fallback"
  );

  assert.equal(parsed, "PCIは勧められますか");
});

test("falls back when transcript-normalization response is invalid", () => {
  const parsed = parseMedicalTranscriptNormalizationResponse("not json", "fallback");

  assert.equal(parsed, "fallback");
});

test("records an LLM normalization repair when the text changes", () => {
  const transcript = applyLlmTranscriptNormalization(
    {
      rawText: "予防的全能照射を進め合える占領は何ですか",
      normalizedText: "予防的全能照射を進め合える占領は何ですか",
      repairs: [],
      changed: false
    },
    "予防的全脳照射を勧められる線量は何ですか",
    "gpt-4.1-mini"
  );

  assert.equal(transcript.normalizedText, "予防的全脳照射を勧められる線量は何ですか");
  assert.equal(transcript.repairs.at(-1)?.type, "llm_medical_term_normalization");
  assert.deepEqual(transcript.llmNormalization, {
    attempted: true,
    changed: true,
    model: "gpt-4.1-mini"
  });
});
