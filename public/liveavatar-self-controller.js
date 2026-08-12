import { isAvatarSubtitleEndEvent, normalizeSubtitleText } from "./liveavatar-subtitles.js";

const AGENT_CONTROL_TOPIC = "agent-control";
const EVENT_META_NESTED_KEYS = ["data", "payload", "message", "detail", "result", "metadata"];

function normalizeTranscript(parts) {
  return normalizeSubtitleText(parts.join(""));
}

function createClientId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeMetaValue(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function pickNestedMetaValue(source, candidateKeys, seen = new Set()) {
  if (!source || typeof source !== "object") {
    return "";
  }

  if (seen.has(source)) {
    return "";
  }

  seen.add(source);

  for (const key of candidateKeys) {
    const value = normalizeMetaValue(source[key]);

    if (value) {
      return value;
    }
  }

  for (const key of EVENT_META_NESTED_KEYS) {
    const nestedValue = pickNestedMetaValue(source[key], candidateKeys, seen);

    if (nestedValue) {
      return nestedValue;
    }
  }

  return "";
}

function extractEventGenerationMeta(event) {
  return {
    responseId: pickNestedMetaValue(event, [
      "client_response_id",
      "clientResponseId",
      "response_id",
      "responseId"
    ]),
    generationId: pickNestedMetaValue(event, [
      "client_generation_id",
      "clientGenerationId",
      "generation_id",
      "generationId"
    ]),
    segmentId: pickNestedMetaValue(event, [
      "client_segment_id",
      "clientSegmentId",
      "segment_id",
      "segmentId"
    ])
  };
}

function normalizeSpeechSegment(segment) {
  if (typeof segment === "string") {
    const normalizedText = normalizeSubtitleText(segment);

    if (!normalizedText) {
      return null;
    }

    return {
      speechText: normalizedText,
      subtitleText: normalizedText
    };
  }

  const speechText = normalizeSubtitleText(segment?.speechText || segment?.text || "");
  const subtitleText = normalizeSubtitleText(
    segment?.subtitleText || segment?.speechText || segment?.text || ""
  );

  if (!speechText) {
    return null;
  }

  return {
    speechText,
    subtitleText: subtitleText || speechText
  };
}

function hasTerminalPunctuation(text) {
  return /[。！？?!]$/.test(String(text || "").trim());
}

export function createSelfControlledConversation({
  getRoom,
  getSessionId,
  respondToTextStream,
  debounceMs = 1200,
  continuationWindowMs = 1800,
  flushPollMs = 250,
  interruptGraceMs = 250,
  onLog = () => {},
  onAnswer = () => {},
  onSpeechStart = () => {},
  onSpeechIdle = () => {},
  onSpeechReset = () => {},
  onError = () => {}
}) {
  let bufferedTranscripts = [];
  let flushTimer = null;
  let generationId = 0;
  let isGenerating = false;
  let isSpeaking = false;
  let streamAbortController = null;
  let speechQueue = [];
  let isDispatchingSpeech = false;
  let activeSpeechSegment = null;
  let pendingSpeechSegment = null;
  let lastFinalizedTranscript = "";
  let lastFinalizedAt = 0;
  let dispatchResumeTimer = null;
  let interruptBarrierUntil = 0;

  function clearBuffer() {
    bufferedTranscripts = [];
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function clearSpeechQueue() {
    speechQueue = [];
  }

  function clearSpeechState() {
    clearSpeechQueue();
    activeSpeechSegment = null;
    pendingSpeechSegment = null;
    isSpeaking = false;
  }

  function clearDispatchResumeTimer() {
    clearTimeout(dispatchResumeTimer);
    dispatchResumeTimer = null;
  }

  function scheduleDispatchRetry(delayMs) {
    clearDispatchResumeTimer();
    dispatchResumeTimer = setTimeout(() => {
      dispatchResumeTimer = null;
      dispatchNextSpeech().catch((error) => {
        onError(error);
      });
    }, delayMs);
  }

  function isWithinInterruptBarrier() {
    return Date.now() < interruptBarrierUntil;
  }

  function hasCorrelationMeta(meta) {
    return Boolean(meta.responseId || meta.generationId || meta.segmentId);
  }

  function eventMatchesSegment(event, segment) {
    if (!segment) {
      return false;
    }

    const meta = extractEventGenerationMeta(event);

    if (meta.segmentId) {
      return meta.segmentId === segment.segmentId;
    }

    if (meta.responseId && meta.responseId !== segment.responseId) {
      return false;
    }

    if (meta.generationId && meta.generationId !== String(segment.generationId)) {
      return false;
    }

    return !hasCorrelationMeta(meta);
  }

  function buildQueuedSpeechSegment(segment, { segmentGenerationId, responseId }) {
    return {
      ...segment,
      generationId: segmentGenerationId,
      responseId,
      segmentId: createClientId("segment")
    };
  }

  function describeSegmentMeta(segment) {
    if (!segment) {
      return null;
    }

    return {
      responseId: segment.responseId,
      generationId: segment.generationId,
      segmentId: segment.segmentId
    };
  }

  function isUserSpeaking() {
    return Boolean(getRoom?.()?.localParticipant?.isSpeaking);
  }

  function hasActiveResponse() {
    return (
      isGenerating ||
      isSpeaking ||
      isDispatchingSpeech ||
      speechQueue.length > 0 ||
      Boolean(activeSpeechSegment) ||
      Boolean(pendingSpeechSegment)
    );
  }

  function rememberFinalizedTranscript(text) {
    lastFinalizedTranscript = text;
    lastFinalizedAt = Date.now();
  }

  function clearRecentFinalizedTranscript() {
    lastFinalizedTranscript = "";
    lastFinalizedAt = 0;
  }

  function shouldAppendToRecentTranscript() {
    return (
      hasActiveResponse() &&
      Boolean(lastFinalizedTranscript) &&
      !hasTerminalPunctuation(lastFinalizedTranscript) &&
      Date.now() - lastFinalizedAt <= continuationWindowMs
    );
  }

  async function publishControlEvent(event) {
    const room = getRoom();

    if (!room?.localParticipant) {
      throw new Error("LiveKit room is not connected");
    }

    const payload = new TextEncoder().encode(JSON.stringify(event));

    await room.localParticipant.publishData(payload, {
      reliable: true,
      topic: AGENT_CONTROL_TOPIC
    });
  }

  async function dispatchNextSpeech() {
    if (isSpeaking || isDispatchingSpeech || pendingSpeechSegment || speechQueue.length === 0) {
      return;
    }

    if (isWithinInterruptBarrier()) {
      scheduleDispatchRetry(Math.max(0, interruptBarrierUntil - Date.now()));
      return;
    }

    const nextSpeech = speechQueue.shift();

    if (!nextSpeech) {
      return;
    }

    isDispatchingSpeech = true;

    try {
      await publishControlEvent({
        event_type: "avatar.speak_text",
        text: nextSpeech.speechText,
        client_generation_id: String(nextSpeech.generationId),
        client_response_id: nextSpeech.responseId,
        client_segment_id: nextSpeech.segmentId
      });
      pendingSpeechSegment = nextSpeech;

      onLog(`avatar.speak_text: ${nextSpeech.speechText}`);
      onLog(
        `avatar.speak_text.meta: ${JSON.stringify({
          responseId: nextSpeech.responseId,
          generationId: nextSpeech.generationId,
          segmentId: nextSpeech.segmentId
        })}`
      );
    } catch (error) {
      speechQueue.unshift(nextSpeech);
      pendingSpeechSegment = null;
      throw error;
    } finally {
      isDispatchingSpeech = false;
    }
  }

  async function queueSpeech(segment, { segmentGenerationId = generationId, responseId } = {}) {
    const normalizedSegment = normalizeSpeechSegment(segment);

    if (!normalizedSegment) {
      return;
    }

    speechQueue.push(
      buildQueuedSpeechSegment(normalizedSegment, {
        segmentGenerationId,
        responseId: responseId || createClientId("response")
      })
    );
    await dispatchNextSpeech();
  }

  async function interruptAvatar() {
    try {
      await publishControlEvent({ event_type: "avatar.interrupt" });
    } catch (error) {
      onLog(`avatar.interrupt failed: ${error.message}`);
    }
  }

  function cancelCurrentResponse() {
    generationId += 1;
    isGenerating = false;
    interruptBarrierUntil = Date.now() + interruptGraceMs;
    clearSpeechState();
    clearDispatchResumeTimer();
    streamAbortController?.abort();
    streamAbortController = null;
    onSpeechReset();
    interruptAvatar().catch(() => {});
  }

  async function flushBufferedTranscripts() {
    const combinedText = normalizeTranscript(bufferedTranscripts);

    clearBuffer();

    if (!combinedText) {
      return;
    }

    const currentGenerationId = ++generationId;
    const responseId = createClientId("response");
    isGenerating = true;
    streamAbortController = new AbortController();
    rememberFinalizedTranscript(combinedText);
    onLog(`user.transcription.final: ${combinedText}`);

    try {
      const result = await respondToTextStream({
        sessionId: getSessionId(),
        text: combinedText,
        signal: streamAbortController.signal,
        onSpeechSegment: async (segment) => {
          if (currentGenerationId !== generationId) {
            return;
          }

          await queueSpeech(segment, {
            segmentGenerationId: currentGenerationId,
            responseId
          });
        }
      });

      if (currentGenerationId !== generationId) {
        return;
      }

      onAnswer(result);
      isGenerating = false;
      streamAbortController = null;
    } catch (error) {
      if (currentGenerationId !== generationId) {
        return;
      }

      if (streamAbortController?.signal.aborted || error.name === "AbortError") {
        streamAbortController = null;
        return;
      }

      isGenerating = false;
      streamAbortController = null;
      onError(error);

      const fallbackText = "内部エラーが発生しました。もう一度お願いします。";

      try {
        await queueSpeech(fallbackText, {
          segmentGenerationId: currentGenerationId,
          responseId
        });
      } catch (publishError) {
        onLog(`avatar.speak_text failed: ${publishError.message}`);
      }
    }
  }

  function scheduleFlush(delayMs = debounceMs) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      if (bufferedTranscripts.length > 0 && isUserSpeaking()) {
        onLog("user.transcription.waiting_for_silence");
        scheduleFlush(flushPollMs);
        return;
      }

      flushBufferedTranscripts().catch((error) => {
        onError(error);
      });
    }, delayMs);
  }

  function enqueueUserTranscript(text) {
    const normalizedText = String(text || "").trim();

    if (!normalizedText) {
      return;
    }

    const appendToRecentTranscript = shouldAppendToRecentTranscript();

    if (hasActiveResponse()) {
      cancelCurrentResponse();
    }

    if (appendToRecentTranscript && bufferedTranscripts.length === 0) {
      bufferedTranscripts.push(lastFinalizedTranscript);
      onLog(`user.transcription.resume: ${lastFinalizedTranscript}`);
    }

    bufferedTranscripts.push(normalizedText);
    scheduleFlush();
  }

  function handleAgentResponseEvent(event) {
    if (!event || typeof event !== "object") {
      return;
    }

    if (event.event_type === "user.transcription" && event.text) {
      enqueueUserTranscript(event.text);
      return;
    }

    if (event.event_type === "avatar.speak_started") {
      if (activeSpeechSegment && eventMatchesSegment(event, activeSpeechSegment)) {
        return;
      }

      if (!pendingSpeechSegment) {
        if (hasCorrelationMeta(extractEventGenerationMeta(event)) || isWithinInterruptBarrier()) {
          onLog(`avatar.speak_started ignored: ${JSON.stringify(extractEventGenerationMeta(event))}`);
        }
        return;
      }

      if (!eventMatchesSegment(event, pendingSpeechSegment)) {
        onLog(
          `avatar.speak_started ignored: ${JSON.stringify({
            event: extractEventGenerationMeta(event),
            pending: describeSegmentMeta(pendingSpeechSegment)
          })}`
        );
        return;
      }

      const speechSegment = pendingSpeechSegment;
      pendingSpeechSegment = null;
      activeSpeechSegment = speechSegment;
      isSpeaking = true;
      onSpeechStart(speechSegment?.subtitleText || speechSegment?.speechText || "");
      return;
    }

    if (isAvatarSubtitleEndEvent(event)) {
      if (!activeSpeechSegment) {
        if (hasCorrelationMeta(extractEventGenerationMeta(event)) || isWithinInterruptBarrier()) {
          onLog(`avatar.speak_end ignored: ${JSON.stringify(extractEventGenerationMeta(event))}`);
        }
        return;
      }

      if (!eventMatchesSegment(event, activeSpeechSegment)) {
        onLog(
          `avatar.speak_end ignored: ${JSON.stringify({
            event: extractEventGenerationMeta(event),
            active: describeSegmentMeta(activeSpeechSegment)
          })}`
        );
        return;
      }

      activeSpeechSegment = null;
      isSpeaking = false;

      if (speechQueue.length === 0 && !pendingSpeechSegment) {
        onSpeechIdle();
      }

      dispatchNextSpeech().catch((error) => {
        onError(error);
      });
    }
  }

  function reset() {
    cancelCurrentResponse();
    clearBuffer();
    clearRecentFinalizedTranscript();
  }

  return {
    handleAgentResponseEvent,
    interruptAvatar,
    speakText: queueSpeech,
    reset
  };
}
