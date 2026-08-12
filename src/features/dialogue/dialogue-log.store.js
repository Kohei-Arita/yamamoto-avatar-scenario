import crypto from "node:crypto";
import env from "../../config/env.js";

const logs = [];
const sessionBindings = new Map();

function nowIso() {
  return new Date().toISOString();
}

export function bindDebugSession(sessionId, meta = {}) {
  sessionBindings.set(sessionId, {
    sessionId,
    createdAt: nowIso(),
    ...meta
  });
}

export function appendDialogueLog(entry) {
  logs.push({
    id: crypto.randomUUID(),
    timestamp: nowIso(),
    ...entry
  });

  while (logs.length > env.dialogueLogLimit) {
    logs.shift();
  }
}

export function getDialogueLogs(sessionId) {
  const filtered = sessionId ? logs.filter((item) => item.sessionId === sessionId) : logs;
  return filtered.slice(-100);
}

export function getLatestBoundSessionId() {
  const values = Array.from(sessionBindings.values());
  return values.length > 0 ? values[values.length - 1].sessionId : null;
}
