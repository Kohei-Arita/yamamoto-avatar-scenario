import { createSessionManager } from "./liveavatar-session-manager.js";
import { describeSessionError } from "./liveavatar-session-ui.js";

const remoteVideo = document.getElementById("remoteVideo");
const remoteCanvas = document.getElementById("remoteCanvas");
const remoteAudio = document.getElementById("remoteAudio");
const videoPlaceholder = document.getElementById("videoPlaceholder");
const subtitleBox = document.getElementById("subtitleBox");
const audioUnlockOverlay = document.getElementById("audioUnlockOverlay");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const chromaKeyToggle = document.getElementById("chromaKeyToggle");
const connectionStateEl = document.getElementById("connectionState");
const micStateEl = document.getElementById("micState");

const params = new URLSearchParams(window.location.search);
const operatorToken = params.get("optoken") || "";
const operatorShortcuts = params.get("shortcuts") === "1" || Boolean(operatorToken);
if (operatorToken) {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("optoken");
  window.history.replaceState(null, "", cleanUrl);
}
const shouldAutostart = params.get("autostart") === "1";
const hideControls = params.get("controls") === "0";
const showSubtitles = params.get("subtitles") !== "0";

let hudHideTimer = null;

function setConnectionState(value) {
  connectionStateEl.textContent = value;
}

function setMicState(value) {
  micStateEl.textContent = value;
}

function setStageMessage(message) {
  const nextMessage = String(message || "").trim() || "WAITING FOR AVATAR...";
  videoPlaceholder.textContent = nextMessage;
  videoPlaceholder.classList.remove("hidden");
}

