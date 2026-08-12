import { sanitizeSpeechContent, sanitizeSubtitleContent } from "./speech-content.js";

const SENTENCE_END_PATTERN = /[。！？!?]/u;
const CLOSING_PUNCTUATION_PATTERN = /[」』）)\]"']/u;

function findSentenceBoundary(text = "") {
  const source = String(text || "");

  for (let index = 0; index < source.length; index += 1) {
    if (!SENTENCE_END_PATTERN.test(source[index])) {
      continue;
    }

    let boundary = index + 1;

    while (boundary < source.length && CLOSING_PUNCTUATION_PATTERN.test(source[boundary])) {
      boundary += 1;
    }

    return boundary;
  }

  return -1;
}

export function pullCompletedSpeechSegments(bufferText = "") {
  const segments = [];
  let remaining = String(bufferText || "");

  while (true) {
    const boundary = findSentenceBoundary(remaining);

    if (boundary < 0) {
      break;
    }

    const rawSegment = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary);

    const speechSegment = sanitizeSpeechContent(rawSegment);
    const subtitleSegment = sanitizeSubtitleContent(rawSegment);

    if (speechSegment || subtitleSegment) {
      segments.push({
        speechText: speechSegment,
        subtitleText: subtitleSegment
      });
    }
  }

  return { segments, remaining };
}

export function flushSpeechSegment(bufferText = "") {
  const speechText = sanitizeSpeechContent(bufferText);
  const subtitleText = sanitizeSubtitleContent(bufferText);

  if (!speechText && !subtitleText) {
    return null;
  }

  return {
    speechText,
    subtitleText
  };
}
