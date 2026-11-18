// 実ブラウザ + 実HTTP/SSE。LiveAvatar/LiveKitだけを模擬し、外部API・実マイクは使わない。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import env from "../src/config/env.js";
import { registerKnownSessionId } from "../src/features/dialogue/session-registry.js";
import { loadScenarioFromFile } from "../src/features/scenario/scenario-loader.js";
import { pullCompletedSpeechSegments } from "../src/features/dialogue/streaming-speech.js";

loadScenarioFromFile("./data/scenarios/haigan-2026.json");
const sourceScript = await readFile("./data/scenarios/haigan-2026-script.md", "utf8");
const scriptSections = sourceScript
  .split(/^#{2,3} .+$/mu)
  .map((section) =>
    [...section.matchAll(/\*\*(AI山本医師|患者)\*\*：「(.*)」/gu)].map(([, role, text]) => ({
      role,
      text: text.trim()
    }))
  )
  .filter((turns) => turns.length);

env.operatorToken = "browser-smoke-test-token";
env.scenarioIntentLlm = false;
env.dialogueLlmTranscriptNormalizationEnabled = false;
env.scenarioSpeechMode = "fixed";
const { default: app } = await import("../src/app.js");
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(os.tmpdir(), "yamamoto-browser-smoke-"));
const binary =
  process.env.CHROME_BIN ||
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "google-chrome");
const chrome = spawn(
  binary,
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-component-update",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "about:blank"
  ],
  { stdio: "ignore" }
);
let spawnError;
chrome.on("error", (error) => {
  spawnError = error;
});
const pages = [];
const exceptions = [];
const browserErrors = [];
let issued = 0;

