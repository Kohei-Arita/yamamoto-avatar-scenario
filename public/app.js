import { createSessionManager } from "./liveavatar-session-manager.js";
import { describeSessionError } from "./liveavatar-session-ui.js";

const remoteVideo = document.getElementById("remoteVideo");
const remoteCanvas = document.getElementById("remoteCanvas");
const remoteAudio = document.getElementById("remoteAudio");
const videoPlaceholder = document.getElementById("videoPlaceholder");
const subtitleBox = document.getElementById("subtitleBox");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const chromaKeyToggle = document.getElementById("chromaKeyToggle");
const logEl = document.getElementById("log");
const ragLogEl = document.getElementById("ragLog");
const connectionStateEl = document.getElementById("connectionState");
const micStateEl = document.getElementById("micState");
const configWarningEl = document.getElementById("configWarning");
const modeValueEl = document.getElementById("modeValue");
const sandboxValueEl = document.getElementById("sandboxValue");
const avatarValueEl = document.getElementById("avatarValue");
const languageValueEl = document.getElementById("languageValue");

let ragPollTimer = null;

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

function setRagLogText(text) {
  if (ragLogEl) ragLogEl.textContent = text;
}

function resetDebugUi() {
  stopRagPolling();
  setRagLogText("");
  videoPlaceholder.classList.remove("hidden");
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

function describeMissingPersona(config) {
  const messages = [];

  if (config.selfControlled) {
    messages.push(
      "Self-controlled mode が有効です。LiveAvatar は文字起こしとアバター再生だけを担当し、応答本文はこのサーバーの RAG で生成します。"
    );
  }

  if (!config.selfControlled && !config.hasLlmConfigurationId) {
    messages.push(
      "Custom LLM を使う場合は `LIVEAVATAR_LLM_CONFIGURATION_ID` を設定してください。未設定なら Full mode 既定の LLM が使われます。"
    );
  }

  if (!config.selfControlled && !config.hasContextId && !config.hasVoiceId) {
    messages.push(
      "`LIVEAVATAR_CONTEXT_ID` と `LIVEAVATAR_VOICE_ID` が未設定です。接続はできても会話や声の挙動が期待通りにならない可能性があります。"
    );
  }

  if (!config.selfControlled && !config.hasContextId) {
    messages.push(
      "`LIVEAVATAR_CONTEXT_ID` が未設定です。FULL mode でも返答が成立しない場合があります。"
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
    subtitleBox,
    chromaKeyToggle
  },
  chromaKeyOptions: { minHue: 60, maxHue: 180, minSaturation: 0.1, threshold: 1.0 },
  verbose: true,
  onLog: log,
  onConnectionStateChange: setConnectionState,
  onMicStateChange: setMicState,
  onRagAnswer: (result) => log("RAG answer", { content: result.content }),
  onError: (error) => log("Error:", error.message),
  onDisconnected: () => resetDebugUi()
});

async function refreshRagLogs() {
  const sessionId = manager.getSessionId();

  if (!sessionId || !ragLogEl) {
    return;
  }

  const response = await fetch(`/api/dialogue/logs?sessionId=${encodeURIComponent(sessionId)}`);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.ok === false) {
    return;
  }

  setRagLogText(
    (data.logs || [])
      .map((entry) =>
        [
          `[${entry.timestamp}] ${entry.kind}`,
          `needsRag: ${String(entry.needsRag)}`,
          `routeReason: ${entry.routeReason || "-"}`,
          `queryIntent: ${entry.queryIntent || "-"}`,
          `retrievalStage: ${entry.retrievalStage || "-"}`,
          `matchedTerms: ${JSON.stringify(entry.matchedTerms || [])}`,
          `sourceIds: ${JSON.stringify(entry.sourceIds || [])}`,
          `userText: ${entry.userText || "-"}`,
          `normalizedUserText: ${entry.normalizedUserText || "-"}`,
          `transcriptRepairs: ${JSON.stringify(entry.transcriptRepairs || [])}`,
          `latencyMs: ${entry.latencyMs || "-"}`,
          `topHits: ${JSON.stringify(entry.topHits || [], null, 2)}`,
          `answerPreview: ${entry.answerPreview || "-"}`,
          ""
        ].join("\n")
      )
      .join("\n")
  );
}

function startRagPolling() {
  if (!ragLogEl || !manager.getSessionId()) {
    return;
  }

  clearInterval(ragPollTimer);
  ragPollTimer = setInterval(() => {
    refreshRagLogs().catch((error) => {
      log("RAG log refresh failed:", error.message);
    });
  }, 2000);
}

function stopRagPolling() {
  clearInterval(ragPollTimer);
  ragPollTimer = null;
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
    await refreshRagLogs();
    startRagPolling();
    log("Ready. Sandbox sessions are short, so expect disconnects around the one-minute mark.");
  } catch (error) {
    log("Start failed:", describeSessionError(error));
    resetDebugUi();
  }
});

stopBtn.addEventListener("click", async () => {
  log("=== Stop session ===");
  stopRagPolling();
  setRagLogText("");
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
