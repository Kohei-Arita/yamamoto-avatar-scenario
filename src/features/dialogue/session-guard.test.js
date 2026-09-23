import test from "node:test";
import assert from "node:assert/strict";
import env from "../../config/env.js";
import { registerKnownSessionId, isAllowedDialogueSession } from "./session-registry.js";

env.scenarioIntentLlm = false;
env.dialogueLlmTranscriptNormalizationEnabled = false;
env.scenarioSpeechMode = "fixed";
env.operatorToken = "guard-test-token";

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

test("セッション未発行の間も未知・未指定のsessionIdを拒否する", async () => {
  assert.equal(isAllowedDialogueSession("anything"), false);
  assert.equal(isAllowedDialogueSession(undefined), false);

  const response = await fetch(`${baseUrl}/api/dialogue/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "dev-session" })
  });
  assert.equal(response.status, 403);
});

test("セッション発行後は未知のsessionIdからの対話リクエストを403で拒否する", async () => {
  registerKnownSessionId("known-session-1");

  const rejectedBind = await fetch(`${baseUrl}/api/dialogue/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "attacker-session" })
  });
  assert.equal(rejectedBind.status, 403);

  // ID省略で直近の本番セッションへ介入できない。
  const noSessionStream = await fetch(`${baseUrl}/api/dialogue/respond/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "こんにちは" })
  });
  assert.equal(noSessionStream.status, 403);

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

test("対話・ログ・LiveAvatar発行は認証必須で、会場画面は入場画面へ案内する", async () => {
  for (const [path, method] of [
    ["/api/dialogue/logs", "GET"],
    ["/api/dialogue/events?sessionId=known-session-1", "GET"],
    ["/api/dialogue/respond/stream", "POST"],
    ["/api/liveavatar/session-token", "POST"]
  ]) {
    const response = await globalThis.fetch(`${baseUrl}${path}`, { method });
    assert.equal(response.status, 401, path);
  }
  const stage = await globalThis.fetch(`${baseUrl}/xgate?autostart=1&optoken=not-a-real-token`, {
    redirect: "manual"
  });
  assert.equal(stage.status, 302);
  assert.match(stage.headers.get("location"), /^\/access\?/u);
  assert.equal(stage.headers.get("location").includes("not-a-real-token"), false);
});

test("入場Cookieで会場APIとSSEを認証でき、偽造Cookieと外部Originは拒否する", async () => {
  const login = await globalThis.fetch(`${baseUrl}/api/access`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: env.operatorToken })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0];
  const logs = await globalThis.fetch(`${baseUrl}/api/dialogue/logs`, { headers: { cookie } });
  assert.equal(logs.status, 200);
  const forged = await globalThis.fetch(`${baseUrl}/api/dialogue/logs`, {
    headers: { cookie: cookie + "bad" }
  });
  assert.equal(forged.status, 401);
  const crossOrigin = await globalThis.fetch(`${baseUrl}/api/operator/state`, {
    headers: { cookie, origin: "https://untrusted.invalid" }
  });
  assert.equal(crossOrigin.status, 403);
  const stage = await globalThis.fetch(`${baseUrl}/xgate`, { headers: { cookie } });
  assert.equal(stage.status, 200);
  assert.equal(stage.headers.get("referrer-policy"), "no-referrer");
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

test("旧プロセスからの認証済みSSE再接続は入力停止でbindし、ジャンプから復旧できる", async () => {
  const sessionId = "restart-recovery-session";
  const abort = new AbortController();
  const response = await fetch(
    `${baseUrl}/api/dialogue/events?sessionId=${sessionId}&epoch=previous-server`,
    { signal: abort.signal }
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  try {
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /"recoveryRequired":true/u);
    assert.match(event, /"openingSegments":\[\]/u);
    const state = await fetch(`${baseUrl}/api/operator/state`).then((res) => res.json());
    assert.equal(state.state.sessionId, sessionId);
    assert.equal(state.state.acceptsPatientInput, false);
    const post = (body) =>
      fetch(`${baseUrl}/api/operator/jump`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, nodeId: "s2_values", expectedVersion: 0, ...body })
      });
    assert.equal((await post({ expectedEpoch: "previous-server" })).status, 409);
    const recovered = await post({ expectedEpoch: state.state.epoch }).then((res) => res.json());
    assert.equal(recovered.state.nodeId, "s2_values");
    assert.equal(recovered.state.recoveryRequired, false);
    assert.equal(recovered.state.acceptsPatientInput, true);
    const speech = new TextDecoder().decode((await reader.read()).value);
    assert.match(speech, /"segmentCount":/u);
  } finally {
    abort.abort();
    await reader.cancel().catch(() => {});
  }
});
