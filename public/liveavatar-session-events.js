import { createSelfControlledConversation } from "./liveavatar-self-controller.js";

const AGENT_RESPONSE_TOPIC = "agent-response";

export function createLiveAvatarDataHandler({
  getSelfControlledConversation = () => null,
  onUserTranscription = () => {},
  onSessionStopped = () => {}
} = {}) {
  const decoder = new TextDecoder();

  return function handleDataReceived(payload, participant, kind, topic) {
    if (topic !== AGENT_RESPONSE_TOPIC) return;
    let event;
    try {
      event = JSON.parse(decoder.decode(payload));
    } catch {
      return; // データチャンネル上のJSON以外のメッセージ。
    }
    if (!event || typeof event !== "object") return;
    getSelfControlledConversation()?.handleAgentResponseEvent(event);
    if (event.event_type === "user.transcription" && event.text) onUserTranscription(event.text);
    if (event.event_type === "session.stopped") onSessionStopped(event);
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
  onError = () => {},
  onInputTimeout = async () => {},
  onMicStateChange = () => {},
  microphoneInitiallyMuted = false
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
    onMicStateChange,
    onInputTimeout,
    microphoneInitiallyMuted,
    respondToTextStream: ({
      sessionId,
      text,
      revision,
      expectedVersion,
      signal,
      onSpeechSegment
    }) =>
      respondWithDialogueStream(sessionId, text, {
        signal,
        revision,
        expectedVersion,
        onEvent: async (event) => {
          if (event.type === "speech_segment" && (event.data?.speechText || event.data?.text)) {
            await onSpeechSegment({
              state: event.data.state,
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
