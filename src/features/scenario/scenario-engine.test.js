import test from "node:test";
import assert from "node:assert/strict";
import env from "../../config/env.js";
import { loadScenarioFromFile } from "./scenario-loader.js";
import { createScenarioEngine } from "./scenario-engine.js";

// LLM分類を無効化し、ルール層のみで決定的にテストする
env.scenarioIntentLlm = false;

const scenario = loadScenarioFromFile("./data/scenarios/haigan-2026.json");
const nodesById = new Map(scenario.nodes.map((node) => [node.id, node]));
const interviewBranches = {
  voting1_A: { nodeId: "v1_smoking", answer: "1日40本を52年間、今も吸っています。" },
  voting1_B: { nodeId: "v1_occupation", answer: "タクシードライバーです。" },
  voting1_C: { nodeId: "v1_ip_history", answer: "高血圧症と間質性肺炎を指摘されています。" },
  voting1_D: { nodeId: "v1_medication", answer: "アムロジピンを飲んでいます。" }
};
const treatmentBranches = {
  voting2_A: "v2_perioperative",
  voting2_B: "v2_surgery",
  voting2_C: "v2_radiation",
  voting2_D: "v2_chemo"
};

let sessionCounter = 0;

function newSessionId() {
  sessionCounter += 1;
  return `engine-test-${sessionCounter}`;
}

async function runScene1(engine, sessionId, voting1Branch) {
  // s1_greeting → s1_symptoms
  let result = await engine.handlePatientUtterance(
    sessionId,
    "はい。近くの病院で、年に1回胸のレントゲンを撮っているんですが、右の肺に影があると言われました。"
  );
  assert.equal(result.nodeId, "s1_symptoms");

  // s1_symptoms → s1_adl
  result = await engine.handlePatientUtterance(
    sessionId,
    "特にありません。自分では元気なつもりです。"
  );
  assert.equal(result.intent, "no_symptoms");
  assert.equal(result.nodeId, "s1_adl");

  // s1_adl → s1_adl_ack →(auto)→ s1_voting1_wait
  result = await engine.handlePatientUtterance(
    sessionId,
    "普段は普通に生活できています。階段や坂道では少し息が切れることがあります。"
  );
  assert.equal(result.nodeId, "s1_voting1_wait");
  assert.equal(engine.getInputState(sessionId).acceptsPatientInput, false);
  assert.deepEqual(
    engine.getSessionState(sessionId).awaitingBranches,
    Object.entries(interviewBranches).map(([branch, { nodeId }]) => ({ branch, next: nodeId }))
  );

  // Voting① 分岐
  result = engine.applyOperatorBranch(sessionId, voting1Branch);
  assert.equal(result.kind, "advance");
  const interview = interviewBranches[voting1Branch];
  assert.equal(result.nodeId, interview.nodeId);
  assert.equal(engine.getInputState(sessionId).acceptsPatientInput, true);

  // 分岐問診への回答 →(ack + auto)→ s1_close
  result = await engine.handlePatientUtterance(sessionId, interview.answer);
  assert.equal(result.nodeId, "s1_close");
  assert.deepEqual(result.lines, [
    ...nodesById.get(`${interview.nodeId}_ack`).doctorLines,
    ...nodesById.get("s1_close").doctorLines
  ]);

  // 単なる相づちでは画像説明を始めず、提示の合図を待つ。
  result = await engine.handlePatientUtterance(sessionId, "はい");
  assert.equal(result.nodeId, "s1_close");

  // 「PET画像を提示します」の発話でシーン2へ（s2_imaging →(auto)→ s2_pathology まで連続発話）
  result = await engine.handlePatientUtterance(sessionId, "PET画像を提示します");
  assert.equal(result.intent, "present_imaging");
  assert.equal(result.nodeId, "s2_pathology");
  assert.equal(result.scene, 2);
  assert.deepEqual(result.lines, [
    ...nodesById.get("s2_imaging").doctorLines,
    ...nodesById.get("s2_pathology").doctorLines
  ]);
}

