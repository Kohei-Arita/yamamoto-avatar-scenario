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
