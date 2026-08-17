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

  // speech_segment payload は text/speechText/subtitleText の3フィールド構成
  for (const { data } of segmentEvents) {
    assert.deepEqual(Object.keys(data).sort(), ["speechText", "subtitleText", "text"]);
    assert.equal(data.text, data.speechText);
    assert.ok(data.speechText.length > 0);
  }

  const done = doneEvents[0].data;
  assert.deepEqual(Object.keys(done).sort(), ["content", "ok", "speechContent"]);
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
