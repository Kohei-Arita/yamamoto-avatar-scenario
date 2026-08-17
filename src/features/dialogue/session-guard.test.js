import test from "node:test";
import assert from "node:assert/strict";
import env from "../../config/env.js";
import { registerKnownSessionId, isAllowedDialogueSession } from "./session-registry.js";

env.scenarioIntentLlm = false;
env.dialogueLlmTranscriptNormalizationEnabled = false;
env.scenarioSpeechMode = "fixed";
env.operatorToken = "guard-test-token";

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

test("セッション未発行の間は任意のsessionIdを受け付ける(ローカル開発・テスト用)", async () => {
  assert.equal(isAllowedDialogueSession("anything"), true);

  const response = await fetch(`${baseUrl}/api/dialogue/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "dev-session" })
  });
  assert.equal(response.status, 200);
});

test("セッション発行後は未知のsessionIdからの対話リクエストを403で拒否する", async () => {
  registerKnownSessionId("known-session-1");

  const rejectedBind = await fetch(`${baseUrl}/api/dialogue/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "attacker-session" })
  });
  assert.equal(rejectedBind.status, 403);

  // sessionId未指定は拒否しない(サーバー側で直近bindセッションへフォールバックする正常系)
  const noSessionStream = await fetch(`${baseUrl}/api/dialogue/respond/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "こんにちは" })
  });
  assert.equal(noSessionStream.status, 200);

  const rejectedStream = await fetch(`${baseUrl}/api/dialogue/respond/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "attacker-session", text: "こんにちは" })
  });
  assert.equal(rejectedStream.status, 403);

  const acceptedBind = await fetch(`${baseUrl}/api/dialogue/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "known-session-1" })
  });
  assert.equal(acceptedBind.status, 200);

  const acceptedStream = await fetch(`${baseUrl}/api/dialogue/respond/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "known-session-1", text: "こんにちは" })
  });
  assert.equal(acceptedStream.status, 200);
});

test("bind時に直前セッションの進行が新セッションへ引き継がれる", async () => {
  const post = (path, body) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

  registerKnownSessionId("show-session-1");
  registerKnownSessionId("show-session-2");

  await post("/api/dialogue/session", { sessionId: "show-session-1" });
  await post("/api/dialogue/respond/stream", { sessionId: "show-session-1", text: "こんにちは" });
  await post("/api/dialogue/respond/stream", {
    sessionId: "show-session-1",
    text: "特にありません"
  });

  // LiveAvatar再接続で新しいsessionIdになった想定
  await post("/api/dialogue/session", { sessionId: "show-session-2" });

  const state = await fetch(`${baseUrl}/api/operator/state?sessionId=show-session-2`, {
    headers: { authorization: `Bearer ${env.operatorToken}` }
  }).then((response) => response.json());

  assert.equal(state.state.nodeId, "s1_adl");
});