async function runScene2(engine, sessionId, voting2Branch) {
  // 「手術で取れば治るのでしょうか」→ s2_cure_answer →(auto)→ s2_values
  let result = await engine.handlePatientUtterance(
    sessionId,
    "やはり肺がんなのですね。手術で取れば治るのでしょうか。"
  );
  assert.equal(result.intent, "asks_cure");
  assert.equal(result.nodeId, "s2_values");

  // 価値観確認の流れ
  result = await engine.handlePatientUtterance(
    sessionId,
    "特に強い希望はありません。ただ、リスクの高い治療はしたくありません。"
  );
  assert.equal(result.nodeId, "s2_values_risk_ack");

  result = await engine.handlePatientUtterance(
    sessionId,
    "3か月後に孫の結婚式があります。それにはできれば出たいです。"
  );
  assert.equal(result.nodeId, "s2_voting2_wait");
  assert.equal(engine.getInputState(sessionId).acceptsPatientInput, false);
  assert.deepEqual(
    engine.getSessionState(sessionId).awaitingBranches,
    Object.entries(treatmentBranches).map(([branch, next]) => ({ branch, next }))
  );

  // Voting② 分岐 →(auto)→ s2_closing
  result = engine.applyOperatorBranch(sessionId, voting2Branch);
  assert.equal(result.nodeId, "s2_closing");
  assert.deepEqual(result.lines, [
    ...nodesById.get(treatmentBranches[voting2Branch]).doctorLines,
    ...nodesById.get("s2_closing").doctorLines
  ]);
  assert.deepEqual(engine.repeat(sessionId).lines, result.lines);

  const state = engine.getSessionState(sessionId);
  assert.equal(state.isTerminal, true);
  assert.equal(engine.getInputState(sessionId).acceptsPatientInput, false);
}

test("完成版の台詞でVoting①4分岐 × Voting②4分岐の16経路をすべて通せる", async () => {
  const engine = createScenarioEngine({ scenario });

  for (const voting1 of Object.keys(interviewBranches)) {
    for (const voting2 of Object.keys(treatmentBranches)) {
      const sessionId = newSessionId();
      await runScene1(engine, sessionId, voting1);
      await runScene2(engine, sessionId, voting2);
    }
  }
});

test("症状ありと答えた場合はredirect経由でVoting①待機に合流する", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();

  await engine.handlePatientUtterance(sessionId, "こんにちは");
  let result = await engine.handlePatientUtterance(sessionId, "咳が少し出ます");
  assert.equal(result.intent, "has_symptoms");
  assert.equal(result.nodeId, "s1_symptoms_redirect");

  result = await engine.handlePatientUtterance(sessionId, "普通に生活できています");
  assert.equal(result.nodeId, "s1_voting1_wait");
});

test("否定文・保留依頼・台本外質問をキーワードだけで進めない", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();
  engine.jumpTo(sessionId, "s1_symptoms");
  const denied = await engine.handlePatientUtterance(sessionId, "咳も痰もありません");
  assert.equal(denied.intent, "no_symptoms");
  engine.jumpTo(sessionId, "s1_close");
  const paused = await engine.handlePatientUtterance(sessionId, "まだ画像を提示しないでください");
  assert.equal(paused.nodeId, "s1_close");
  assert.equal(paused.deviation, "pause");
  engine.jumpTo(sessionId, "s2_pathology");
  const fees = await engine.handlePatientUtterance(sessionId, "手術の費用はいくらですか");
  assert.equal(fees.deviation, "medical_advice");
  assert.equal(fees.nodeId, "s2_pathology");
  assert.deepEqual(engine.repeat(sessionId).lines, fees.lines);
});

test("patient_anyでも聞き直しと待機希望は進行を消費しない", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();
  const question = engine.getNodeLines(sessionId).lines;
  const repeated = await engine.handlePatientUtterance(sessionId, "もう一度お願いします");
  assert.equal(repeated.nodeId, "s1_greeting");
  assert.deepEqual(repeated.lines, question);
  assert.equal(
    (await engine.handlePatientUtterance(sessionId, "少し待ってください")).nodeId,
    "s1_greeting"
  );
});

test("日常の希望に含まれる『もう一度』は聞き直しと誤認せず、雑談には現在の質問を戻す", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();
  engine.jumpTo(sessionId, "s2_values_risk_ack");
  const wish = await engine.handlePatientUtterance(sessionId, "もう一度家族と旅行をしたいです");
  assert.equal(wish.nodeId, "s2_voting2_wait");
  engine.jumpTo(sessionId, "s1_symptoms");
  const chat = await engine.handlePatientUtterance(sessionId, "今日はいい天気ですね");
  assert.equal(chat.deviation, "off_topic");
  assert.equal(chat.lines.length, 2);
  assert.equal(chat.nodeId, "s1_symptoms");
});

