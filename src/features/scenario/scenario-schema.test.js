import test from "node:test";
import assert from "node:assert/strict";
import { validateScenario } from "./scenario-schema.js";

function buildValidScenario() {
  return {
    id: "test-scenario",
    title: "テストシナリオ",
    globalDeviationReplies: { off_topic: "そうなんですね。" },
    nodes: [
      {
        id: "start",
        scene: 1,
        doctorLines: ["こんにちは。"],
        advance: [{ type: "patient_any", next: "ask" }]
      },
      {
        id: "ask",
        scene: 1,
        doctorLines: ["症状はありますか。"],
        advance: [
          { type: "patient_intent", intent: "no", keywords: ["ない"], next: "wait" },
          { type: "patient_intent", intent: "yes", keywords: ["ある"], next: "wait" }
        ]
      },
      {
        id: "wait",
        scene: 1,
        doctorLines: ["会場に伺います。"],
        advance: [{ type: "operator", branch: "A", next: "end" }]
      },
      {
        id: "end",
        scene: 2,
        doctorLines: ["ありがとうございました。"],
        advance: []
      }
    ],
    entryNode: "start"
  };
}

test("正常なシナリオJSONを受理する", () => {
  const { valid, errors } = validateScenario(buildValidScenario());
  assert.equal(valid, true, errors.join(", "));
});

test("必須フィールド欠落を拒否する", () => {
  const scenario = buildValidScenario();
  delete scenario.entryNode;
  scenario.nodes[0].doctorLines = [];

  const { valid, errors } = validateScenario(scenario);
  assert.equal(valid, false);
  assert.ok(errors.some((message) => message.includes("entryNode")));
  assert.ok(errors.some((message) => message.includes("doctorLines")));
});

test("未定義ノードへのnext参照を拒否する", () => {
  const scenario = buildValidScenario();
  scenario.nodes[0].advance[0].next = "missing-node";

  const { valid, errors } = validateScenario(scenario);
  assert.equal(valid, false);
  assert.ok(errors.some((message) => message.includes("missing-node")));
});

test("ノードID重複・operator branch欠落・intent keywords欠落を拒否する", () => {
  const scenario = buildValidScenario();
  scenario.nodes.push({ ...scenario.nodes[3], advance: [] });
  scenario.nodes[2].advance[0] = { type: "operator", next: "end" };
  scenario.nodes[1].advance[0] = { type: "patient_intent", intent: "no", next: "wait" };

  const { valid, errors } = validateScenario(scenario);
  assert.equal(valid, false);
  assert.ok(errors.some((message) => message.includes("重複")));
  assert.ok(errors.some((message) => message.includes("branch")));
  assert.ok(errors.some((message) => message.includes("keywords")));
});
