import assert from "node:assert/strict";
import test from "node:test";
import { createSessionStartLock } from "./session-start-lock.js";

test("Web Lockの所有中だけ他タブを拒否し、解放後はすぐ取得できる", async () => {
  let busy = false;
  const locks = {
    async request(name, options, callback) {
      if (busy) return callback(null);
      busy = true;
      try {
        await callback({ name });
      } finally {
        busy = false;
      }
    }
  };
  const first = createSessionStartLock({ locks });
  const second = createSessionStartLock({ locks });
  try {
    assert.equal(await first.acquire(), true);
    assert.equal(await second.acquire(), false);
    first.release();
    await Promise.resolve();
    assert.equal(await second.acquire(), true);
  } finally {
    first.release();
    second.release();
  }
});

test("取得待ちの間に停止したWeb Lockは、遅れて付与されても保持しない", async () => {
  let grant;
  const locks = {
    request(name, options, callback) {
      return new Promise((resolve) => {
        grant = () => resolve(callback({ name }));
      });
    }
  };
  const lock = createSessionStartLock({ locks });
  const waiting = lock.acquire();
  lock.release();
  grant();
  assert.equal(await waiting, false);
});

test("非対応ブラウザの異常終了リースも30秒で失効する", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const values = new Map([
    ["liveavatar-session-start-lock", JSON.stringify({ tabId: "crashed", expiresAt: 31_000 })]
  ]);
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const lock = createSessionStartLock({ locks: null, storage });
  try {
    assert.equal(await lock.acquire(), false);
    t.mock.timers.tick(30_001);
    assert.equal(await lock.acquire(), true);
    t.mock.timers.tick(60_000);
    assert.equal(lock.refresh(), true, "APIのkeep-aliveとは独立してリースを更新する");
  } finally {
    lock.release();
  }
});