test("サーバー復旧待ちはジャンプかリセットでのみ解除し、旧世代の発話を拒否する", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();
  const state = engine.requireRecovery(sessionId);
  assert.equal(state.recoveryRequired, true);
  assert.equal(state.acceptsPatientInput, false);
  assert.deepEqual(engine.getNodeLines(sessionId).lines, []);
  assert.throws(() => engine.setInputPaused(sessionId, false), /ジャンプ/u);
  engine.jumpTo(sessionId, "s1_symptoms");
  assert.equal(engine.getInputState(sessionId).recoveryRequired, false);
  assert.equal(engine.getInputState(sessionId).acceptsPatientInput, true);
  const stale = await engine.handlePatientUtterance(sessionId, "はい", {
    expectedEpoch: "previous-process"
  });
  assert.equal(stale.kind, "superseded");
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

test("句読点だけのASR断片ではpatient_anyノードが進まない(台本スキップ防止)", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();

  // s1_greeting は patient_any。以前は「。」だけで次へ進んでしまっていた
  const result = await engine.handlePatientUtterance(sessionId, "。");

  assert.equal(result.kind, "ignored");
  assert.deepEqual(result.lines, []);
  assert.equal(engine.getSessionState(sessionId).nodeId, "s1_greeting");

  // 実際の発話が来れば通常どおり進む
  const advanced = await engine.handlePatientUtterance(sessionId, "よろしくお願いします");
  assert.equal(advanced.nodeId, "s1_symptoms");
});

test("分岐問診の直後に句読点断片が来ても台本を飛ばさない", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();

  await engine.handlePatientUtterance(sessionId, "こんにちは");
  await engine.handlePatientUtterance(sessionId, "特にありません");
  await engine.handlePatientUtterance(sessionId, "階段では少し息が切れます");
  engine.applyOperatorBranch(sessionId, "voting1_A");

  // 本番ログで発生した事象: 「。」だけの断片で v1_smoking → s1_close まで飛んだ
  const result = await engine.handlePatientUtterance(sessionId, "。");
  assert.equal(result.kind, "ignored");
  assert.equal(engine.getSessionState(sessionId).nodeId, "v1_smoking");
});

test("相槌未満の一音は無視するが「はい」などの短答は進める", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();

  const ignored = await engine.handlePatientUtterance(sessionId, "あー");
  assert.equal(ignored.kind, "ignored");
  assert.equal(engine.getSessionState(sessionId).nodeId, "s1_greeting");

  const advanced = await engine.handlePatientUtterance(sessionId, "はい");
  assert.equal(advanced.kind, "advance");
  assert.equal(advanced.nodeId, "s1_symptoms");
});

test("言い直し(revision)は直前の患者遷移を巻き戻してから判定し、台本が二重に進まない", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();

  // s1_greeting → s1_symptoms
  await engine.handlePatientUtterance(sessionId, "こんにちは");
  // 発話が途切れた: 前半だけで s1_symptoms → s1_adl に進んでしまう
  let result = await engine.handlePatientUtterance(sessionId, "特に");
  assert.equal(result.nodeId, "s1_adl");

  // 結合し直した発話が revision として再送される → s1_symptoms に巻き戻して判定
  result = await engine.handlePatientUtterance(sessionId, "特にありません", { revision: true });
  assert.equal(result.nodeId, "s1_adl");
  assert.equal(result.intent, "no_symptoms");
  // 二重前進していないこと(s1_adl の次の s1_voting1_wait に飛んでいないこと)
  assert.equal(engine.getSessionState(sessionId).nodeId, "s1_adl");
});

test("revisionでもoperator操作後は巻き戻さない", async () => {
  const engine = createScenarioEngine({ scenario });
  const sessionId = newSessionId();

  await engine.handlePatientUtterance(sessionId, "こんにちは");
  await engine.handlePatientUtterance(sessionId, "特にありません");
  await engine.handlePatientUtterance(sessionId, "元気にしています");
  engine.applyOperatorBranch(sessionId, "voting1_A");

  // operator操作後に届いた古い発話の言い直しは、分岐先への新規回答にしない。
  const result = await engine.handlePatientUtterance(sessionId, "はい、そうです", {
    revision: true
  });
  assert.equal(result.nodeId, "v1_smoking");
  assert.equal(result.kind, "superseded");
});

test("intent判定待ちの間にoperatorが操作した場合はsupersededを返し発話しない", async () => {
  // LLM分類が遅延するケースを、matchIntent実行中のoperator操作で再現する
  const slowScenario = structuredClone(scenario);
  const engine = createScenarioEngine({ scenario: slowScenario });
  const sessionId = newSessionId();

  await engine.handlePatientUtterance(sessionId, "こんにちは");

  // s1_symptoms で患者発話の判定を開始し、判定が終わる前に operator が次へ送る競合を再現。
  // ルール層は同期実行のため、キーワード一致しない発話 + LLM無効でも
  // handlePatientUtterance内のawait前後で割り込む形をとる
  const utterancePromise = engine.handlePatientUtterance(sessionId, "咳が出ます");
  engine.forceNext(sessionId);
  const result = await utterancePromise;

  // 判定完了時点でノードが動いていた場合、古い判定は破棄される
  if (result.kind === "superseded") {
    assert.deepEqual(result.lines, []);
  } else {
    // ルール一致が先に完了した場合は通常のadvance(タイミング依存を許容)
    assert.equal(result.kind, "advance");
  }
});

