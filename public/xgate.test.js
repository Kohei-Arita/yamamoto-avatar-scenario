import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

test("自動再接続を使い切った後も、案内されたStartボタンを押せる", async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id))
      elements.set(id, {
        disabled: false,
        textContent: "",
        classList: { add() {}, remove() {} },
        addEventListener() {},
        play: async () => {}
      });
    return elements.get(id);
  }
  const callbacks = new Map();
  const timers = [];
  let starts = 0;
  const context = vm.createContext({
    URLSearchParams,
    AbortSignal,
    window: {
      location: { search: "?autostart=1" },
      addEventListener: (key, callback) => callbacks.set(key, callback)
    },
    document: { getElementById: element, body: element("body"), addEventListener() {} },
    console: { debug() {}, warn() {}, error() {} },
    setTimeout: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeout() {},
    setInterval() {},
    createSessionManager: () => ({
      start: async () => {
        starts += 1;
        throw new Error("offline");
      },
      isStarted: () => false
    }),
    describeSessionError: (error) => error.message
  });
  const source = fs
    .readFileSync(new URL("./xgate.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  await callbacks.get("load")();
  while (timers.length) await timers.shift()();
  assert.equal(starts, 4);
  assert.equal(element("startBtn").disabled, false);
  assert.equal(element("stopBtn").disabled, true);
  assert.match(element("videoPlaceholder").textContent, /Startボタン/u);
});

function shortcutFixture() {
  const listeners = new Map();
  const requests = [];
  const element = {
    classList: { add() {}, remove() {} },
    addEventListener() {}
  };
  let poll;
  let nextResponse = null;
  let state = {
    epoch: "venue-server",
    version: 7,
    awaitingBranches: ["A", "B", "C", "D"].map((choice) => ({ branch: `voting1_${choice}` }))
  };
  const context = vm.createContext({
    URLSearchParams,
    AbortSignal,
    window: { location: { search: "?shortcuts=1&controls=0" }, addEventListener() {} },
    document: {
      body: element,
      getElementById: () => element,
      addEventListener: (name, listener) => listeners.set(name, listener)
    },
    console: { debug() {}, warn() {}, error() {} },
    setTimeout() {},
    clearTimeout() {},
    setInterval: (callback) => {
      poll = callback;
    },
    createSessionManager: () => ({
      isStarted: () => true,
      getSessionId: () => "venue-session"
    }),
    fetch: async (path, options) => {
      if (options.method === "POST") {
        requests.push({ path, body: JSON.parse(options.body) });
        const pending = nextResponse;
        nextResponse = null;
        if (pending) await pending;
      }
      return { ok: true, json: async () => ({ ok: true, state: structuredClone(state) }) };
    }
  });
  const source = fs
    .readFileSync(new URL("./xgate.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  return {
    requests,
    poll: () => poll(),
    setState: (next) => {
      state = next;
    },
    press: (key, { repeat = false, input = null } = {}) =>
      listeners.get("keydown")({
        key,
        repeat,
        target: { closest: (selector) => (input && selector.includes(input) ? element : null) }
      }),
    pauseNextResponse() {
      let release;
      nextResponse = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    }
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("会場キーの長押し・文字入力中のキー操作では分岐や強制送りを実行しない", async () => {
  const stage = shortcutFixture();
  await stage.poll();
  for (const key of ["1", "2", "3", "4", "n", "r", "m"]) {
    stage.press(key, { repeat: true });
    for (const input of ["input", "textarea", "select", "[contenteditable=true]"]) {
      stage.press(key, { input });
    }
  }
  await flush();
  assert.deepEqual(stage.requests, []);
  stage.press("4");
  await flush();
  assert.deepEqual(stage.requests, [
    {
      path: "/api/operator/branch",
      body: {
        branch: "voting1_D",
        sessionId: "venue-session",
        expectedVersion: 7,
        expectedEpoch: "venue-server"
      }
    }
  ]);
});

test("画像説明の開始待ちではVotingの数字キーで進めない", async () => {
  const stage = shortcutFixture();
  stage.setState({
    epoch: "venue-server",
    version: 8,
    awaitingBranches: [{ branch: "present_imaging", next: "s2_imaging" }]
  });
  await stage.poll();
  for (const key of ["1", "2", "3", "4"]) stage.press(key);
  await flush();
  assert.deepEqual(stage.requests, []);
});

test("会場キーを連打しても操作は一度だけ送り、次の投票では最新の分岐と進行番号を使う", async () => {
  const stage = shortcutFixture();
  await stage.poll();
  const release = stage.pauseNextResponse();
  for (const key of ["4", "4", "1", "n", "r", "m"]) stage.press(key);
  assert.equal(stage.requests.length, 1);
  stage.setState({ epoch: "venue-server", version: 8, awaitingBranches: [] });
  release();
  await flush();
  stage.press("4");
  await flush();
  assert.equal(stage.requests.length, 1, "問診中に分岐キーを押しても次へ送らない");

  stage.setState({
    epoch: "venue-server",
    version: 12,
    awaitingBranches: ["C", "A", "D", "B"].map((choice) => ({ branch: `voting2_${choice}` }))
  });
  await stage.poll();
  stage.press("4");
  await flush();
  assert.equal(stage.requests.length, 2);
  assert.deepEqual(stage.requests[1].body, {
    branch: "voting2_D",
    sessionId: "venue-session",
    expectedVersion: 12,
    expectedEpoch: "venue-server"
  });
});
