import { createSessionManager } from "./liveavatar-session-manager.js";
import { describeSessionError } from "./liveavatar-session-ui.js";

const remoteVideo = document.getElementById("remoteVideo");
const remoteCanvas = document.getElementById("remoteCanvas");
const remoteAudio = document.getElementById("remoteAudio");
const videoPlaceholder = document.getElementById("videoPlaceholder");
const subtitleBox = document.getElementById("subtitleBox");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const chromaKeyToggle = document.getElementById("chromaKeyToggle");
const connectionStateEl = document.getElementById("connectionState");
const micStateEl = document.getElementById("micState");

const params = new URLSearchParams(window.location.search);
const operatorToken = params.get("optoken") || "";
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
  onError: (error) => console.error(error),
  onDisconnected: () => {
    clearTimeout(hudHideTimer);
    setStageMessage("");
    resetButtons();
  }
});

startBtn.addEventListener("click", async () => {
  showHudTemporarily();

  if (manager.isStarted()) {
    return;
  }

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

// オペレーター用ショートカット(?optoken=<OPERATOR_TOKEN> 付きで開いた場合のみ有効)。
// 1/2/3=Voting分岐A/B/C、n=次へ(強制)、r=再発話。既存の f / s とは衝突しない。
async function callOperatorApi(path, body = {}) {
  if (!operatorToken) {
    return;
  }

  try {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${operatorToken}`
      },
      body: JSON.stringify({ ...body, sessionId: manager.getSessionId() })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data?.ok === false) {
      console.warn("operator api failed", path, data);
    }
  } catch (error) {
    console.error("operator api error", path, error);
  }
}

const OPERATOR_BRANCH_KEYS = { 1: "A", 2: "B", 3: "C" };

function resolveOperatorBranch(slot) {
  const state = window.__operatorState;
  const branches = state?.awaitingBranches || [];
  const suffix = OPERATOR_BRANCH_KEYS[slot];
  return (
    branches.find((entry) => entry.branch.endsWith(`_${suffix}`))?.branch ||
    branches[slot - 1]?.branch ||
    null
  );
}

async function refreshOperatorState() {
  if (!operatorToken) {
    return;
  }

  try {
    const response = await fetch(
      `/api/operator/state?sessionId=${encodeURIComponent(manager.getSessionId() || "")}`,
      { headers: { authorization: `Bearer ${operatorToken}` } }
    );
    const data = await response.json().catch(() => ({}));

    if (data?.ok) {
      window.__operatorState = data.state;
    }
  } catch (error) {
    console.error("operator state error", error);
  }
}

if (operatorToken) {
  setInterval(refreshOperatorState, 2000);
}

document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();

  if (key === "f") {
    fullscreenBtn.click();
  }

  if (key === "s") {
    if (manager.isStarted()) {
      stopBtn.click();
    } else {
      startBtn.click();
    }
  }

  if (!operatorToken) {
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
      }
    },
    { once: true }
  );
}
