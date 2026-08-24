import { isAvatarSubtitleEndEvent, normalizeSubtitleText } from "./liveavatar-subtitles.js";
import { createEchoGuard } from "./transcript-echo-guard.js";
import { isSubstantiveTranscript } from "./transcript-filter.js";

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
  // 同じ発話への結合(継続扱い)を許す最大回数。上限がないと、雑音などで句点の付かない
  // 断片が継続時間内に届き続けた場合、結合が際限なく伸び続けてしまう。
  maxContinuationChainLength = 5,
  flushPollMs = 250,
  interruptGraceMs = 250,
  allowInterrupt = true,
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
  onError = () => {}
}) {
  let bufferedTranscripts = [];
  let bufferIsRevision = false;
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
  let finalizedChainLength = 0;
  let dispatchResumeTimer = null;
  let interruptBarrierUntil = 0;
  let speakStartWatchdogTimer = null;
  let speakEndWatchdogTimer = null;
  // アバター発話中は自分のマイク音声そのものを物理的にミュートする。
  // allowInterrupt=falseは受信した文字起こしを無視するだけで、LiveAvatar側が
  // マイク音声を独自に検知して反応する経路までは止められない。マイクの発行自体を
  // 止めれば、相手に音声が一切届かなくなるため、その経路も含めて確実に防げる。
  //
  // 「あるべき状態(desired)」と「実際に適用できた状態(applied)」を分けて持つ。
  // setMicrophoneEnabledは非同期で失敗もするため、呼び出しただけで適用済みとみなすと
  // 実状態とずれる。特に解除失敗を適用済み扱いにすると、マイクが落ちたまま復帰しない。
  let desiredMicrophoneMuted = false;
  let appliedMicrophoneMuted = false;
  let isMicrophoneSyncInFlight = false;
  let microphoneSyncRetryTimer = null;
  let microphoneSyncRetryCount = 0;

  function clearBuffer() {
    bufferedTranscripts = [];
    bufferIsRevision = false;
    clearTimeout(flushTimer);
    flushTimer = null;
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

  function clearMicrophoneSyncRetryTimer() {
    clearTimeout(microphoneSyncRetryTimer);
    microphoneSyncRetryTimer = null;
  }

  function scheduleMicrophoneSyncRetry() {
    if (microphoneSyncRetryTimer || microphoneSyncRetryCount >= micSyncMaxRetries) {
      return;
    }

    microphoneSyncRetryCount += 1;
    microphoneSyncRetryTimer = setTimeout(() => {
      microphoneSyncRetryTimer = null;
      applyMicrophoneMuteState();
    }, micSyncRetryMs);
  }

  // desired と applied の差を埋める。多重呼び出しは直列化する
  // (ミュート→解除が短時間に連続したとき、完了順が入れ替わって実状態が反転しないように)。
  function applyMicrophoneMuteState() {
    if (isMicrophoneSyncInFlight || desiredMicrophoneMuted === appliedMicrophoneMuted) {
      return;
    }

    const room = getRoom();

    if (typeof room?.localParticipant?.setMicrophoneEnabled !== "function") {
      // まだ部屋に接続していない等で適用できない。desiredは保持したままにしておき、
      // 次のsyncか再試行で追いつかせる(ここでappliedを進めると実状態とずれる)。
      return;
    }

    const targetMuted = desiredMicrophoneMuted;
    isMicrophoneSyncInFlight = true;

    Promise.resolve(room.localParticipant.setMicrophoneEnabled(!targetMuted))
      .then(() => {
        appliedMicrophoneMuted = targetMuted;
        microphoneSyncRetryCount = 0;
        isMicrophoneSyncInFlight = false;
        onLog(targetMuted ? "microphone.muted" : "microphone.unmuted");
        // 待っている間にdesiredが変わっていた場合に追随する。
        applyMicrophoneMuteState();
      })
      .catch((error) => {
        isMicrophoneSyncInFlight = false;
        onLog(`microphone.${targetMuted ? "mute" : "unmute"}_failed: ${error.message}`);
        // 失敗直後にその場で再実行すると間隔なしで回り続けるため、必ず遅延を挟む。
        scheduleMicrophoneSyncRetry();
      });
  }

  // hasActiveResponse()の状態が変わるたびに呼ぶ。応答中(生成〜発話完了まで)はマイクを
  // ミュートし、完全にアイドルに戻ったらミュートを解除する。
  function syncMicrophoneMuteState() {
    const shouldMute = hasActiveResponse();

    if (shouldMute !== desiredMicrophoneMuted) {
      desiredMicrophoneMuted = shouldMute;
      // 目標が変わったので、前の目標に対する再試行の残りカウントはリセットする。
      microphoneSyncRetryCount = 0;
      clearMicrophoneSyncRetryTimer();
    }

    applyMicrophoneMuteState();
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

      // エコー(スピーカー回り込み)判定用に、発話テキストを記憶する。
      echoGuard.rememberAvatarSpeech(nextSpeech.speechText);
      echoGuard.rememberAvatarSpeech(nextSpeech.subtitleText);

      startSpeakStartWatchdog(nextSpeech);

      onLog(`avatar.speak_text: ${nextSpeech.speechText}`);
      onLog(
        `avatar.speak_text.meta: ${JSON.stringify({
          responseId: nextSpeech.responseId,
          generationId: nextSpeech.generationId,
          segmentId: nextSpeech.segmentId
        })}`
      );
    } catch (error) {
      // publish失敗時はキューに戻し、少し待って再送を試みる(1回の失敗で無音のまま止めない)。
      speechQueue.unshift(nextSpeech);
      pendingSpeechSegment = null;
      scheduleDispatchRetry(1000);
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
    syncMicrophoneMuteState();
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
    syncMicrophoneMuteState();
    onSpeechReset();
    interruptAvatar().catch(() => {});
  }

  async function flushBufferedTranscripts() {
    const combinedText = normalizeTranscript(bufferedTranscripts);
    const isRevision = bufferIsRevision;
    // 継続結合された発話ならチェーン長を1伸ばす。新規の発話ならチェーン長は1から。
    const chainLength = isRevision ? finalizedChainLength + 1 : 1;

    clearBuffer();

    if (!combinedText) {
      return;
    }

    const currentGenerationId = ++generationId;
    const responseId = createClientId("response");
    isGenerating = true;
    syncMicrophoneMuteState();
    streamAbortController = new AbortController();
    rememberFinalizedTranscript(combinedText, chainLength);
    onLog(`user.transcription.final: ${combinedText}${isRevision ? " (revision)" : ""}`);

    try {
      const result = await respondToTextStream({
        sessionId: getSessionId(),
        text: combinedText,
        revision: isRevision,
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
      syncMicrophoneMuteState();
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
      syncMicrophoneMuteState();
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
    cancelCurrentResponse();
    clearBuffer();
    clearRecentFinalizedTranscript();
    // セッション終了後に残ったタイマーが発火して、切断済みの部屋を触らないようにする。
    clearMicrophoneSyncRetryTimer();
    echoGuard.reset();
  }

  return {
    handleAgentResponseEvent,
    interruptAvatar,
    speakText: queueSpeech,
    reset
  };
}
