import test from "node:test";
import assert from "node:assert/strict";
import env from "../../config/env.js";
import { loadScenarioFromFile } from "./scenario-loader.js";
import { createScenarioEngine } from "./scenario-engine.js";

// LLM分類を無効化し、ルール層のみで決定的にテストする
env.scenarioIntentLlm = false;

const scenario = loadScenarioFromFile("./data/scenarios/haigan-2026.json");

let sessionCounter = 0;

function newSessionId() {
  sessionCounter += 1;
  return `engine-test-${sessionCounter}`;
}

async function runScene1(engine, sessionId, voting1Branch) {
  // s1_greeting → s1_symptoms
  let result = await engine.handlePatientUtterance(sessionId, "こんにちは");
  assert.equal(result.nodeId, "s1_symptoms");

  // s1_symptoms → s1_adl
  result = await engine.handlePatientUtterance(sessionId, "特にありません");
  assert.equal(result.intent, "no_symptoms");
  assert.equal(result.nodeId, "s1_adl");

  // s1_adl → s1_adl_ack →(auto)→ s1_voting1_wait
  result = await engine.handlePatientUtterance(sessionId, "坂道で少し息切れがあります");
  assert.equal(result.nodeId, "s1_voting1_wait");

  // Voting① 分岐
  result = engine.applyOperatorBranch(sessionId, voting1Branch);
  assert.equal(result.kind, "advance");

  // 分岐問診への回答 →(ack + auto)→ s1_close
  result = await engine.handlePatientUtterance(sessionId, "はい、そのとおりです");
  assert.equal(result.nodeId, "s1_close");

  // シーン2へ（s2_imaging →(auto)→ s2_pathology まで連続発話）
  result = engine.applyOperatorBranch(sessionId, "scene2");
  assert.equal(result.nodeId, "s2_pathology");
  assert.equal(result.scene, 2);
}

async function runScene2(engine, sessionId, voting2Branch) {
  // 「手術で取れば治るのでしょうか」→ s2_cure_answer →(auto)→ s2_values
  let result = await engine.handlePatientUtterance(
    sessionId,
    "やはり肺がんなのですね。手術で取れば治るのでしょうか"
  );
  assert.equal(result.intent, "asks_cure");
  assert.equal(result.nodeId, "s2_values");

  // 価値観確認の流れ
  result = await engine.handlePatientUtterance(sessionId, "リスクの高い治療は避けたいです");
  assert.equal(result.nodeId, "s2_values_risk_ack");

  result = await engine.handlePatientUtterance(sessionId, "孫の結婚式に出たいです");
  assert.equal(result.nodeId, "s2_voting2_wait");

  // Voting② 分岐 →(auto)→ s2_closing
  result = engine.applyOperatorBranch(sessionId, voting2Branch);
  assert.equal(result.nodeId, "s2_closing");

  const state = engine.getSessionState(sessionId);
  assert.equal(state.isTerminal, true);
}

test("Voting①3分岐 × Voting②3分岐の9経路をすべて通せる", async () => {
  const engine = createScenarioEngine({ scenario });

  for (const voting1 of ["voting1_A", "voting1_B", "voting1_C"]) {
    for (const voting2 of ["voting2_A", "voting2_B", "voting2_C"]) {
      const sessionId = newSessionId();
      await runScene1(engine, sessionId, voting1);
      await runScene2(engine, sessionId, voting2);
    }
  }
});

test("operator遷移待ちノードで患者が発話するとhold応答を返し、状態は動かない", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();

  await engine.handlePatientUtterance(sessionId, "こんにちは");
  await engine.handlePatientUtterance(sessionId, "特にありません");
  await engine.handlePatientUtterance(sessionId, "少しあります");

  const result = await engine.handlePatientUtterance(sessionId, "どうすればいいですか");
  assert.equal(result.kind, "hold");
  assert.equal(engine.getSessionState(sessionId).nodeId, "s1_voting1_wait");
});

test("intentノードで台本外発話が来ると定型応答+質問再提示で復帰する", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();

  await engine.handlePatientUtterance(sessionId, "こんにちは");
  const result = await engine.handlePatientUtterance(sessionId, "あと何年生きられますか");

  assert.equal(result.kind, "deviation");
  assert.equal(result.deviation, "medical_advice");
  assert.equal(result.nodeId, "s1_symptoms");
  assert.equal(
    result.lines.at(-1),
    "現在、咳、痰、血痰、息切れ、胸の痛み、発熱、体重減少などはありますか。"
  );
  assert.equal(engine.getSessionState(sessionId).nodeId, "s1_symptoms");
});

test("operator遷移ノード以外でのbranchは409で拒否される", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();

  assert.throws(
    () => engine.applyOperatorBranch(sessionId, "voting1_A"),
    /operator遷移を受け付けません/u
  );

  try {
    engine.applyOperatorBranch(sessionId, "voting1_A");
  } catch (error) {
    assert.equal(error.status, 409);
  }
});

test("jump・reset・sayで進行を制御できる", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();

  const jumped = engine.jumpTo(sessionId, "s2_voting2_wait");
  assert.equal(jumped.nodeId, "s2_voting2_wait");

  const say = engine.getNodeLines(sessionId, null);
  assert.equal(say.nodeId, "s2_voting2_wait");
  assert.ok(say.lines.length > 0);

  const resetResult = engine.reset(sessionId);
  assert.equal(resetResult.nodeId, "s1_greeting");
  assert.equal(engine.getSessionState(sessionId).nodeId, "s1_greeting");
});

test("終端ノードで患者が発話するとclosed応答を返す", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();

  engine.jumpTo(sessionId, "s2_closing");
  const result = await engine.handlePatientUtterance(sessionId, "ありがとうございました");
  assert.equal(result.deviation, "closed");
});
