import assert from "node:assert/strict";
import test from "node:test";
import env from "../../config/env.js";
import { registerKnownSessionId } from "./session-registry.js";

env.scenarioIntentLlm = false;
env.dialogueLlmTranscriptNormalizationEnabled = false;
env.scenarioSpeechMode = "fixed";
env.operatorToken = "input-timeout-test-token";
const { default: app } = await import("../../app.js");
const fetch = (url, options = {}) =>
  globalThis.fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${env.operatorToken}`, ...options.headers }
  });
let server;
let baseUrl;

test.before(async () => {
  server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

async function post(path, body, operator = false) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(operator ? { authorization: `Bearer ${env.operatorToken}` } : {})
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, ...(await response.json()) };
}

async function bind(sessionId) {
  registerKnownSessionId(sessionId);
  await post("/api/dialogue/session", { sessionId });
  return post("/api/operator/reset", { sessionId }, true);
}

test("聞き取り上限による停止を操作画面とSSEへ反映し、音声入力の再開で復帰する", async () => {
  const sessionId = "timeout-operator-resume";
  const initial = await bind(sessionId);
  const connection = await fetch(`${baseUrl}/api/dialogue/events?sessionId=${sessionId}`);
  const reader = connection.body.getReader();
  try {
    await reader.read(); // connected
    const stopped = await post("/api/dialogue/input-timeout", {
      sessionId,
      expectedVersion: initial.state.version
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.state.nodeId, initial.state.nodeId);
    assert.equal(stopped.state.inputPaused, true);
    assert.equal(stopped.state.acceptsPatientInput, false);
    const { value } = await reader.read();
    const event = new TextDecoder().decode(value);
    assert.match(event, /event: scenario_state/);
    assert.match(event, /"inputPaused":true/);

    const operator = await fetch(`${baseUrl}/api/operator/state?sessionId=${sessionId}`, {
      headers: { authorization: `Bearer ${env.operatorToken}` }
    }).then((response) => response.json());
    assert.equal(operator.state.inputPaused, true);
    assert.equal(operator.logs.at(-1).kind, "input_timeout");

    const resumed = await post(
      "/api/operator/input",
      {
        sessionId,
        expectedVersion: stopped.state.version,
        paused: false
      },
      true
    );
    assert.equal(resumed.status, 200);
    assert.equal(resumed.state.nodeId, initial.state.nodeId);
    assert.equal(resumed.state.acceptsPatientInput, true);
  } finally {
    await reader.cancel();
  }
});

test("古い受付期限の通知でオペレーターが移動した先を停止しない", async () => {
  const sessionId = "timeout-race";
  const initial = await bind(sessionId);
  const moved = await post("/api/operator/jump", { sessionId, nodeId: "s1_symptoms" }, true);
  const stale = await post("/api/dialogue/input-timeout", {
    sessionId,
    expectedVersion: initial.state.version
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.state.version, moved.state.version);
  assert.equal(stale.state.nodeId, "s1_symptoms");
  assert.equal(stale.state.inputPaused, false);
});

test("登録済みセッションと進行番号を要求し、Voting中の期限通知では状態を変えない", async () => {
  const sessionId = "timeout-validation";
  await bind(sessionId);
  assert.equal((await post("/api/dialogue/input-timeout", { sessionId })).status, 400);
  assert.equal(
    (await post("/api/dialogue/input-timeout", { sessionId: "unknown", expectedVersion: 0 }))
      .status,
    403
  );
  const voting = await post("/api/operator/jump", { sessionId, nodeId: "s1_voting1_wait" }, true);
  const stopped = await post("/api/dialogue/input-timeout", {
    sessionId,
    expectedVersion: voting.state.version
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.state.version, voting.state.version);
  assert.equal(stopped.state.inputPaused, false);
  assert.equal(stopped.state.acceptsPatientInput, false);
});

test("会場の発話通知・異常を操作画面へ反映し、古い番号・サーバー世代の通知は破棄する", async () => {
  const sessionId = "playback-telemetry";
  const { state } = await bind(sessionId);
  const report = (body) =>
    post("/api/dialogue/playback", { sessionId, expectedEpoch: state.epoch, ...body });
  assert.equal((await report({ status: "speaking", sequence: 1 })).applied, true);
  assert.equal(
    (await report({ status: "error", message: "発話終了を確認できません", sequence: 3 })).applied,
    true
  );
  assert.equal((await report({ status: "idle", sequence: 2 })).applied, false);
  assert.equal(
    (await report({ status: "idle", sequence: 4, expectedEpoch: "old-process" })).applied,
    false
  );
  assert.equal((await report({ status: "idle", sequence: -1 })).status, 400);
  const operator = await fetch(`${baseUrl}/api/operator/state?sessionId=${sessionId}`).then(
    (response) => response.json()
  );
  assert.equal(operator.state.playback.status, "error");
  assert.equal(operator.state.playback.sequence, 3);
  assert.equal(operator.logs.at(-1).kind, "playback_error");
  assert.equal((await report({ status: "idle", sequence: 4 })).applied, true);
});
