const tokenInput = document.getElementById("tokenInput");
const connectBtn = document.getElementById("connectBtn");
const authState = document.getElementById("authState");
const stateSession = document.getElementById("stateSession");
const stateScene = document.getElementById("stateScene");
const stateNode = document.getElementById("stateNode");
const statePatient = document.getElementById("statePatient");
const stateIntent = document.getElementById("stateIntent");
const stateLines = document.getElementById("stateLines");
const branchButtons = document.getElementById("branchButtons");
const nextBtn = document.getElementById("nextBtn");
const sayBtn = document.getElementById("sayBtn");
const resetBtn = document.getElementById("resetBtn");
const jumpSelect = document.getElementById("jumpSelect");
const jumpBtn = document.getElementById("jumpBtn");
const actionResult = document.getElementById("actionResult");
const logList = document.getElementById("logList");

const POLL_INTERVAL_MS = 1500;
const BRANCH_LABELS = { A: "A", B: "B", C: "C" };

let token = sessionStorage.getItem("operatorToken") || "";
let pollTimer = null;
let knownNodeIds = [];

function authHeaders(extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    ...extra
  };
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: authHeaders(body !== undefined ? { "content-type": "application/json" } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));

  if (response.status === 401) {
    throw new Error("認証エラー: トークンが正しくありません");
  }

  if (response.status === 503) {
    throw new Error("サーバーに OPERATOR_TOKEN が設定されていません");
  }

  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `リクエスト失敗 (${response.status})`);
  }

  return data;
}

function describeBranch(branch) {
  const suffix = branch.split("_").at(-1);
  return BRANCH_LABELS[suffix] ? `${BRANCH_LABELS[suffix]}: ${branch}` : branch;
}

function renderBranches(state) {
  branchButtons.innerHTML = "";

  if (!state.awaitingBranches || state.awaitingBranches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "operator-muted";
    empty.textContent = state.isTerminal
      ? "終端ノードです（リセットで先頭へ戻せます）"
      : "分岐待機中のノードではありません";
    branchButtons.appendChild(empty);
    return;
  }

  for (const entry of state.awaitingBranches) {
    const button = document.createElement("button");
    button.textContent = `${describeBranch(entry.branch)} → ${entry.next}`;
    button.addEventListener("click", () => runAction("branch", { branch: entry.branch }));
    branchButtons.appendChild(button);
  }
}

function escapeHtml(value) {
  return String(value || "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char
  );
}

function renderLogs(logs = []) {
  logList.innerHTML = "";

  for (const log of [...logs].reverse()) {
    const entry = document.createElement("div");
    entry.className = "operator-log-entry";
    const time = String(log.timestamp || "").slice(11, 19);
    const deviation = log.deviation
      ? ` <span class="deviation">[逸脱:${escapeHtml(log.deviation)}]</span>`
      : "";
    const intent = log.intent
      ? ` intent=${escapeHtml(log.intent)}(${escapeHtml(log.intentMethod || "?")})`
      : "";
    const patient = log.userText ? `<div>患者: ${escapeHtml(log.userText)}</div>` : "";

    entry.innerHTML = `<div class="meta">${time} ${escapeHtml(log.kind || "")} node=${escapeHtml(log.nodeId || "-")}${intent}${deviation}</div>${patient}<div>山本: ${escapeHtml(log.answerPreview || "")}</div>`;
    logList.appendChild(entry);
  }
}

function renderJumpOptions(nodeIds) {
  if (JSON.stringify(nodeIds) === JSON.stringify(knownNodeIds)) {
    return;
  }

  knownNodeIds = nodeIds;
  jumpSelect.innerHTML = "";

  for (const nodeId of nodeIds) {
    const option = document.createElement("option");
    option.value = nodeId;
    option.textContent = nodeId;
    jumpSelect.appendChild(option);
  }
}

function renderState(data) {
  const state = data.state || {};
  const logs = data.logs || [];

  stateSession.textContent = state.sessionId || "-";
  stateScene.textContent = state.scene ?? "-";
  stateNode.textContent = `${state.nodeId || "-"}${state.placeholder ? "（仮置きテキスト）" : ""}`;
  stateLines.textContent = (state.doctorLines || []).join("\n") || "-";

  const lastPatientLog = [...logs]
    .reverse()
    .find((log) => log.userText !== undefined && log.userText !== null);
  statePatient.textContent = lastPatientLog?.normalizedUserText || lastPatientLog?.userText || "-";
  stateIntent.textContent = lastPatientLog
    ? lastPatientLog.intent
      ? `${lastPatientLog.intent} (${lastPatientLog.intentMethod || "?"})`
      : lastPatientLog.deviation
        ? `逸脱: ${lastPatientLog.deviation}`
        : "-"
    : "-";

  renderBranches(state);
  renderLogs(logs);

  renderJumpOptions(state.allNodeIds || []);
}

async function refresh() {
  try {
    const data = await api("/api/operator/state");
    authState.textContent = "接続中";
    renderState(data);
  } catch (error) {
    authState.textContent = error.message;
    stopPolling();
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
  refresh();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function runAction(action, body = {}) {
  try {
    actionResult.textContent = "実行中...";
    const path = `/api/operator/${action}`;
    const data = await api(path, { method: "POST", body });
    const delivery = data.delivery || {};
    actionResult.textContent = delivery.delivered
      ? `送信しました（${delivery.segmentCount}セグメント）`
      : "状態は更新しましたが、接続中のアバター画面がありません";
    renderState(data);
  } catch (error) {
    actionResult.textContent = `エラー: ${error.message}`;
  }
}

connectBtn.addEventListener("click", () => {
  token = tokenInput.value.trim();

  if (!token) {
    authState.textContent = "トークンを入力してください";
    return;
  }

  sessionStorage.setItem("operatorToken", token);
  startPolling();
});

nextBtn.addEventListener("click", () => runAction("next"));
sayBtn.addEventListener("click", () => runAction("say"));
resetBtn.addEventListener("click", () => {
  if (window.confirm("シナリオを先頭に戻します。よろしいですか？")) {
    runAction("reset");
  }
});
jumpBtn.addEventListener("click", () => {
  if (jumpSelect.value) {
    runAction("jump", { nodeId: jumpSelect.value });
  }
});

if (token) {
  tokenInput.value = token;
  startPolling();
}
