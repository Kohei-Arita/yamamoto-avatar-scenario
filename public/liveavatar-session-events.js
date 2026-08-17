import { createSelfControlledConversation } from "./liveavatar-self-controller.js";
import { extractAvatarSubtitleText, isAvatarSubtitleEndEvent } from "./liveavatar-subtitles.js";

const AGENT_RESPONSE_TOPIC = "agent-response";

export function createLiveAvatarDataHandler({
  getSelfControlledConversation = () => null,
  isSelfControlled = () => false,
  subtitleController,
  onUserTranscription = () => {},
  onAvatarSubtitle = () => {},
  onSessionStopped = () => {}
} = {}) {
  const decoder = new TextDecoder();

  return function handleDataReceived(payload, participant, kind, topic) {
    try {
      const event = JSON.parse(decoder.decode(payload));

      if (topic !== AGENT_RESPONSE_TOPIC) {
        return;
      }

      const selfControlled = isSelfControlled();

      if (selfControlled) {
        getSelfControlledConversation()?.handleAgentResponseEvent(event);
      }

      if (event.event_type === "user.transcription" && event.text) {
        onUserTranscription(event.text);
      }

      if (!selfControlled) {
        const subtitleText = extractAvatarSubtitleText(event);

        if (subtitleText) {
          subtitleController?.set(subtitleText);
          onAvatarSubtitle(subtitleText);
        }

        if (isAvatarSubtitleEndEvent(event)) {
          subtitleController?.clearSoon();
        }
      }

      if (event.event_type === "session.stopped") {
        onSessionStopped(event);
      }
    } catch {
      // Ignore non-JSON or unexpected data payloads.
    }
  };
}

export function createSelfControlledSession({
  getRoom,
  getSessionId,
  liveAvatarConfig,
  respondWithDialogueStream,
  subtitleController,
  onLog = () => {},
  onAnswer = () => {},
  onError = () => {}
} = {}) {
  if (!liveAvatarConfig?.selfControlled) {
    return null;
  }

  return createSelfControlledConversation({
    getRoom,
    getSessionId,
    debounceMs: liveAvatarConfig.transcriptDebounceMs || 1200,
    continuationWindowMs: liveAvatarConfig.transcriptContinuationMs || 1800,
    allowInterrupt: liveAvatarConfig.allowInterrupt !== false,
    respondToTextStream: ({ sessionId, text, revision, signal, onSpeechSegment }) =>
      respondWithDialogueStream(sessionId, text, {
        signal,
        revision,
        onEvent: async (event) => {
          if (event.type === "speech_segment" && (event.data?.speechText || event.data?.text)) {
            await onSpeechSegment({
              speechText: event.data?.speechText || event.data?.text || "",
              subtitleText:
                event.data?.subtitleText || event.data?.speechText || event.data?.text || ""
            });
          }
        }
      }),
    onLog,
    onAnswer,
    onSpeechStart: (text) => {
      subtitleController?.set(text);
    },
    onSpeechIdle: () => {
      subtitleController?.clearSoon();
    },
    onSpeechReset: () => {
      subtitleController?.clearNow();
    },
    onError
  });
}

export async function startOpeningGreeting(liveAvatarConfig, selfControlledConversation) {
  if (!liveAvatarConfig?.selfControlled) {
    return;
  }

  const openingGreeting = String(liveAvatarConfig.openingGreeting || "").trim();

  if (!openingGreeting) {
    return;
  }

  await selfControlledConversation?.speakText(openingGreeting);
}
