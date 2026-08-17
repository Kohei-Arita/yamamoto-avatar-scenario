import env from "../../config/env.js";

// セッション再接続後の進行引き継ぎを許可する時間窓。
// これを超えて古い進行は引き継がない(前回公演の残骸を持ち込まないため)。
const ADOPT_MAX_AGE_MS = 10 * 60 * 1000;

const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function pruneSessions() {
  while (sessions.size > env.dialogueSessionLimit) {
    const oldestKey = sessions.keys().next().value;

    if (!oldestKey) {
      break;
    }

    sessions.delete(oldestKey);
  }
}

export function getOrCreateScenarioSession(sessionId, entryNodeId) {
  const key = sessionId || "unbound-session";
  const existing = sessions.get(key);

  if (existing) {
    existing.updatedAt = nowIso();
    sessions.delete(key);
    sessions.set(key, existing);
    return existing;
  }

  const created = {
    sessionId: key,
    nodeId: entryNodeId,
    history: [{ nodeId: entryNodeId, via: "entry", at: nowIso() }],
    // 直前の患者発話による遷移(遷移元ノードと時刻)。発話の言い直し(revision)時の巻き戻しに使う。
    lastPatientMove: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  sessions.set(key, created);
  pruneSessions();
  return created;
}

export function moveScenarioSession(session, nodeId, via) {
  const fromNodeId = session.nodeId;
  session.nodeId = nodeId;
  session.history.push({ nodeId, via, at: nowIso() });

  while (session.history.length > 200) {
    session.history.shift();
  }

  // 患者発話による遷移だけを言い直し巻き戻しの対象として記録する。
  // operator操作(branch/next/jump/reset)が入ったら巻き戻し対象を消す。
  if (via === "patient_any" || via.startsWith("intent:")) {
    session.lastPatientMove = { fromNodeId, at: Date.now() };
  } else {
    session.lastPatientMove = null;
  }

  session.updatedAt = nowIso();
  return session;
}

// 患者発話の言い直し(revision)時に、直前の患者遷移を取り消して遷移元ノードへ戻す。
export function rewindLastPatientMove(session, { maxAgeMs = 15_000 } = {}) {
  const lastMove = session.lastPatientMove;

  if (!lastMove || Date.now() - lastMove.at > maxAgeMs) {
    return false;
  }

  session.nodeId = lastMove.fromNodeId;
  session.history.push({ nodeId: lastMove.fromNodeId, via: "revision_rewind", at: nowIso() });
  session.lastPatientMove = null;
  session.updatedAt = nowIso();
  return true;
}

// セッション再接続時に、旧セッションの進行状態を新セッションへ引き継ぐ。
// 旧セッションが存在し、entryノード以外まで進んでいて、最近更新されている場合のみ。
export function adoptScenarioSession(fromSessionId, toSessionId, entryNodeId) {
  const source = sessions.get(fromSessionId || "");

  if (!source || fromSessionId === toSessionId) {
    return false;
  }

  if (source.nodeId === entryNodeId) {
    return false;
  }

  if (Date.now() - new Date(source.updatedAt).getTime() > ADOPT_MAX_AGE_MS) {
    return false;
  }

  const target = getOrCreateScenarioSession(toSessionId, entryNodeId);
  target.nodeId = source.nodeId;
  target.history = [...source.history, { nodeId: source.nodeId, via: "adopted", at: nowIso() }];
  target.lastPatientMove = null;
  target.updatedAt = nowIso();
  return true;
}

export function resetScenarioSession(sessionId, entryNodeId) {
  sessions.delete(sessionId || "unbound-session");
  return getOrCreateScenarioSession(sessionId, entryNodeId);
}
