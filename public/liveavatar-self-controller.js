import { isAvatarSubtitleEndEvent, normalizeSubtitleText } from "./liveavatar-subtitles.js";
import { createMicrophoneController } from "./microphone-controller.js";
import { createEchoGuard } from "./transcript-echo-guard.js";
import { isSubstantiveTranscript } from "./transcript-filter.js";
import { createUserTurnDetector, MAX_USER_TURN_MS } from "./user-turn-detector.js";

const AGENT_CONTROL_TOPIC = "agent-control";

function normalizeTranscript(parts) {
  return normalizeSubtitleText(parts.join(""));
}

// LiveAvatarのsource_event_idを優先。旧クライアントID付きイベントも受け付ける。
function extractEventGenerationMeta(event) {
  return {
    responseId: String(event.client_response_id ?? ""),
    generationId: String(event.client_generation_id ?? ""),
    segmentId: String(event.source_event_id || event.client_segment_id || "")
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
  // 同じ発話への結合(継続扱い)を許す最大回数。上限がないと、雑音などで句点の付かない
  // 断片が継続時間内に届き続けた場合、結合が際限なく伸び続けてしまう。
  maxContinuationChainLength = 5,
  flushPollMs = 250,
  maxUserTurnMs = MAX_USER_TURN_MS,
  interruptGraceMs = 250,
  allowInterrupt = false,
  microphoneInitiallyMuted = false,
  // speak_started / speak_ended イベントの取りこぼしで発話キューが
  // 永久停止しないための保険(ウォッチドッグ)のタイムアウト設定。
  speakStartTimeoutMs = 6000,
  speakEndTimeoutBaseMs = 5000,
  speakEndTimeoutPerCharMs = 350,
  speakEndTimeoutMaxMs = 45000,
  // マイクのミュート/解除に失敗したときの再試行設定。特に「解除の失敗」を放置すると
  // 患者の声が二度と届かなくなるため、必ず再試行して実状態を追いつかせる。
  micSyncRetryMs = 500,
  micSyncMaxRetries = 5,
  echoGuard = createEchoGuard(),
  onLog = () => {},
  onAnswer = () => {},
  onSpeechStart = () => {},
  onSpeechIdle = () => {},
  onSpeechReset = () => {},
  onError = () => {},
  onInputTimeout = async () => {},
  onMicStateChange = () => {}
}) {
  let bufferedTranscripts = [];
  let bufferIsRevision = false;
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
  let finalizedChainLength = 0;
  let dispatchResumeTimer = null;
  let interruptBarrierUntil = 0;
  let speakStartWatchdogTimer = null;
  let speakEndWatchdogTimer = null;
  let disposed = false;
  let inputEnabled = true;
  let transportReady = true;
  let scenarioVersion;
  let speechFault = false;
  // response: 上限到達後の応答が終わるまで閉じる。operator: 聞き取りなしで操作待ち。
  let inputCutoff = null;
  const microphone = createMicrophoneController({
    getRoom,
    initialMuted: microphoneInitiallyMuted,
    retryMs: micSyncRetryMs,
    maxRetries: micSyncMaxRetries,
    onLog,
    onState: onMicStateChange,
    onError
  });
  const userTurn = createUserTurnDetector({
    getLocalSpeaking: () => Boolean(getRoom?.()?.localParticipant?.isSpeaking),
    silenceMs: debounceMs,
    maxDurationMs: maxUserTurnMs,
    pollMs: flushPollMs,
    onEnd: finishUserTurn,
    onLog
  });
  const localParticipant = getRoom?.()?.localParticipant;
  localParticipant?.on?.("isSpeakingChanged", handleLocalUserSpeechChange);

  function clearBuffer() {
    bufferedTranscripts = [];
    bufferIsRevision = false;
    userTurn.reset();
  }

  function clearSpeechWatchdogs() {
    clearTimeout(speakStartWatchdogTimer);
    speakStartWatchdogTimer = null;
    clearTimeout(speakEndWatchdogTimer);
    speakEndWatchdogTimer = null;
  }

  function estimateSpeechDurationMs(text) {
    const length = String(text || "").length;
    return Math.min(
      speakEndTimeoutBaseMs + length * speakEndTimeoutPerCharMs,
      speakEndTimeoutMaxMs
    );
  }

  // speak_ended が届かない場合に、推定発話時間の経過後にキューを強制前進させる。
  function startSpeakEndWatchdog(segment) {
    clearTimeout(speakEndWatchdogTimer);
    speakEndWatchdogTimer = setTimeout(() => {
      speakEndWatchdogTimer = null;

      if (activeSpeechSegment !== segment) {
        return;
      }

      onLog(`watchdog.speak_end_timeout: ${segment.speechText}`);
      activeSpeechSegment = null;
      isSpeaking = false;
      syncMicrophoneMuteState();

      if (speechQueue.length === 0 && !pendingSpeechSegment) {
        onSpeechIdle();
      }

      dispatchNextSpeech().catch((error) => {
        onError(error);
      });
    }, estimateSpeechDurationMs(segment.speechText));
  }

  // speak_started が届かない場合の保険。
  // 1回目: speak_textコマンド自体が失われた可能性(エージェント入室前など)があるため再送する。
  // 2回目: 発話中とみなしてキューを止めない。
  function startSpeakStartWatchdog(segment) {
    clearTimeout(speakStartWatchdogTimer);
    speakStartWatchdogTimer = setTimeout(() => {
      speakStartWatchdogTimer = null;

      if (pendingSpeechSegment !== segment) {
        return;
      }

      if (!segment.dispatchRetried) {
        segment.dispatchRetried = true;
        onLog(`watchdog.speak_start_retry: ${segment.speechText}`);
        pendingSpeechSegment = null;
        speechQueue.unshift(segment);
        dispatchNextSpeech().catch((error) => {
          onError(error);
        });
        return;
      }

      onLog(`watchdog.speak_start_timeout: ${segment.speechText}`);
      pendingSpeechSegment = null;
      activeSpeechSegment = segment;
      isSpeaking = true;
      syncMicrophoneMuteState();
      onSpeechStart(segment.subtitleText || segment.speechText || "");
      startSpeakEndWatchdog(segment);
    }, speakStartTimeoutMs);
  }

  function clearSpeechQueue() {
    speechQueue = [];
  }

  function clearSpeechState() {
    clearSpeechQueue();
    clearSpeechWatchdogs();
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

    return true;
  }

  function buildQueuedSpeechSegment(segment, { segmentGenerationId, responseId }) {
    return {
      ...segment,
      generationId: segmentGenerationId,
      responseId,
      // LiveAvatarはUUID形式のevent_idを要求する。接頭辞を付けると発話が受理されない。
      segmentId: crypto.randomUUID()
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

  function canAcceptUserInput() {
    return (
      !disposed &&
      inputEnabled &&
      transportReady &&
      !speechFault &&
      !inputCutoff &&
      (allowInterrupt || !hasActiveResponse())
    );
  }

  function handleLocalUserSpeechChange() {
    if (!canAcceptUserInput() || userTurn.expireIfNeeded()) return;
    userTurn.localSpeechChanged();
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

  function syncMicrophoneMuteState() {
    if (inputCutoff === "response" && !hasActiveResponse()) inputCutoff = null;
    const muted =
      !inputEnabled ||
      !transportReady ||
      speechFault ||
      Boolean(inputCutoff) ||
      (!allowInterrupt && hasActiveResponse());
    if (muted) clearBuffer();
    microphone.setMuted(muted);
  }

  function applyScenarioState(state) {
    if (!state || disposed) return !disposed;
    if (scenarioVersion !== undefined && state.version < scenarioVersion) return false;
    if (inputCutoff === "operator" && state.version > scenarioVersion) inputCutoff = null;
    scenarioVersion = state.version;
    inputEnabled = state.acceptsPatientInput !== false;
    if (!inputEnabled) {
      clearBuffer();
      clearRecentFinalizedTranscript();
    }
    syncMicrophoneMuteState();
    return true;
  }

  function setTransportReady(ready) {
    transportReady = ready;
    if (!ready) clearBuffer();
    syncMicrophoneMuteState();
  }

  function rememberFinalizedTranscript(text, chainLength) {
    lastFinalizedTranscript = text;
    lastFinalizedAt = Date.now();
    finalizedChainLength = chainLength;
  }

  function clearRecentFinalizedTranscript() {
    lastFinalizedTranscript = "";
    lastFinalizedAt = 0;
    finalizedChainLength = 0;
  }

  // 直前の確定発話への応答がすでに話し終わっていても、句読点なしで終わった発話の
  // 続きが継続時間内に届いた場合は「同じ発話の続き」として結合する。
  // (hasActiveResponse()を条件にすると、前半への応答が先に終わってしまった長い発話で
  //  後半が独立した新規発話として扱われ、台本が誤って二重に進む事故になる)
  //
  // ただし句点の付かない断片が継続時間内に届き続けると際限なく結合してしまうため、
  // 同じ発話への結合回数には上限(maxContinuationChainLength)を設ける。
  // 上限に達したら、それ以降の断片は結合せず新しい発話として扱う。
  function shouldAppendToRecentTranscript() {
    return (
      Boolean(lastFinalizedTranscript) &&
      !hasTerminalPunctuation(lastFinalizedTranscript) &&
      Date.now() - lastFinalizedAt <= continuationWindowMs &&
      finalizedChainLength < maxContinuationChainLength
    );
  }

  async function publishControlEvent(event) {
    const room = getRoom();

    if (disposed || !room?.localParticipant) {
      throw new Error("LiveKit room is not connected");
    }

    const payload = new TextEncoder().encode(JSON.stringify(event));

    await room.localParticipant.publishData(payload, {
      reliable: true,
      topic: AGENT_CONTROL_TOPIC
    });
  }

  async function dispatchNextSpeech() {
    if (
      disposed ||
      speechFault ||
      isSpeaking ||
      isDispatchingSpeech ||
      pendingSpeechSegment ||
      speechQueue.length === 0
    ) {
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

    isDispatchingSpeech = nextSpeech;
    pendingSpeechSegment = nextSpeech;

    try {
      await publishControlEvent({
        event_type: "avatar.speak_text",
        event_id: nextSpeech.segmentId,
        text: nextSpeech.speechText,
        client_generation_id: String(nextSpeech.generationId),
        client_response_id: nextSpeech.responseId,
        client_segment_id: nextSpeech.segmentId
      });
      if (disposed || nextSpeech.generationId !== generationId) return;

      // エコー(スピーカー回り込み)判定用に、発話テキストを記憶する。
      echoGuard.rememberAvatarSpeech(nextSpeech.speechText);
      echoGuard.rememberAvatarSpeech(nextSpeech.subtitleText);

      if (pendingSpeechSegment === nextSpeech) startSpeakStartWatchdog(nextSpeech);

      onLog(`avatar.speak_text: ${nextSpeech.speechText}`);
      onLog(
        `avatar.speak_text.meta: ${JSON.stringify({
          responseId: nextSpeech.responseId,
          generationId: nextSpeech.generationId,
          segmentId: nextSpeech.segmentId
        })}`
      );
    } catch (error) {
      if (disposed || nextSpeech.generationId !== generationId) return;
      pendingSpeechSegment = null;
      nextSpeech.publishFailures = (nextSpeech.publishFailures || 0) + 1;
      if (nextSpeech.publishFailures < 3) {
        speechQueue.unshift(nextSpeech);
        scheduleDispatchRetry(1000);
      } else {
        speechFault = true;
        clearSpeechState();
        syncMicrophoneMuteState();
      }
      throw error;
    } finally {
      if (isDispatchingSpeech === nextSpeech) {
        isDispatchingSpeech = false;
        syncMicrophoneMuteState();
        if (
          !disposed &&
          !dispatchResumeTimer &&
          !activeSpeechSegment &&
          !pendingSpeechSegment &&
          speechQueue.length
        ) {
          queueMicrotask(() => dispatchNextSpeech().catch(onError));
        }
      }
    }
  }

  async function queueSpeech(segment, { segmentGenerationId = generationId, responseId } = {}) {
    if (disposed) return;
    const normalizedSegment = normalizeSpeechSegment(segment);

    if (!normalizedSegment) {
      return;
    }

    speechQueue.push(
      buildQueuedSpeechSegment(normalizedSegment, {
        segmentGenerationId,
        responseId: responseId || crypto.randomUUID()
      })
    );
    syncMicrophoneMuteState();
    await dispatchNextSpeech();
  }

  async function interruptAvatar() {
    try {
      await publishControlEvent({
        event_type: "avatar.interrupt",
        event_id: crypto.randomUUID()
      });
    } catch (error) {
      onLog(`avatar.interrupt failed: ${error.message}`);
    }
  }

  function cancelCurrentResponse({ syncMicrophone = true, interrupt = true } = {}) {
    generationId += 1;
    isGenerating = false;
    interruptBarrierUntil = Date.now() + interruptGraceMs;
    clearSpeechState();
    isDispatchingSpeech = false;
    clearDispatchResumeTimer();
    streamAbortController?.abort();
    streamAbortController = null;
    if (syncMicrophone) syncMicrophoneMuteState();
    onSpeechReset();
    if (interrupt) interruptAvatar().catch(() => {});
  }

  async function flushBufferedTranscripts({ capped = false } = {}) {
    const combinedText = normalizeTranscript(bufferedTranscripts);
    const isRevision = bufferIsRevision;
    // 継続結合された発話ならチェーン長を1伸ばす。新規の発話ならチェーン長は1から。
    const chainLength = isRevision ? finalizedChainLength + 1 : 1;

    clearBuffer();

    if (disposed || !inputEnabled || !transportReady || !combinedText) {
      return;
    }

    const currentGenerationId = ++generationId;
    const responseId = crypto.randomUUID();
    isGenerating = true;
    if (capped) inputCutoff = "response";
    syncMicrophoneMuteState();
    streamAbortController = new AbortController();
    if (capped) clearRecentFinalizedTranscript();
    else rememberFinalizedTranscript(combinedText, chainLength);
    onLog(`user.transcription.final: ${combinedText}${isRevision ? " (revision)" : ""}`);

    try {
      const result = await respondToTextStream({
        sessionId: getSessionId(),
        text: combinedText,
        revision: isRevision,
        expectedVersion: scenarioVersion,
        signal: streamAbortController.signal,
        onSpeechSegment: async (segment) => {
          if (currentGenerationId !== generationId || !applyScenarioState(segment.state)) {
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

      applyScenarioState(result?.state);
      onAnswer(result);
      isGenerating = false;
      syncMicrophoneMuteState();
      streamAbortController = null;
    } catch (error) {
      if (currentGenerationId !== generationId) {
        return;
      }

      const aborted = streamAbortController?.signal.aborted || error.name === "AbortError";
      isGenerating = false;
      syncMicrophoneMuteState();
      streamAbortController = null;
      if (!aborted) onError(error);
    }
  }

  function finishUserTurn(details) {
    if (!canAcceptUserInput()) return;
    const capped = details.reason === "max_duration";
    onLog(
      `user.turn.finalized: ${JSON.stringify({ ...details, hasTranscript: bufferedTranscripts.length > 0 })}`
    );
    if (capped && bufferedTranscripts.length === 0) {
      inputCutoff = "operator";
      clearBuffer();
      clearRecentFinalizedTranscript();
      syncMicrophoneMuteState();
      onLog("user.turn.input_paused: 30秒以内に有効な文字起こしがなく、操作係の再開を待ちます");
      Promise.resolve(onInputTimeout({ expectedVersion: scenarioVersion })).catch(onError);
      return;
    }
    flushBufferedTranscripts({ capped }).catch(onError);
  }

  function enqueueUserTranscript(text) {
    const normalizedText = String(text || "").trim();

    if (
      disposed ||
      !inputEnabled ||
      !transportReady ||
      speechFault ||
      inputCutoff ||
      !normalizedText
    ) {
      return;
    }

    // 句読点だけ・一音だけのASR断片は患者発話として扱わない。
    // (通すと台本が進み、アバター発話中なら割り込みで発話が中断される)
    if (!isSubstantiveTranscript(normalizedText)) {
      onLog(`user.transcription.non_lexical_ignored: ${normalizedText}`);
      return;
    }

    // アバター自身の発話がスピーカー→マイクで回り込んだエコーは患者発話として扱わない。
    // (エコーを通すと、発話が中断された上に台本が勝手に進んでしまう)
    if (echoGuard.isLikelyEcho(normalizedText)) {
      onLog(`user.transcription.echo_ignored: ${normalizedText}`);
      return;
    }

    // 割り込み無効設定時は、アバター発話中の患者音声を完全に無視する。
    if (!allowInterrupt && hasActiveResponse()) {
      onLog(`user.transcription.ignored_while_speaking: ${normalizedText}`);
      return;
    }
    if (userTurn.expireIfNeeded()) return;

    const appendToRecentTranscript = shouldAppendToRecentTranscript();

    if (hasActiveResponse()) {
      cancelCurrentResponse();
    }

    if (appendToRecentTranscript && bufferedTranscripts.length === 0) {
      bufferedTranscripts.push(lastFinalizedTranscript);
      // 直前に送信済みの発話を作り直して再送するため、サーバー側に
      // 「前回の患者遷移を巻き戻してから判定し直す」ことを伝える。
      bufferIsRevision = true;
      onLog(`user.transcription.resume: ${lastFinalizedTranscript}`);
    } else if (
      bufferedTranscripts.length === 0 &&
      finalizedChainLength >= maxContinuationChainLength &&
      Boolean(lastFinalizedTranscript) &&
      !hasTerminalPunctuation(lastFinalizedTranscript) &&
      Date.now() - lastFinalizedAt <= continuationWindowMs
    ) {
      // 結合回数の上限に達したため、以降の断片は結合せず独立した発話として扱う。
      onLog(`user.transcription.continuation_limit_reached: ${lastFinalizedTranscript}`);
    }

    bufferedTranscripts.push(normalizedText);
    userTurn.transcriptReceived();
  }

  function handleAgentResponseEvent(event) {
    if (disposed || !event || typeof event !== "object") {
      return;
    }

    if (event.event_type === "user.speak_started" || event.event_type === "user.speak_ended") {
      if (canAcceptUserInput() && !userTurn.expireIfNeeded()) {
        userTurn.remoteSpeechChanged(event.event_type === "user.speak_started");
      }
      return;
    }

    if (event.event_type === "user.transcription" && event.text) {
      enqueueUserTranscript(event.text);
      return;
    }

    if (event.event_type === "avatar.speak_started") {
      if (isWithinInterruptBarrier() && !hasCorrelationMeta(extractEventGenerationMeta(event)))
        return;
      if (activeSpeechSegment && eventMatchesSegment(event, activeSpeechSegment)) {
        return;
      }

      if (!pendingSpeechSegment) {
        if (hasCorrelationMeta(extractEventGenerationMeta(event)) || isWithinInterruptBarrier()) {
          onLog(
            `avatar.speak_started ignored: ${JSON.stringify(extractEventGenerationMeta(event))}`
          );
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
      syncMicrophoneMuteState();
      clearTimeout(speakStartWatchdogTimer);
      speakStartWatchdogTimer = null;
      startSpeakEndWatchdog(speechSegment);
      onSpeechStart(speechSegment?.subtitleText || speechSegment?.speechText || "");
      return;
    }

    if (isAvatarSubtitleEndEvent(event)) {
      if (isWithinInterruptBarrier() && !hasCorrelationMeta(extractEventGenerationMeta(event)))
        return;
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
      syncMicrophoneMuteState();
      clearTimeout(speakEndWatchdogTimer);
      speakEndWatchdogTimer = null;

      if (speechQueue.length === 0 && !pendingSpeechSegment) {
        onSpeechIdle();
      }

      dispatchNextSpeech().catch((error) => {
        onError(error);
      });
    }
  }

  function reset() {
    inputCutoff = null;
    cancelCurrentResponse();
    clearBuffer();
    clearRecentFinalizedTranscript();
    speechFault = false;
    echoGuard.reset();
  }

  async function receiveOperatorSegment(segment) {
    if (disposed || (scenarioVersion !== undefined && segment.state?.version < scenarioVersion))
      return;
    if (segment.replace) {
      inputCutoff = null;
      cancelCurrentResponse({ syncMicrophone: false });
      clearBuffer();
      clearRecentFinalizedTranscript();
      speechFault = false;
    }
    // 先にキューへ積み、状態変更の瞬間にマイクが開くのを防ぐ。
    const queued = queueSpeech(segment);
    applyScenarioState(segment.state);
    await queued;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelCurrentResponse({ syncMicrophone: false, interrupt: false });
    clearBuffer();
    localParticipant?.off?.("isSpeakingChanged", handleLocalUserSpeechChange);
    microphone.dispose();
    echoGuard.reset();
  }

  return {
    applyScenarioState,
    setTransportReady,
    receiveOperatorSegment,
    dispose,
    handleAgentResponseEvent,
    interruptAvatar,
    speakText: queueSpeech,
    reset
  };
}