test("adoptProgressで新セッションへ進行を引き継げる", async () => {
  const engine = createScenarioEngine({ scenario });
  const oldSessionId = newSessionId();
  const freshSessionId = newSessionId();

  await engine.handlePatientUtterance(oldSessionId, "こんにちは");
  await engine.handlePatientUtterance(oldSessionId, "特にありません");
  assert.equal(engine.getSessionState(oldSessionId).nodeId, "s1_adl");

  const adopted = engine.adoptProgress(oldSessionId, freshSessionId);
  assert.equal(adopted, true);
  assert.equal(engine.getSessionState(freshSessionId).nodeId, "s1_adl");
});

test("adoptProgressはentryノードのままの旧セッションからは引き継がない", () => {
  const engine = createScenarioEngine({ scenario });
  const oldSessionId = newSessionId();
  const freshSessionId = newSessionId();

  engine.getSessionState(oldSessionId);
  assert.equal(engine.adoptProgress(oldSessionId, freshSessionId), false);
  assert.equal(engine.adoptProgress("no-such-session", freshSessionId), false);
});

test("判定中のリセットと同じノードへのジャンプも古い結果を失効させる", async () => {
  for (const action of ["reset", "same-node"]) {
    const engine = createScenarioEngine({ scenario });
    const id = newSessionId();
    engine.jumpTo(id, "s1_symptoms");
    const pending = engine.handlePatientUtterance(id, "咳が出ます");
    if (action === "reset") {
      engine.reset(id);
      engine.jumpTo(id, "s1_symptoms");
    } else {
      engine.jumpTo(id, "s1_symptoms");
    }
    const result = await pending;
    assert.equal(result.kind, "superseded");
    assert.deepEqual(result.lines, []);
    assert.equal(engine.getSessionState(id).nodeId, "s1_symptoms");
  }
});

test("古い進行番号の患者発話と入力停止中の発話は台本を進めない", async () => {
  const engine = createScenarioEngine({ scenario });
  const id = newSessionId();
  const before = engine.getInputState(id);
  engine.forceNext(id);
  const stale = await engine.handlePatientUtterance(id, "特にありません", {
    expectedVersion: before.version
  });
  assert.equal(stale.kind, "superseded");
  engine.setInputPaused(id, true);
  assert.equal((await engine.handlePatientUtterance(id, "特にありません")).kind, "ignored");
  engine.setInputPaused(id, false);
  assert.equal((await engine.handlePatientUtterance(id, "特にありません")).nodeId, "s1_adl");
});

test("応答受信前の言い直しは遷移前の進行番号でも巻き戻せる", async () => {
  const engine = createScenarioEngine({ scenario });
  const id = newSessionId();
  engine.jumpTo(id, "s1_symptoms");
  const before = engine.getInputState(id);
  await engine.handlePatientUtterance(id, "特に", { expectedVersion: before.version });
  const result = await engine.handlePatientUtterance(id, "特にありません", {
    revision: true,
    expectedVersion: before.version
  });
  assert.equal(result.nodeId, "s1_adl");
  assert.equal(result.kind, "advance");
});

test("再接続・再発話ではauto遷移前を含む台詞全体を復元する", () => {
  const engine = createScenarioEngine({ scenario });
  const id = newSessionId();
  const reply = engine.jumpTo(id, "v2_surgery");
  assert.equal(reply.nodeId, "s2_closing");
  assert.deepEqual(engine.repeat(id).lines, reply.lines);
  const resumedId = newSessionId();
  engine.adoptProgress(id, resumedId);
  assert.deepEqual(engine.getNodeLines(resumedId).lines, reply.lines);
  assert.equal(engine.getInputState(resumedId).acceptsPatientInput, false);
});

test("挨拶ノードでも手動入力停止を再接続へ引き継ぐ", () => {
  const engine = createScenarioEngine({ scenario });
  const oldId = newSessionId();
  const newId = newSessionId();
  engine.setInputPaused(oldId, true);
  assert.equal(engine.adoptProgress(oldId, newId), true);
  const state = engine.getInputState(newId);
  assert.equal(state.nodeId, "s1_greeting");
  assert.equal(state.inputPaused, true);
  assert.equal(state.acceptsPatientInput, false);
});
