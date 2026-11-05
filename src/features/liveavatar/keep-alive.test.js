import assert from "node:assert/strict";
import test from "node:test";
import { postKeepAlive } from "./liveavatar.controller.js";
import { createScenarioEngine } from "../scenario/scenario-engine.js";
import { loadScenarioFromFile } from "../scenario/scenario-loader.js";
import { registerKnownSessionId } from "../dialogue/session-registry.js";

const scenario = loadScenarioFromFile("./data/scenarios/haigan-2026.json");
const MINUTE = 60_000;

function mockUpstream(t, status = 200) {
  return t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.liveavatar.com/v1/sessions/keep-alive");
    assert.equal(options.method, "POST");
    return new Response(JSON.stringify({ data: {} }), { status });
  });
}

async function keepAlive(sessionId) {
  const response = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  await postKeepAlive({ body: { sessionId } }, response);
  return response;
}

test("15分の投票待ちでも接続維持が成功していれば進行と手動入力停止を引き継ぐ", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const upstream = mockUpstream(t);
  const engine = createScenarioEngine({ scenario });
  const sessionId = "long-voting-heartbeat";
  registerKnownSessionId(sessionId);
  engine.jumpTo(sessionId, "s2_voting2_wait");
  engine.setInputPaused(sessionId, true);
  const before = engine.getInputState(sessionId);

  for (let minute = 1; minute <= 15; minute += 1) {
    t.mock.timers.tick(MINUTE);
    const response = await keepAlive(sessionId);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(engine.getInputState(sessionId), before, "接続維持では台本を動かさない");
  }
  assert.equal(upstream.mock.callCount(), 15);
  for (const call of upstream.mock.calls) {
    assert.deepEqual(JSON.parse(call.arguments[1].body), { session_id: sessionId });
  }
  assert.equal(engine.adoptProgress(sessionId, "long-voting-reconnected"), true);
  const restored = engine.getSessionState("long-voting-reconnected");
  assert.equal(restored.nodeId, "s2_voting2_wait");
  assert.equal(restored.inputPaused, true);
  assert.equal(restored.acceptsPatientInput, false);
  assert.deepEqual(restored.awaitingBranches, engine.getSessionState(sessionId).awaitingBranches);
});

for (const failedHeartbeat of [false, true]) {
  test(`${failedHeartbeat ? "接続維持の失敗" : "操作画面での状態確認"}だけでは古い公演の引き継ぎ期限を延長しない`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1000 });
    const upstream = mockUpstream(t, 503);
    const engine = createScenarioEngine({ scenario });
    const sessionId = `expired-voting-${failedHeartbeat}`;
    registerKnownSessionId(sessionId);
    engine.jumpTo(sessionId, "s1_voting1_wait");
    t.mock.timers.tick(9 * MINUTE);
    assert.equal(engine.getSessionState(sessionId).nodeId, "s1_voting1_wait");
    if (failedHeartbeat) {
      const response = await keepAlive(sessionId);
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.ok, false);
    }
    t.mock.timers.tick(2 * MINUTE);
    assert.equal(upstream.mock.callCount(), failedHeartbeat ? 1 : 0);
    assert.equal(engine.adoptProgress(sessionId, `${sessionId}-new`), false);
  });
}
