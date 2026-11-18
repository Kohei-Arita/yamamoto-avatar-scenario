// Web Locksはタブ/ブラウザの異常終了時にも自動解放される。
// 非対応ブラウザだけ短期リースへ退避し、更新失敗時は現在の接続を止める。
export function createSessionStartLock({
  locks = globalThis.navigator?.locks,
  storage = globalThis.window?.localStorage,
  storageKey = "liveavatar-session-start-lock",
  tabId = globalThis.crypto.randomUUID(),
  ttlMs = 30_000,
  onLost = () => {}
} = {}) {
  let releaseWebLock = null;
  let refreshTimer = null;
  let generation = 0;
  let held = false;

  function readLease() {
    const raw = storage?.getItem(storageKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  function writeLease() {
    if (!storage)
      throw new Error("多重起動防止に必要なブラウザ機能が使えません。Chromeで開いてください。");
    storage.setItem(storageKey, JSON.stringify({ tabId, expiresAt: Date.now() + ttlMs }));
  }
  function refresh() {
    if (!held) return false;
    if (releaseWebLock) return true;
    try {
      if (readLease()?.tabId !== tabId) return false;
      writeLease();
      return true;
    } catch {
      return false;
    }
  }
  function release() {
    generation += 1;
    held = false;
    clearInterval(refreshTimer);
    refreshTimer = null;
    if (releaseWebLock) {
      releaseWebLock();
      releaseWebLock = null;
    } else {
      try {
        if (readLease()?.tabId === tabId) storage.removeItem(storageKey);
      } catch {
        /* 古いリースは短い期限で失効する。 */
      }
    }
  }
  async function acquire() {
    if (held) return true;
    const attempt = ++generation;
    if (locks?.request) {
      return new Promise((resolve, reject) => {
        locks
          .request(storageKey, { ifAvailable: true }, (lock) => {
            if (!lock || attempt !== generation) {
              resolve(false);
              return;
            }
            held = true;
            return new Promise((unlock) => {
              releaseWebLock = unlock;
              resolve(true);
            });
          })
          .catch(reject);
      });
    }
    const existing = readLease();
    if (existing?.tabId !== tabId && existing?.expiresAt > Date.now()) return false;
    writeLease();
    held = true;
    refreshTimer = setInterval(
      () => {
        if (!refresh()) {
          release();
          onLost();
        }
      },
      Math.max(1000, Math.floor(ttlMs / 3))
    );
    return true;
  }
  return { acquire, refresh, release };
}
