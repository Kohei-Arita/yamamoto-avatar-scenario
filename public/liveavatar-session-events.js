import { createSelfControlledConversation } from "./liveavatar-self-controller.js";
import { createSpeechBatchBuffer } from "./speech-batch.js";

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
  onLog = () => {},
  onAnswer = () => {},
  onError = () => {},
  onInputTimeout = async () => {},
  onPlaybackState = () => {},
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
    respondToTextStream: async ({
      sessionId,
      text,
      revision,
      expectedVersion,
      expectedEpoch,
      signal,
      onSpeechSegment
    }) => {
      const buffer = createSpeechBatchBuffer();
      const result = await respondWithDialogueStream(sessionId, text, {
        signal,
        revision,
        expectedVersion,
        expectedEpoch,
        onEvent: async (event) => {
          if (event.type === "speech_segment" && (event.data?.speechText || event.data?.text)) {
            const batch = buffer.add({
              speechId: event.data.speechId,
              segmentIndex: event.data.segmentIndex,
              segmentCount: event.data.segmentCount,
              state: event.data.state,
              speechText: event.data?.speechText || event.data?.text || "",
              subtitleText:
                event.data?.subtitleText || event.data?.speechText || event.data?.text || ""
            });
            if (batch) for (const segment of batch) await onSpeechSegment(segment);
          }
        }
      });
      if (buffer.incomplete)
        throw new Error("台詞を最後まで受信できませんでした。操作画面から再発話してください。");
      return result;
    },
    onLog,
    onAnswer,
    onSpeechStart: () => {
      onPlaybackState("speaking");
    },
    onSpeechIdle: () => {
      onPlaybackState("idle");
    },
    onError
  });
}
