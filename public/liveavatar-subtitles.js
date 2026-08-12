const AVATAR_SUBTITLE_END_TOKENS = ["end_message", "stop_talking", "speak_ended"];
const AVATAR_SUBTITLE_UPDATE_TOKENS = ["transcription", "talking_message"];
const SUBTITLE_TEXT_KEYS = ["text", "message", "content", "caption", "transcript", "utterance"];

function normalizeEventTypeValue(value) {
  return String(value || "").trim();
}

function pickStringValue(source, seenObjects = new Set()) {
  if (!source) {
    return "";
  }

  if (typeof source === "string") {
    return normalizeSubtitleText(source);
  }

  if (typeof source !== "object") {
    return "";
  }

  if (seenObjects.has(source)) {
    return "";
  }

  seenObjects.add(source);

  for (const key of SUBTITLE_TEXT_KEYS) {
    const value = source[key];

    if (typeof value === "string") {
      const normalized = normalizeSubtitleText(value);

      if (normalized) {
        return normalized;
      }
    }
  }

  for (const key of ["data", "payload", "message", "detail", "result"]) {
    const nestedValue = pickStringValue(source[key], seenObjects);

    if (nestedValue) {
      return nestedValue;
    }
  }

  return "";
}

export function normalizeSubtitleText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getAvatarSubtitleEventType(event) {
  if (!event || typeof event !== "object") {
    return "";
  }

  return normalizeEventTypeValue(event.event_type || event.eventType || event.type);
}

export function extractAvatarSubtitleText(event) {
  const normalizedType = getAvatarSubtitleEventType(event).toLowerCase();

  if (!normalizedType) {
    return "";
  }

  if (!normalizedType.includes("avatar")) {
    return "";
  }

  const isKnownUpdateType = AVATAR_SUBTITLE_UPDATE_TOKENS.some((token) =>
    normalizedType.includes(token)
  );
  const looksLikeAvatarSpeechUpdate =
    normalizedType.includes("message") || normalizedType.includes("talking");

  if (!isKnownUpdateType && !looksLikeAvatarSpeechUpdate) {
    return "";
  }

  return pickStringValue(event);
}

export function isAvatarSubtitleEndEvent(event) {
  const normalizedType = getAvatarSubtitleEventType(event).toLowerCase();

  if (!normalizedType) {
    return false;
  }

  return AVATAR_SUBTITLE_END_TOKENS.some((token) => normalizedType.includes(token));
}
