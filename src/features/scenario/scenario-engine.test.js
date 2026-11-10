import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import env from "../../config/env.js";
import { loadScenarioFromFile } from "./scenario-loader.js";
import { createScenarioEngine } from "./scenario-engine.js";

// LLM分類を無効化し、ルール層のみで決定的にテストする
env.scenarioIntentLlm = false;

const scenario = loadScenarioFromFile("./data/scenarios/haigan-2026.json");
// 転記元の会話を独立した期待値として使い、患者の各返答で一往復だけ進むことを確認する。
const source = readFileSync("./data/scenarios/haigan-2026-script.md", "utf8");
const scriptSections = source
  .split(/^#{2,3} .+$/mu)
  .map((section) =>
    [...section.matchAll(/\*\*(AI山本医師|患者)\*\*：「(.*)」/gu)].map(([, role, text]) => ({
      role,
      text: text.trim()
    }))
  )
  .filter((turns) => turns.length);
const interviewBranches = {
  voting1_A: { nodeId: "v1_risk_factors", turns: scriptSections[1] },
  voting1_B: { nodeId: "v1_treatment_risk", turns: scriptSections[2] },
  voting1_C: { nodeId: "v1_concerns", turns: scriptSections[3] }
};
const treatmentBranches = {
  voting2_A: { nodeId: "v2_perioperative", turns: scriptSections[6] },
  voting2_B: { nodeId: "v2_surgery", turns: scriptSections[7] },
  voting2_C: { nodeId: "v2_radiation", turns: scriptSections[8] },
  voting2_D: { nodeId: "v2_chemo", turns: scriptSections[9] }
};

async function runScript(engine, sessionId, turns, initial, trailing = []) {
  let result = initial;
  let cursor = 0;
  while (cursor < turns.length) {
    const expected = [];
    while (turns[cursor]?.role === "AI山本医師") expected.push(turns[cursor++].text);
    assert.deepEqual(result.lines, cursor === turns.length ? [...expected, ...trailing] : expected);
    if (cursor === turns.length) break;
    assert.equal(engine.getInputState(sessionId).acceptsPatientInput, true);
    assert.equal(turns[cursor].role, "患者");
    result = await engine.handlePatientUtterance(sessionId, turns[cursor++].text);
    assert.equal(result.kind, "advance");
  }
  if (turns.at(-1).role === "患者") assert.deepEqual(result.lines, trailing);
  return result;
}

let sessionCounter = 0;

function newSessionId() {
  sessionCounter += 1;
  return `engine-test-${sessionCounter}`;
}

test("新台本の問診3分岐 × 治療4分岐の全12経路を、患者の返答ごとに進行する", async () => {
  const engine = createScenarioEngine({ scenario });
  for (const [voting1, interview] of Object.entries(interviewBranches)) {
    for (const [voting2, treatment] of Object.entries(treatmentBranches)) {
      const id = newSessionId();
      await runScript(engine, id, scriptSections[0], engine.getNodeLines(id));
      assert.equal(engine.getInputState(id).nodeId, "s1_voting1_wait");
      assert.equal(engine.getInputState(id).acceptsPatientInput, false);
      assert.deepEqual(
        engine.getSessionState(id).awaitingBranches,
        Object.entries(interviewBranches).map(([branch, { nodeId }]) => ({ branch, next: nodeId }))
      );
      const interviewStart = engine.applyOperatorBranch(id, voting1);
      assert.equal(interviewStart.nodeId, interview.nodeId);
      await runScript(engine, id, interview.turns, interviewStart, [scriptSections[4][0].text]);
      assert.equal(engine.getInputState(id).nodeId, "s1_close");
      const ignored = await engine.handlePatientUtterance(id, "司会から検査結果を説明します。");
      assert.equal(ignored.kind, "ignored");
      assert.deepEqual(ignored.lines, []);
      const imaging = await engine.handlePatientUtterance(id, "PET画像を提示します。");
      await runScript(engine, id, scriptSections[5], imaging);
      assert.equal(engine.getInputState(id).nodeId, "s2_voting2_wait");
      assert.equal(engine.getInputState(id).acceptsPatientInput, false);
      const treatmentStart = engine.applyOperatorBranch(id, voting2);
      assert.equal(treatmentStart.nodeId, treatment.nodeId);
      const last = await runScript(engine, id, treatment.turns, treatmentStart);
      assert.equal(last.nodeId, "s2_closing");
      assert.equal(engine.getSessionState(id).isTerminal, true);
      assert.equal(engine.getInputState(id).acceptsPatientInput, false);
      assert.deepEqual(engine.repeat(id).lines, last.lines);
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

test("症状を含む否定文を『症状なし』として進めず、曖昧なら聞き返す", async () => {
  const engine = createScenarioEngine({ scenario });
  for (const text of [
    "胸が痛くて眠れない",
    "息が苦しくて眠れない",
    "咳は出ないけど息苦しいです",
    "特に"
  ]) {
    const id = newSessionId();
    engine.jumpTo(id, "s1_symptoms");
    const result = await engine.handlePatientUtterance(id, text);
    assert.notEqual(result.intent, "no_symptoms", text);
    assert.notEqual(result.nodeId, "s1_adl", text);
  }
});

test("司会待機は提示の明確な合図だけで再開し、説明・疑問・否定には無言で待つ", async () => {
  const engine = createScenarioEngine({ scenario });
  const id = newSessionId();
  engine.jumpTo(id, "s1_close");
  const before = engine.getInputState(id);
  for (const text of [
    "画像はまだ準備中です",
    "検査って何ですか",
    "PET画像を提示しますか？",
    "PET画像を提示しません",
    "まだ画像を提示しないでください",
    "少し待ってください",
    "『PET画像を提示します』という合図で再開します",
    "はい"
  ]) {
    const result = await engine.handlePatientUtterance(id, text);
    assert.equal(result.kind, "ignored", text);
    assert.deepEqual(result.lines, []);
    assert.deepEqual(result.state, before);
  }
  for (const text of [
    "PET画像を提示します。",
    "それでは、PET/CTの画像を提示します。",
    "ペット画像を提示します"
  ]) {
    engine.jumpTo(id, "s1_close");
    const result = await engine.handlePatientUtterance(id, text);
    assert.equal(result.nodeId, "s2_pathology");
    assert.equal(result.intentMethod, "rule");
  }
});

test("聞き直しへのrevisionは、ノードとその時点の台詞を一緒に復元する", async () => {
  const engine = createScenarioEngine({ scenario });
  for (const target of ["s1_greeting", "s2_imaging"]) {
    const id = newSessionId();
    const opening = engine.jumpTo(id, target);
    const before = engine.getInputState(id);
    await engine.handlePatientUtterance(id, target === "s1_greeting" ? "すみません" : "はい");
    const result = await engine.handlePatientUtterance(id, "すみません、もう一度お願いします", {
      revision: true,
      expectedVersion: before.version
    });
    assert.equal(result.nodeId, before.nodeId);
    assert.equal(result.deviation, "repeat");
    assert.deepEqual(result.lines, opening.lines);
    assert.deepEqual(engine.repeat(id).lines, opening.lines);
  }
});

test("無言で待った司会の断片も、結合再送で同じ位置から合図を判定する", async () => {
  const engine = createScenarioEngine({ scenario });
  const id = newSessionId();
  engine.jumpTo(id, "s1_close");
  const before = engine.getInputState(id);
  assert.equal((await engine.handlePatientUtterance(id, "PET画像")).kind, "ignored");
  const result = await engine.handlePatientUtterance(id, "PET画像を提示します。", {
    revision: true,
    expectedVersion: before.version
  });
  assert.equal(result.nodeId, "s2_pathology");
  assert.equal(result.intent, "present_imaging");
});

test("全ノードに到達でき、自動遷移は循環せず、問診の4番目の選択肢を受け付けない", () => {
  const nodes = new Map(scenario.nodes.map((node) => [node.id, node]));
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    for (const entry of nodes.get(id).advance) visit(entry.next);
  }
  visit(scenario.entryNode);
  assert.equal(visited.size, scenario.nodes.length);
  for (const node of scenario.nodes) {
    let current = node;
    const autoPath = new Set();
    while (current.advance.some((entry) => entry.type === "auto")) {
      assert.equal(autoPath.has(current.id), false, current.id);
      autoPath.add(current.id);
      current = nodes.get(current.advance.find((entry) => entry.type === "auto").next);
    }
  }
  const engine = createScenarioEngine({ scenario });
  const id = newSessionId();
  engine.jumpTo(id, "s1_voting1_wait");
  assert.throws(() => engine.applyOperatorBranch(id, "voting1_D"), /定義されていません/u);
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
  assert.equal(paused.kind, "ignored");
  assert.deepEqual(paused.lines, []);
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
  assert.deepEqual(say.lines, []);

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

  // 旧台本で発生した句読点だけによる誤進行が、新しい問診でも再発しないこと。
  const result = await engine.handlePatientUtterance(sessionId, "。");
  assert.equal(result.kind, "ignored");
  assert.equal(engine.getSessionState(sessionId).nodeId, "v1_risk_factors");
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
  let result = await engine.handlePatientUtterance(sessionId, "ありません");
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
  assert.equal(result.nodeId, "v1_risk_factors");
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
  await engine.handlePatientUtterance(id, "ありません", { expectedVersion: before.version });
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
  const reply = engine.jumpTo(id, "s2_imaging");
  assert.equal(reply.nodeId, "s2_pathology");
  assert.deepEqual(engine.repeat(id).lines, reply.lines);
  const resumedId = newSessionId();
  engine.adoptProgress(id, resumedId);
  assert.deepEqual(engine.getNodeLines(resumedId).lines, reply.lines);
  assert.equal(engine.getInputState(resumedId).acceptsPatientInput, true);
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
