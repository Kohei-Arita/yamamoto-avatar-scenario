const AVATAR_SPEECH_END_TOKENS = ["end_message", "stop_talking", "speak_ended"];

export function normalizeSpeechText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getAvatarSpeechEventType(event) {
  if (!event || typeof event !== "object") {
    return "";
  }

  return String(event.event_type || event.eventType || event.type || "").trim();
}

export function isAvatarSpeechEndEvent(event) {
  const normalizedType = getAvatarSpeechEventType(event).toLowerCase();

  if (!normalizedType.startsWith("avatar.") && !normalizedType.startsWith("avatar_")) {
    return false;
  }

  return AVATAR_SPEECH_END_TOKENS.some((token) => normalizedType.includes(token));
}
