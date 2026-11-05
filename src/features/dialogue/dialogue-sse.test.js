import test from "node:test";
import assert from "node:assert/strict";
import env from "../../config/env.js";
import { registerKnownSessionId } from "./session-registry.js";
import { loadScenarioFromFile } from "../scenario/scenario-loader.js";

const scenario = loadScenarioFromFile("./data/scenarios/haigan-2026.json");

// LLM・operator認証をテスト用に固定してからapp（route群）を読み込む
env.scenarioIntentLlm = false;
env.dialogueLlmTranscriptNormalizationEnabled = false;
env.scenarioSpeechMode = "fixed";
env.operatorToken = "test-operator-token";

const { default: app } = await import("../../app.js");
const fetch = (url, options = {}) =>
  globalThis.fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${env.operatorToken}`, ...options.headers }
  });

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

async function* readSseEvents(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      yield* parseSseEvents(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
}

async function openDialogueEvents(sessionId) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/dialogue/events?sessionId=${sessionId}`, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  return {
    events: readSseEvents(reader),
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  };
}

async function postStream(sessionId, text) {
  registerKnownSessionId(sessionId);
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
  registerKnownSessionId(sessionId);

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
    assert.deepEqual(Object.keys(data).sort(), [
      "segmentCount",
      "segmentIndex",
      "speechId",
      "speechText",
      "state",
      "subtitleText",
      "text"
    ]);
    assert.equal(data.speechId, data.state.speechId);
    assert.equal(data.segmentCount, segmentEvents.length);
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
  const noAuth = await globalThis.fetch(`${baseUrl}/api/operator/state`);
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
  registerKnownSessionId(sessionId);
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

for (const [branch, nodeId] of Object.entries({
  voting2_A: "v2_perioperative",
  voting2_B: "v2_surgery",
  voting2_C: "v2_radiation",
  voting2_D: "v2_chemo"
})) {
  test(`${branch}: 治療説明と締めを全件SSE配信し、再接続でも全文を復元する`, async () => {
    const sessionId = `treatment-sse-${branch}`;
    registerKnownSessionId(sessionId);
    const expectedLines = [nodeId, "s2_closing"].flatMap(
      (id) => scenario.nodes.find((node) => node.id === id).doctorLines
    );
    const expectedSentences = expectedLines.flatMap((line) =>
      line.match(/[^。！？!?]+[。！？!?]/gu)
    );
    const post = (action, body) =>
      fetch(`${baseUrl}/api/operator/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ...body })
      });
    const jumpResponse = await post("jump", { nodeId: "s2_voting2_wait" });
    assert.equal(jumpResponse.status, 200);
    const { state: waiting } = await jumpResponse.json();
    assert.equal(waiting.acceptsPatientInput, false);

    const stream = await openDialogueEvents(sessionId);
    const received = [];
    let state;
    try {
      const connected = (await stream.events.next()).value;
      assert.equal(connected.event, "connected");
      assert.equal(connected.data.state.nodeId, "s2_voting2_wait");

      const response = await post("branch", {
        branch,
        expectedVersion: waiting.version,
        expectedEpoch: waiting.epoch
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      state = result.state;
      assert.equal(result.delivery.delivered, true);
      assert.equal(result.delivery.segmentCount, expectedSentences.length);
      assert.equal(state.nodeId, "s2_closing");
      assert.equal(state.isTerminal, true);
      assert.equal(state.acceptsPatientInput, false);

      for (let index = 0; index < expectedSentences.length; index += 1) {
        const event = (await stream.events.next()).value;
        assert.equal(event.event, "speech_segment");
        const segment = event.data;
        assert.equal(segment.segmentIndex, index);
        assert.equal(segment.segmentCount, expectedSentences.length);
        assert.equal(segment.speechId, state.speechId);
        assert.equal(segment.state.speechId, state.speechId);
        assert.equal(segment.state.version, state.version);
        assert.equal(segment.state.epoch, state.epoch);
        assert.equal(segment.state.acceptsPatientInput, false);
        assert.equal(segment.replace, index === 0);
        assert.equal(segment.subtitleText, expectedSentences[index]);
        assert.equal(segment.text, segment.speechText);
        assert.ok(segment.speechText.length > 0);
        assert.doesNotMatch(segment.speechText, /[\p{Script=Han}0-9A-Za-z#]/u);
        received.push(segment);
      }
    } finally {
      await stream.close();
    }

    // 現在ノードは締めでも、再接続時には選択した治療説明を含む全セグメントを返す。
    const reconnected = await openDialogueEvents(sessionId);
    try {
      const event = (await reconnected.events.next()).value;
      assert.equal(event.event, "connected");
      assert.equal(event.data.state.nodeId, "s2_closing");
      assert.equal(event.data.state.speechId, state.speechId);
      assert.equal(event.data.state.version, state.version);
      assert.equal(event.data.state.acceptsPatientInput, false);
      const restored = event.data.openingSegments;
      assert.equal(restored.length, received.length);
      for (const [index, segment] of restored.entries()) {
        const original = received[index];
        assert.equal(segment.segmentIndex, index);
        assert.equal(segment.segmentCount, received.length);
        assert.equal(segment.speechId, original.speechId);
        assert.equal(segment.subtitleText, original.subtitleText);
        assert.equal(segment.speechText, original.speechText);
      }
    } finally {
      await reconnected.close();
    }
  });
}
