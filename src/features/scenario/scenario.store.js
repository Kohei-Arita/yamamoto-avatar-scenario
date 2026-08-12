import env from "../../config/env.js";

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
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  sessions.set(key, created);
  pruneSessions();
  return created;
}

export function moveScenarioSession(session, nodeId, via) {
  session.nodeId = nodeId;
  session.history.push({ nodeId, via, at: nowIso() });

  while (session.history.length > 200) {
    session.history.shift();
  }

  session.updatedAt = nowIso();
  return session;
}

export function resetScenarioSession(sessionId, entryNodeId) {
  sessions.delete(sessionId || "unbound-session");
  return getOrCreateScenarioSession(sessionId, entryNodeId);
}
