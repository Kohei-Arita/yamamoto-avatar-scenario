import env from "../../config/env.js";

const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function pruneSessions() {
  while (sessions.size > env.ragSessionLimit) {
    const oldestKey = sessions.keys().next().value;

    if (!oldestKey) {
      break;
    }

    sessions.delete(oldestKey);
  }
}

function normalizeMessage(message) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  const content = String(message?.content || "").trim();

  if (!content) {
    return null;
  }

  return {
    role,
    content,
    createdAt: nowIso()
  };
}

function getOrCreateSession(sessionId) {
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
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: []
  };

  sessions.set(key, created);
  pruneSessions();
  return created;
}

function trimMessages(messages) {
  return messages.slice(-env.ragConversationHistoryLimit);
}

export function initializeConversationSession(sessionId, { openingGreeting } = {}) {
  const session = getOrCreateSession(sessionId);

  if (session.messages.length === 0 && openingGreeting) {
    const greetingMessage = normalizeMessage({
      role: "assistant",
      content: openingGreeting
    });

    if (greetingMessage) {
      session.messages.push(greetingMessage);
    }
  }

  session.messages = trimMessages(session.messages);
  session.updatedAt = nowIso();

  return {
    sessionId: session.sessionId,
    messageCount: session.messages.length
  };
}

export function getConversationMessages(sessionId) {
  return [...getOrCreateSession(sessionId).messages].map(({ role, content }) => ({
    role,
    content
  }));
}

export function appendConversationTurn(sessionId, messages = []) {
  const session = getOrCreateSession(sessionId);
  const normalizedMessages = messages.map((message) => normalizeMessage(message)).filter(Boolean);

  if (normalizedMessages.length === 0) {
    return getConversationMessages(sessionId);
  }

  session.messages.push(...normalizedMessages);
  session.messages = trimMessages(session.messages);
  session.updatedAt = nowIso();

  return getConversationMessages(sessionId);
}
