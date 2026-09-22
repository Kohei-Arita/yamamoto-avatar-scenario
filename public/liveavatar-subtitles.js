const AVATAR_SUBTITLE_END_TOKENS = ["end_message", "stop_talking", "speak_ended"];

export function normalizeSubtitleText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getAvatarSubtitleEventType(event) {
  if (!event || typeof event !== "object") {
    return "";
  }

  return String(event.event_type || event.eventType || event.type || "").trim();
}

export function isAvatarSubtitleEndEvent(event) {
  const normalizedType = getAvatarSubtitleEventType(event).toLowerCase();

  if (!normalizedType.startsWith("avatar.") && !normalizedType.startsWith("avatar_")) {
    return false;
  }

  return AVATAR_SUBTITLE_END_TOKENS.some((token) => normalizedType.includes(token));
}