function resetButtons() {
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

function scheduleHudHide() {
  clearTimeout(hudHideTimer);

  if (hideControls) {
    hudHideTimer = setTimeout(() => {
      document.body.classList.add("controls-hidden");
    }, 2200);
  }
}

function showHudTemporarily() {
  document.body.classList.remove("controls-hidden");
  scheduleHudHide();
}

// ブラウザの自動再生制限で音声がブロックされた場合の解除オーバーレイ。
function showAudioUnlockOverlay() {
  audioUnlockOverlay?.classList.remove("hidden");
}

audioUnlockOverlay?.addEventListener("click", async () => {
  try {
    await remoteAudio.play();
    remoteVideo.play().catch(() => {});
    audioUnlockOverlay.classList.add("hidden");
  } catch (error) {
    console.error("audio unlock failed", error);
  }
});

// 予期しない切断(サンドボックス時間切れ・ネットワーク断など)からの自動再接続。
// autostart=1 のときのみ有効。手動Stopでは再接続しない。
const AUTO_RESTART_DELAYS_MS = [2000, 5000, 10000];
let manualStop = false;
let autoRestartAttempt = 0;
let autoRestartTimer = null;

function scheduleAutoRestart() {
  if (!shouldAutostart || manualStop) {
    return;
  }
  if (autoRestartTimer) return;

  if (autoRestartAttempt >= AUTO_RESTART_DELAYS_MS.length) {
    resetButtons();
    setConnectionState("error");
    setStageMessage("再接続に失敗しました。Startボタンで再開してください。");
    return;
  }

  const delay = AUTO_RESTART_DELAYS_MS[autoRestartAttempt];
  autoRestartAttempt += 1;
  setStageMessage(`切断されました。${Math.round(delay / 1000)}秒後に再接続します...`);

  clearTimeout(autoRestartTimer);
  autoRestartTimer = setTimeout(async () => {
    autoRestartTimer = null;
    try {
      startBtn.disabled = true;
      stopBtn.disabled = false;
      await manager.start({ skipMicrophonePreflight: true });
      autoRestartAttempt = 0;
      scheduleHudHide();
    } catch (error) {
      console.error("auto-restart failed", error);
      scheduleAutoRestart();
    }
  }, delay);
}

const manager = createSessionManager({
  LivekitClient: window.LivekitClient,
  elements: {
    remoteVideo,
    remoteCanvas,
    remoteAudio,
    videoPlaceholder,
    subtitleBox,
    chromaKeyToggle
  },
  chromaKeyOptions: { minHue: 60, maxHue: 180, minSaturation: 0.1, threshold: 1.0 },
  showSubtitles,
  onConnectionStateChange: setConnectionState,
  onMicStateChange: setMicState,
  onLog: (message) => console.debug(message),
  onAudioBlocked: showAudioUnlockOverlay,
  onError: (error) => {
    console.error(error);
    setConnectionState("error");
    setMicState("error");
    if (error.requiresReconnect) {
      resetButtons();
      setStageMessage("接続を確認しています。操作係にお知らせください。");
    }
  },
  onDisconnected: () => {
    clearTimeout(hudHideTimer);
    setStageMessage("");
    resetButtons();
    scheduleAutoRestart();
  }
});

startBtn.addEventListener("click", async () => {
  showHudTemporarily();

  if (manager.isStarted()) {
    return;
  }

  manualStop = false;
  clearTimeout(autoRestartTimer);
  autoRestartTimer = null;
  autoRestartAttempt = 0;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  try {
    await manager.start();
    scheduleHudHide();
  } catch (error) {
    setConnectionState("error");
    setStageMessage(
      describeSessionError(error, { defaultMessage: "セッション開始に失敗しました。" })
    );
    resetButtons();
  }
});

stopBtn.addEventListener("click", async () => {
  showHudTemporarily();
  manualStop = true;
  clearTimeout(autoRestartTimer);
  autoRestartTimer = null;

  try {
    await manager.stop();
    setStageMessage("");
    resetButtons();
  } catch (error) {
    console.error(error);
  }
});

fullscreenBtn.addEventListener("click", async () => {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (error) {
    console.error(error);
  }

  showHudTemporarily();
});

remoteVideo.addEventListener("loadedmetadata", () => manager.updateChromaKey());
remoteVideo.addEventListener("playing", () => manager.updateChromaKey());

chromaKeyToggle?.addEventListener("change", () => {
  showHudTemporarily();
  manager.updateChromaKey();
});

document.addEventListener("mousemove", showHudTemporarily);

// 認証済み画面のオペレーター用ショートカット(?shortcuts=1 で有効)。
// 1/2/3=Voting分岐A/B/C、n=次へ(強制)、r=再発話。既存の f / s とは衝突しない。
let operatorBusy = false;
async function callOperatorApi(path, body = {}) {
  if (!operatorShortcuts || !manager.isStarted() || operatorBusy || !operatorState) {
    return;
  }
  operatorBusy = true;
  try {
    const response = await fetch(path, {
      signal: AbortSignal.timeout(8000),
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(operatorToken ? { authorization: `Bearer ${operatorToken}` } : {})
      },
      body: JSON.stringify({
        ...body,
        sessionId: manager.getSessionId(),
        expectedVersion: operatorState.version,
        expectedEpoch: operatorState.epoch
      })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data?.ok === false) {
      console.warn("operator api failed", path, data);
    } else {
      operatorState = data.state;
    }
  } catch (error) {
    console.error("operator api error", path, error);
  } finally {
    operatorBusy = false;
    refreshOperatorState();
  }
}

const OPERATOR_BRANCH_KEYS = { 1: "A", 2: "B", 3: "C" };

let operatorState = null;

function resolveOperatorBranch(slot) {
  const branches = operatorState?.awaitingBranches || [];
  const suffix = OPERATOR_BRANCH_KEYS[slot];
  return (
    branches.find((entry) => entry.branch.endsWith(`_${suffix}`))?.branch ||
    branches[slot - 1]?.branch ||
    null
  );
}

async function refreshOperatorState() {
  if (!operatorShortcuts || !manager.getSessionId()) {
    return;
  }

  try {
    const response = await fetch(
      `/api/operator/state?sessionId=${encodeURIComponent(manager.getSessionId() || "")}`,
      {
        signal: AbortSignal.timeout(8000),
        headers: operatorToken ? { authorization: `Bearer ${operatorToken}` } : {}
      }
    );
    const data = await response.json().catch(() => ({}));

    if (data?.ok) {
      operatorState = data.state;
    }
  } catch (error) {
    console.error("operator state error", error);
  }
}

if (operatorShortcuts) {
  setInterval(refreshOperatorState, 2000);
}

document.addEventListener("keydown", (event) => {
  if (event.repeat || event.target.closest?.("input, textarea, select, [contenteditable=true]"))
    return;
  const key = event.key.toLowerCase();

  if (key === "f") {
    fullscreenBtn.click();
  }

  // 本番表示(controls=0)では、キー誤操作でセッションが止まらないよう s を無効化する。
  if (key === "s" && !hideControls) {
    if (manager.isStarted()) {
      stopBtn.click();
    } else {
      startBtn.click();
    }
  }

  if (!operatorShortcuts) {
    return;
  }

  if (key === "1" || key === "2" || key === "3") {
    const branch = resolveOperatorBranch(Number(key));

    if (branch) {
      callOperatorApi("/api/operator/branch", { branch });
    }
  }

  if (key === "n") {
    callOperatorApi("/api/operator/next");
  }

  if (key === "r") {
    callOperatorApi("/api/operator/say");
  }
  if (key === "m") {
    callOperatorApi("/api/operator/input", { paused: !operatorState?.inputPaused });
  }
});

window.addEventListener("beforeunload", () => manager.dispose());

if (hideControls) {
  scheduleHudHide();
}

if (shouldAutostart) {
  window.addEventListener(
    "load",
    async () => {
      try {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        await manager.start({ skipMicrophonePreflight: true });
        scheduleHudHide();
      } catch (error) {
        console.error("autostart failed", error);
        setConnectionState("error");
        setStageMessage(
          describeSessionError(error, { defaultMessage: "セッション開始に失敗しました。" })
        );
        resetButtons();
        scheduleAutoRestart();
      }
    },
    { once: true }
  );
}