async function until(check, label, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (spawnError) throw spawnError;
    const result = await check();
    if (result) return result;
    await delay(80);
  }
  throw new Error(`Timed out: ${label}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const handlers = new Map();
  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.id) {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timer);
      if (data.error) request.reject(new Error(data.error.message));
      else request.resolve(data.result);
    } else {
      const handler = handlers.get(data.method);
      if (handler)
        Promise.resolve(handler(data.params)).catch((error) => exceptions.push(error.message));
    }
  });
  return {
    send(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, callback) {
      handlers.set(method, callback);
    },
    close() {
      for (const request of pending.values()) clearTimeout(request.timer);
      socket.close();
    }
  };
}

function fakeLiveKit() {
  window.__spoken = [];
  window.__mic = false;
  window.__subtitleCountsDuringSpeech = [];
  const RoomEvent = Object.fromEntries(
    [
      "Connected",
      "Disconnected",
      "TrackSubscribed",
      "TrackUnsubscribed",
      "DataReceived",
      "ParticipantConnected",
      "ParticipantDisconnected"
    ].map((name) => [name, name])
  );
  class Room {
    constructor() {
      window.__room = this;
      this.listeners = new Map();
      this.remoteParticipants = new Map();
      this.localParticipant = {
        isSpeaking: false,
        on() {},
        off() {},
        setMicrophoneEnabled: async (enabled) => {
          window.__mic = enabled;
        },
        publishData: async (payload) => {
          const event = JSON.parse(new TextDecoder().decode(payload));
          if (event.event_type !== "avatar.speak_text") return;
          window.__spoken.push(event.text);
          setTimeout(
            () =>
              this.message({ event_type: "avatar.speak_started", source_event_id: event.event_id }),
            5
          );
          setTimeout(
            () =>
              this.message({ event_type: "avatar.speak_ended", source_event_id: event.event_id }),
            30
          );
        }
      };
    }
    on(name, callback) {
      this.listeners.set(name, callback);
    }
    message(event) {
      this.listeners.get(RoomEvent.DataReceived)?.(
        new TextEncoder().encode(JSON.stringify(event)),
        null,
        null,
        "agent-response"
      );
      if (event.event_type === "avatar.speak_started") {
        window.__subtitleCountsDuringSpeech.push(
          document.querySelectorAll(
            '#subtitleBox, .subtitle-box, track[kind="subtitles"], track[kind="captions"]'
          ).length
        );
      }
    }
    patient(text) {
      for (const event of [
        { event_type: "user.speak_started" },
        { event_type: "user.transcription", text },
        { event_type: "user.speak_ended" }
      ])
        this.message(event);
    }
    async connect() {
      this.audio = new AudioContext();
      const stream = this.audio.createMediaStreamDestination().stream;
      const track = {
        kind: "audio",
        attach(element) {
          element.srcObject = stream;
        }
      };
      this.remoteParticipants.set("avatar", {
        trackPublications: new Map([["audio", { isSubscribed: true, track }]])
      });
      this.listeners.get(RoomEvent.Connected)?.();
    }
    async disconnect() {
      this.audio?.close();
      this.listeners.get(RoomEvent.Disconnected)?.("client");
    }
  }
  window.LivekitClient = { Room, RoomEvent, Track: { Kind: { Audio: "audio", Video: "video" } } };
}

try {
  const port = await until(async () => {
    try {
      return Number(
        (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]
      );
    } catch {
      return null;
    }
  }, "Chrome start");

  async function page(url) {
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT"
    }).then((response) => response.json());
    const client = await connect(target.webSocketDebuggerUrl);
    pages.push(client);
    const evaluate = async (expression) => {
      const result = await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result?.value;
    };
    client.on("Runtime.exceptionThrown", ({ exceptionDetails }) =>
      exceptions.push(exceptionDetails.exception?.description || exceptionDetails.text)
    );
    client.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type === "error")
        browserErrors.push(args.map((arg) => arg.description || arg.value || "").join(" "));
    });
    client.on("Fetch.requestPaused", async ({ requestId, request }) => {
      const requested = new URL(request.url);
      if (requested.origin !== base)
        return client.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      let body;
      let type = "application/json";
      if (requested.pathname.startsWith("/vendor/livekit-client/")) {
        body = `(${fakeLiveKit.toString()})();`;
        type = "text/javascript";
      }
      if (requested.pathname === "/api/liveavatar/session-token") {
        const sessionId = `browser-smoke-${++issued}`;
        registerKnownSessionId(sessionId);
        body = JSON.stringify({
          ok: true,
          session_id: sessionId,
          session_token: `mock-token-${issued}`
        });
      }
      if (requested.pathname === "/api/liveavatar/start-session")
        body = JSON.stringify({
          ok: true,
          livekit_url: "mock://local",
          livekit_token: "mock",
          raw: { max_session_duration: 300 }
        });
      if (
        ["/api/liveavatar/stop-session", "/api/liveavatar/keep-alive"].includes(requested.pathname)
      )
        body = '{"ok":true}';
      if (body !== undefined)
        return client.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: type }],
          body: Buffer.from(body).toString("base64")
        });
      return client.send("Fetch.continueRequest", { requestId });
    });
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await client.send("Page.navigate", { url });
    return { client, evaluate };
  }

  // 旧URLの字幕指定が残っていても、発話中を含め字幕が生成されないことを確認する。
  async function assertNoSubtitles(target, label) {
    const counts = await target.evaluate(`({
      current: document.querySelectorAll('#subtitleBox, .subtitle-box, track[kind="subtitles"], track[kind="captions"]').length,
      speaking: window.__subtitleCountsDuringSpeech
    })`);
    assert.equal(counts.current, 0, `${label}: 字幕欄が存在しない`);
    assert.ok(counts.speaking.length > 0, `${label}: 発話開始を実際に確認する`);
    assert.ok(
      counts.speaking.every((count) => count === 0),
      `${label}: 発話中にも字幕がない`
    );
  }

  const stage = await page(`${base}/xgate?autostart=1&controls=0&shortcuts=1&subtitles=1`);
  await until(
    () =>
      stage.evaluate(
        "document.readyState === 'complete' && Boolean(document.querySelector('#accessForm button:not(:disabled)'))"
      ),
    "access form"
  );
  await stage.evaluate(
    `document.querySelector('#accessToken').value = ${JSON.stringify(env.operatorToken)}; document.querySelector('#accessForm').requestSubmit();`
  );
  await until(
    () =>
      stage.evaluate(
        "document.querySelector('#connectionState')?.textContent === 'connected' && window.__mic"
      ),
    "stage start"
  );
  await stage.evaluate("window.__room.patient('はい、よろしくお願いします。')");
  await until(
    () =>
      stage.evaluate(
        "window.__spoken.some(text => text.includes('たいじゅうげんしょう')) && window.__mic"
      ),
    "natural greeting reply"
  );
  await stage.evaluate("window.__room.patient('咳も痰もありません。')");
  await until(
    () =>
      stage.evaluate(
        "window.__spoken.some(text => text.includes('しょうじょうはないけれど')) && window.__mic"
      ),
    "negated symptoms"
  );

  const operator = await page(`${base}/operator`);
  await until(
    () =>
      operator.evaluate(
        "document.readyState === 'complete' && Boolean(document.querySelector('#tokenInput'))"
      ),
    "operator form"
  );
  await operator.evaluate(
    `document.querySelector('#tokenInput').value = ${JSON.stringify(env.operatorToken)}; document.querySelector('#connectBtn').click();`
  );
  await until(
    () => operator.evaluate("document.querySelector('#stateNode').textContent.includes('s1_adl')"),
    "operator state"
  );
  assert.equal(await operator.evaluate("document.querySelector('#imagingControls').hidden"), true);
  await operator.evaluate("document.querySelector('#inputBtn').click()");
  await until(() => stage.evaluate("window.__mic === false"), "operator pause");
  await operator.evaluate("document.querySelector('#inputBtn').click()");
  await until(() => stage.evaluate("window.__mic === true"), "operator resume");
  // 操作画面を開いた後は会場タブを前面に戻し、模擬発話タイマーの背景タブ抑制を避ける。
  await stage.client.send("Page.bringToFront");
  await stage.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))");
  assert.equal(
    await stage.evaluate("document.querySelector('#connectionState').textContent"),
    "connected"
  );

  await stage.evaluate(
    "window.__room.patient('普段は普通に生活できています。階段や坂道では少し息が切れることがあります。')"
  );
  await until(
    () =>
      operator.evaluate(
        "document.querySelector('#stateNode').textContent.includes('s1_voting1_wait') && document.querySelectorAll('#branchButtons button').length === 3"
      ),
    "three interview options"
  );
  await until(() => stage.evaluate("window.__mic === false"), "interview voting mute");
  async function finishDialogue(turns, speechStart, { trailing = [], muteAtEnd = false } = {}) {
    const expected = [];
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      if (turn.role === "患者") {
        await stage.evaluate(`window.__room.patient(${JSON.stringify(turn.text)})`);
        continue;
      }
      const last = index === turns.length - 1;
      for (const line of [turn.text, ...(last ? trailing : [])]) {
        expected.push(
          ...pullCompletedSpeechSegments(line).segments.map((segment) => segment.speechText)
        );
      }
      await until(
        async () => {
          const actual = await stage.evaluate(
            `({spoken: window.__spoken.slice(${speechStart}), mic: window.__mic})`
          );
          return (
            JSON.stringify(actual.spoken) === JSON.stringify(expected) &&
            actual.mic === !(last && muteAtEnd)
          );
        },
        `dialogue turn ${index}: ${turn.text.slice(0, 20)}`,
        30_000
      );
    }
  }
  const interviewStart = await stage.evaluate("window.__spoken.length");
  await operator.evaluate("document.querySelectorAll('#branchButtons button')[2].click()");
  await finishDialogue(scriptSections[3], interviewStart, {
    trailing: [scriptSections[4][0].text],
    muteAtEnd: true
  });
  await until(
    () =>
      operator.evaluate(
        "document.querySelector('#stateNode').textContent.includes('s1_close') && !document.querySelector('#imagingControls').hidden && !document.querySelector('#startImagingBtn').disabled"
      ),
    "await imaging button"
  );
  const beforeCue = await stage.evaluate("window.__spoken.length");
  assert.equal(await stage.evaluate("window.__mic"), false);
  assert.equal(
    await operator.evaluate("document.querySelectorAll('#branchButtons button').length"),
    0
  );
  await stage.evaluate(
    "window.__room.patient('画像はまだ準備中です。'); window.__room.patient('PET画像を提示します。')"
  );
  // 旧音声合図を受けても、通常の発話確定時間を過ぎて無言・マイク停止を保つ。
  await delay(2500);
  assert.equal(await stage.evaluate("window.__spoken.length"), beforeCue);
  assert.equal(await stage.evaluate("window.__mic"), false);
  assert.equal(
    await stage.evaluate("window.__spoken.some(text => text.includes('みぎかよう'))"),
    false
  );
  await operator.evaluate(
    "document.querySelector('#startImagingBtn').click(); document.querySelector('#startImagingBtn').click()"
  );
  await until(
    () =>
      stage.evaluate(
        "window.__spoken.some(text => text.includes('リンパせつてんい')) && window.__mic"
      ),
    "imaging button starts imaging and pathology"
  );
  assert.equal(
    await stage.evaluate("window.__spoken.some(text => text.includes('みぎかよう'))"),
    true
  );
  const imagingSpeech = scriptSections[5]
    .slice(0, 2)
    .flatMap((turn) =>
      pullCompletedSpeechSegments(turn.text).segments.map((segment) => segment.speechText)
    );
  assert.deepEqual(await stage.evaluate(`window.__spoken.slice(${beforeCue})`), imagingSpeech);
  await until(
    () => operator.evaluate("document.querySelector('#imagingControls').hidden"),
    "imaging button hidden after start"
  );
  await stage.evaluate(
    "window.__room.patient('やはり肺がんなのですね。手術で取れば治るのでしょうか。')"
  );
  await until(
    () =>
      stage.evaluate(
        "window.__spoken.some(text => text.includes('いちばんじゅうし')) && window.__mic"
      ),
    "patient values question"
  );
  await stage.evaluate(
    "window.__room.patient('特に強い希望はありません。ただ、リスクの高い治療はしたくありません。')"
  );
  await until(
    () =>
      stage.evaluate(
        "window.__spoken.some(text => text.includes('はずせないよてい')) && window.__mic"
      ),
    "wedding question"
  );
  await stage.evaluate(
    "window.__room.patient('3か月後に孫の結婚式があります。それにはできれば出たいです。')"
  );
  await until(
    () =>
      operator.evaluate(
        "document.querySelector('#stateNode').textContent.includes('s2_voting2_wait') && document.querySelectorAll('#branchButtons button').length === 4"
      ),
    "four treatment options"
  );
  await until(() => stage.evaluate("window.__mic === false"), "treatment voting mute");
  // 会場側のショートカット用状態は2秒ごとのポーリングで同期される。
  await delay(2100);
  const treatmentStart = await stage.evaluate("window.__spoken.length");
  await stage.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: '4' }))");
  await finishDialogue(scriptSections[9], treatmentStart, { muteAtEnd: true });
  await until(
    () =>
      operator.evaluate("document.querySelector('#stateNode').textContent.includes('s2_closing')"),
    "treatment closes after final patient turn"
  );
  assert.equal(await stage.evaluate("window.__mic"), false);
  await assertNoSubtitles(stage, "会場画面");

  const second = await page(`${base}/xgate?autostart=1`);
  await until(
    () =>
      second.evaluate(
        "document.querySelector('#videoPlaceholder')?.textContent.includes('再接続')"
      ),
    "second-tab rejection"
  );
  assert.equal(issued, 1, "二重起動ではLiveAvatarセッションを発行しない");

  // 2枚目をデバッグ画面へ切り替えて自動再接続を終了し、会場画面を停止してから起動する。
  await second.client.send("Page.navigate", { url: `${base}/index.html?subtitles=1` });
  await until(
    () => second.evaluate("document.querySelector('#modeValue')?.textContent === 'FULL'"),
    "debug config"
  );
  await stage.evaluate("document.querySelector('#stopBtn').click()");
  await until(
    () => stage.evaluate("document.querySelector('#connectionState').textContent === 'idle'"),
    "stage stopped"
  );
  await second.client.send("Page.bringToFront");
  await second.evaluate("document.querySelector('#startBtn').click()");
  await until(
    () => second.evaluate("document.querySelector('#connectionState').textContent === 'connected'"),
    "debug start"
  );
  await until(
    () =>
      operator.evaluate(
        "document.querySelector('#stateSession').textContent === 'browser-smoke-2'"
      ),
    "operator follows debug session"
  );
  await operator.evaluate(
    "document.querySelector('#jumpSelect').value = 's1_greeting'; document.querySelector('#jumpBtn').click()"
  );
  await until(
    () => second.evaluate("window.__spoken.length > 0 && window.__mic"),
    "debug playback and microphone resume"
  );
  await assertNoSubtitles(second, "デバッグ画面");
  assert.deepEqual(exceptions, []);
  console.log(
    "Browser smoke passed: login, greeting, negation, operator pause/resume, three interview choices, four treatment choices, muted moderator wait, ignored PET cue, imaging button and double-click guard, turn-by-turn treatment playback, stage shortcuts, Web Lock, no stage/debug subtitles even with subtitles=1, debug playback and microphone resume. External services mocked."
  );
} catch (error) {
  for (const page of pages) {
    const snapshot = await page
      .send("Runtime.evaluate", {
        expression:
          "({ url: location.href, body: document.body?.innerText, mic: window.__mic, spoken: window.__spoken })",
        returnByValue: true
      })
      .catch(() => null);
    console.error("Browser diagnostic:", snapshot?.result?.value);
  }
  console.error({ issued, exceptions, browserErrors });
  throw error;
} finally {
  for (const page of pages) page.close();
  chrome.kill("SIGTERM");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (chrome.exitCode === null && !spawnError)
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), delay(3000)]);
  if (chrome.exitCode === null && !spawnError) chrome.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
