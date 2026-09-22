import test from "node:test";
import assert from "node:assert/strict";
import env from "../../config/env.js";

// LLM・operator認証をテスト用に固定してからapp（route群）を読み込む
env.scenarioIntentLlm = false;
env.dialogueLlmTranscriptNormalizationEnabled = false;
env.scenarioSpeechMode = "fixed";
env.operatorToken = "test-operator-token";

const { default: app } = await import("../../app.js");

let server = null;
let baseUrl = "";

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
});

function parseSseEvents(rawText) {
  return rawText
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split("\n");
      const event = lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim();
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return { event, data: data ? JSON.parse(data) : null };
    })
    .filter((entry) => entry.event);
}

async function postStream(sessionId, text) {
  const response = await fetch(`${baseUrl}/api/dialogue/respond/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, text })
  });
  const rawText = await response.text();
  return { response, events: parseSseEvents(rawText) };
}

test("SSEはspeech_segment→doneの順で応答する", async () => {
  const sessionId = "sse-compat-1";

  await fetch(`${baseUrl}/api/dialogue/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId })
  });

  const { response, events } = await postStream(sessionId, "こんにちは");

  assert.match(response.headers.get("content-type") || "", /text\/event-stream/u);
  assert.ok(events.length >= 2);

  const segmentEvents = events.filter((entry) => entry.event === "speech_segment");
  const doneEvents = events.filter((entry) => entry.event === "done");

  assert.ok(segmentEvents.length >= 1);
  assert.equal(doneEvents.length, 1);
  assert.equal(events.at(-1).event, "done");

  // 従来の発話フィールドに、入力の開閉と競合検出に使うstateを追加。
  for (const { data } of segmentEvents) {
    assert.deepEqual(Object.keys(data).sort(), ["speechText", "state", "subtitleText", "text"]);
    assert.equal(data.state.nodeId, "s1_symptoms");
    assert.equal(data.text, data.speechText);
    assert.ok(data.speechText.length > 0);
  }

  const done = doneEvents[0].data;
  assert.deepEqual(Object.keys(done).sort(), ["content", "ok", "speechContent", "state"]);
  assert.equal(done.ok, true);
});

test("textなしは400を返す", async () => {
  const response = await fetch(`${baseUrl}/api/dialogue/respond/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "x" })
  });
  assert.equal(response.status, 400);
});

test("operator APIは認証なしで401、正しいBearerで200", async () => {
  const noAuth = await fetch(`${baseUrl}/api/operator/state`);
  assert.equal(noAuth.status, 401);

  const wrongAuth = await fetch(`${baseUrl}/api/operator/state`, {
    headers: { authorization: "Bearer wrong-token" }
  });
  assert.equal(wrongAuth.status, 401);

  const okAuth = await fetch(`${baseUrl}/api/operator/state?sessionId=op-test-1`, {
    headers: { authorization: `Bearer ${env.operatorToken}` }
  });
  const data = await okAuth.json();
  assert.equal(okAuth.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.state.nodeId, "s1_greeting");
});

test("operator branchはoperator遷移ノード以外で409、待機ノードで200", async () => {
  const sessionId = "op-test-branch";
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${env.operatorToken}`
  };

  const rejected = await fetch(`${baseUrl}/api/operator/branch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId, branch: "voting1_A" })
  });
  assert.equal(rejected.status, 409);

  // s1_voting1_wait まで進める
  for (const text of ["こんにちは", "特にありません", "少しあります"]) {
    await postStream(sessionId, text);
  }

  const accepted = await fetch(`${baseUrl}/api/operator/branch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId, branch: "voting1_B" })
  });
  const data = await accepted.json();
  assert.equal(accepted.status, 200);
  assert.equal(data.state.nodeId, "v1_occupation");

  const unknownBranch = await fetch(`${baseUrl}/api/operator/branch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId, branch: "voting1_Z" })
  });
  assert.equal(unknownBranch.status, 409);
});

test("operatorの二重操作を進行番号で拒否し、入力停止はサーバーにも適用する", async () => {
  const sessionId = "operator-version-test";
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${env.operatorToken}`
  };
  const post = (action, body) =>
    fetch(`${baseUrl}/api/operator/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId, ...body })
    });
  const initial = await fetch(`${baseUrl}/api/operator/state?sessionId=${sessionId}`, {
    headers
  }).then((res) => res.json());
  const first = await post("next", { expectedVersion: initial.state.version });
  assert.equal(first.status, 200);
  assert.equal((await post("next", { expectedVersion: initial.state.version })).status, 409);
  const paused = await post("input", { paused: true }).then((res) => res.json());
  assert.equal(paused.state.acceptsPatientInput, false);
  const reply = await postStream(sessionId, "特にありません");
  assert.deepEqual(
    reply.events.map((e) => e.event),
    ["done"]
  );
  assert.equal(reply.events[0].data.state.nodeId, "s1_symptoms");
});

test("オペレーターSSEには置換フラグと入力状態を付ける", async () => {
  const sessionId = "operator-events-test";
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/dialogue/events?sessionId=${sessionId}`, {
    signal: controller.signal
  });
  const reader = response.body.getReader();
  try {
    const connected = parseSseEvents(new TextDecoder().decode((await reader.read()).value));
    assert.equal(connected[0].event, "connected");
    assert.equal(connected[0].data.state.acceptsPatientInput, true);
    const result = await fetch(`${baseUrl}/api/operator/jump`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.operatorToken}` },
      body: JSON.stringify({ sessionId, nodeId: "s1_voting1_wait", expectedVersion: 0 })
    }).then((res) => res.json());
    assert.equal(result.delivery.delivered, true);
    const events = parseSseEvents(new TextDecoder().decode((await reader.read()).value));
    assert.equal(events[0].event, "speech_segment");
    assert.equal(events[0].data.replace, true);
    assert.equal(events[0].data.state.acceptsPatientInput, false);
    assert.equal(events[0].data.state.version, result.state.version);
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});
