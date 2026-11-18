import { createSessionManager } from "./liveavatar-session-manager.js";
import { describeSessionError } from "./liveavatar-session-ui.js";

const remoteVideo = document.getElementById("remoteVideo");
const remoteCanvas = document.getElementById("remoteCanvas");
const remoteAudio = document.getElementById("remoteAudio");
const videoPlaceholder = document.getElementById("videoPlaceholder");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const chromaKeyToggle = document.getElementById("chromaKeyToggle");
const logEl = document.getElementById("log");
const dialogueLogEl = document.getElementById("dialogueLog");
const connectionStateEl = document.getElementById("connectionState");
const micStateEl = document.getElementById("micState");
const configWarningEl = document.getElementById("configWarning");
const modeValueEl = document.getElementById("modeValue");
const sandboxValueEl = document.getElementById("sandboxValue");
const avatarValueEl = document.getElementById("avatarValue");
const languageValueEl = document.getElementById("languageValue");

let dialoguePollTimer = null;

function log(...args) {
  const text = args
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value, null, 2)))
    .join(" ");

  logEl.textContent += `${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log(...args);
}

function setConnectionState(value) {
  connectionStateEl.textContent = value;
}

function setMicState(value) {
  micStateEl.textContent = value;
}

function setConfigWarning(message) {
  if (!message) {
    configWarningEl.classList.add("hidden");
    configWarningEl.textContent = "";
    return;
  }

  configWarningEl.classList.remove("hidden");
  configWarningEl.textContent = message;
}

function setDialogueLogText(text) {
  if (dialogueLogEl) dialogueLogEl.textContent = text;
}

function resetDebugUi() {
  stopDialoguePolling();
  setDialogueLogText("");
  videoPlaceholder.classList.remove("hidden");
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

function describeMissingPersona(config) {
  const messages = [];

  if (config.selfControlled) {
    messages.push(
      "Self-controlled mode が有効です。LiveAvatar は文字起こしとアバター再生だけを担当し、応答セリフはこのサーバーのシナリオエンジンが決定します。"
    );
  }

  if (!config.hasVoiceId) {
    messages.push("`LIVEAVATAR_VOICE_ID` は未設定です。アバター既定の voice が使われます。");
  }

  return [...new Set(messages)].join(" ");
}

const manager = createSessionManager({
  LivekitClient: window.LivekitClient,
  elements: {
    remoteVideo,
    remoteCanvas,
    remoteAudio,
    videoPlaceholder,
    chromaKeyToggle
  },
  chromaKeyOptions: { minHue: 60, maxHue: 180, minSaturation: 0.1, threshold: 1.0 },
  verbose: true,
  onLog: log,
  onConnectionStateChange: setConnectionState,
  onMicStateChange: setMicState,
  onAnswer: (result) => log("Scenario answer", { content: result.content }),
  onError: (error) => log("Error:", error.message),
  onDisconnected: () => resetDebugUi()
});

async function refreshDialogueLogs() {
  const sessionId = manager.getSessionId();

  if (!sessionId || !dialogueLogEl) {
    return;
  }

  const response = await fetch(`/api/dialogue/logs?sessionId=${encodeURIComponent(sessionId)}`);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.ok === false) {
    return;
  }

  setDialogueLogText(
    (data.logs || [])
      .map((entry) =>
        [
          `[${entry.timestamp}] ${entry.kind}`,
          `nodeId: ${entry.nodeId || "-"} (scene ${entry.scene ?? "-"})`,
          `intent: ${entry.intent || "-"}${entry.intentMethod ? ` (${entry.intentMethod})` : ""}`,
          `deviation: ${entry.deviation || "-"}`,
          `userText: ${entry.userText || "-"}`,
          `normalizedUserText: ${entry.normalizedUserText || "-"}`,
          `transcriptRepairs: ${JSON.stringify(entry.transcriptRepairs || [])}`,
          `latencyMs: ${entry.latencyMs ?? "-"}`,
          `answerPreview: ${entry.answerPreview || "-"}`,
          ""
        ].join("\n")
      )
      .join("\n")
  );
}

function startDialoguePolling() {
  if (!dialogueLogEl || !manager.getSessionId()) {
    return;
  }

  clearInterval(dialoguePollTimer);
  dialoguePollTimer = setInterval(() => {
    refreshDialogueLogs().catch((error) => {
      log("Dialogue log refresh failed:", error.message);
    });
  }, 2000);
}

function stopDialoguePolling() {
  clearInterval(dialoguePollTimer);
  dialoguePollTimer = null;
}

startBtn.addEventListener("click", async () => {
  if (manager.isStarted()) {
    return;
  }

  startBtn.disabled = true;
  stopBtn.disabled = false;
  log("=== Start session ===");

  try {
    await manager.start();
    await refreshDialogueLogs();
    startDialoguePolling();
    log("接続完了。台本に沿って進行できます。");
  } catch (error) {
    log("Start failed:", describeSessionError(error));
    resetDebugUi();
  }
});

stopBtn.addEventListener("click", async () => {
  log("=== Stop session ===");
  stopDialoguePolling();
  setDialogueLogText("");
  await manager.stop();
  startBtn.disabled = false;
  stopBtn.disabled = true;
});

remoteVideo.addEventListener("loadedmetadata", () => manager.updateChromaKey());
remoteVideo.addEventListener("playing", () => manager.updateChromaKey());
chromaKeyToggle?.addEventListener("change", () => manager.updateChromaKey());

window.addEventListener("beforeunload", () => manager.dispose());

manager
  .loadConfig()
  .then((config) => {
    modeValueEl.textContent = config.mode;
    sandboxValueEl.textContent = config.isSandbox ? "true" : "false";
    avatarValueEl.textContent = config.avatarId;
    languageValueEl.textContent = config.language;
    setConfigWarning(describeMissingPersona(config));
  })
  .catch((error) => {
    log("Config load failed:", error.message);
    setConfigWarning(
      "設定の読み込みに失敗しました。サーバー起動状態と `.env` を確認してください。"
    );
  });
