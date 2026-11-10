import * as browserApi from "./liveavatar-browser-api.js";
import { createSpeechBatchBuffer } from "./speech-batch.js";
import {
  createLiveAvatarDataHandler,
  createSelfControlledSession
} from "./liveavatar-session-events.js";
import { createTrackAttacher, stopLiveAvatarSessionSafely } from "./liveavatar-session-runtime.js";
import {
  createChromaKeyController,
  createSessionStartLock,
  createSubtitleController,
  resetRemoteMediaElements
} from "./liveavatar-session-ui.js";

function waitFor(promise, ms, signal, message) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error(message)), ms);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(null, value),
      (error) => finish(error)
    );
    if (signal.aborted) abort();
  });
}

export function createSessionManager({
  LivekitClient,
  elements,
  chromaKeyOptions = {},
  showSubtitles = true,
  verbose = false,
  onLog = () => {},
  onConnectionStateChange = () => {},
  onMicStateChange = () => {},
  onAnswer = () => {},
  onAudioBlocked = () => {},
  onError = () => {},
  onDisconnected = () => {},
  api = browserApi
}) {
  const { Room, RoomEvent, Track } = LivekitClient;
  const { remoteVideo, remoteCanvas, remoteAudio, videoPlaceholder, subtitleBox, chromaKeyToggle } =
    elements;
  const sessionStartLock = createSessionStartLock({
    onLost: () => {
      stop().catch(onError);
      onError(
        Object.assign(
          new Error(
            "別の画面がセッションを取得したため停止しました。使用する画面を確認してください。"
          ),
          { requiresReconnect: true }
        )
      );
    }
  });
  const subtitleController = createSubtitleController({ subtitleBox, showSubtitles });
  const chromaKeyController = createChromaKeyController({
    remoteVideo,
    remoteCanvas,
    containerElement: videoPlaceholder?.parentElement,
    options: chromaKeyOptions
  });
  let config = null;
  let activeRun = null;
  let startPromise = null;
  let lifecycleEpoch = 0;

  function updateChromaKey() {
    chromaKeyController.update(Boolean(chromaKeyToggle?.checked));
  }

  // タイマー、SSE、会話、部屋は作成した世代に所有させる。旧接続の後処理で新接続を触らない。
  function releaseRun(run) {
    if (run.released) return;
    run.released = true;
    const wasCurrent = activeRun === run;
    if (wasCurrent) {
      activeRun = null;
      lifecycleEpoch += 1;
    }
    run.abort.abort();
    clearTimeout(run.heartbeat);
    run.events?.close();
    run.conversation?.dispose();
    run.room?.disconnect()?.catch?.(onError);
    if (!wasCurrent) return;
    sessionStartLock.release();
    chromaKeyController.stop({ clearCanvas: true, showVideo: true });
    resetRemoteMediaElements({ remoteVideo, remoteAudio, videoPlaceholder });
    subtitleController.clearNow();
    onMicStateChange("off");
    onConnectionStateChange("idle");
  }

  const stopRemote = (token) =>
    stopLiveAvatarSessionSafely(token, api.stopLiveAvatarSession, {
      onError: (error) => onLog(`Stop session warning: ${error.message}`)
    });

  async function stop() {
    const run = activeRun;
    if (!run) return;
    releaseRun(run);
    await stopRemote(run.token);
  }

  async function loadConfig() {
    config = await api.fetchLiveAvatarConfig();
    return config;
  }

  function start({ skipMicrophonePreflight = false } = {}) {
    if (startPromise) return startPromise;
    if (activeRun?.ready) return Promise.resolve();
    const run = {
      epoch: ++lifecycleEpoch,
      abort: new AbortController(),
      room: null,
      token: null,
      sessionId: null,
      conversation: null,
      events: null,
      heartbeat: null,
      ready: false,
      released: false,
      pendingSegments: [],
      eventsConnected: false,
      snapshot: null,
      state: null,
      speechBuffer: createSpeechBatchBuffer(),
      queuedSpeechId: null,
      playbackSequence: 0
    };
    activeRun = run;
    const signal = run.abort.signal;
    const isCurrent = () => activeRun === run && lifecycleEpoch === run.epoch;
    const ensureCurrent = () => {
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error("セッション開始が中断されました。");
    };
    const disconnected = (reason) => {
      if (!isCurrent()) return;
      onLog(`LiveAvatar disconnected: ${reason || "unknown"}`);
      releaseRun(run);
      stopRemote(run.token).catch(onError);
      onDisconnected(reason);
    };

    const handleError = (error) => {
      if (!isCurrent()) return;
      reportPlayback("error", error.message);
      if (error.requiresReconnect) {
        releaseRun(run);
        stopRemote(run.token).catch(onError);
        onConnectionStateChange("error");
      }
      onError(error);
    };

    const reportPlayback = (status, message = "") => {
      if (!isCurrent() || !run.state?.epoch || !api.reportPlaybackState) return;
      api
        .reportPlaybackState(run.sessionId, {
          status,
          message: message.slice(0, 500),
          sequence: ++run.playbackSequence,
          expectedEpoch: run.state.epoch
        })
        .catch((error) => onLog(error.message));
    };

    const queueBatch = (segments) => {
      run.queuedSpeechId = segments[0]?.speechId || null;
      for (const segment of segments)
        run.conversation.receiveOperatorSegment(segment).catch(handleError);
    };

    startPromise = (async () => {
      onConnectionStateChange("starting");
      try {
        if (!(await sessionStartLock.acquire()))
          throw new Error("別のタブでセッションが進行中です。");
        ensureCurrent();
        config = config || (await api.fetchLiveAvatarConfig({ signal }));
        ensureCurrent();
        if (!skipMicrophonePreflight) {
          await waitFor(
            api.ensureMicrophoneAccess(),
            30_000,
            signal,
            "マイクへのアクセスが完了しませんでした。ブラウザの許可と音声機器を確認してください。"
          );
          ensureCurrent();
        }
        // 発行要求は中断しない。Stopと競合しても返されたトークンを回収して停止する。
        const token = await api.createLiveAvatarSessionToken();
        run.token = token.session_token;
        run.sessionId = token.session_id;
        ensureCurrent();
        if (!run.sessionId) throw new Error("LiveAvatarのセッションIDを取得できませんでした。");
        const session = await api.startLiveAvatarSession(run.token, { signal });
        ensureCurrent();

        let audioReady;
        const audio = new Promise((resolve) => {
          audioReady = resolve;
        });
        const attachTrack = createTrackAttacher({
          Track,
          remoteVideo,
          remoteAudio,
          videoPlaceholder,
          onVideoTrackAttached: updateChromaKey,
          onAudioTrackAttached: audioReady,
          onAudioBlocked
        });
        const handleData = createLiveAvatarDataHandler({
          getSelfControlledConversation: () => run.conversation,
          onUserTranscription: (text) => onLog(`user.transcription: ${text}`),
          onSessionStopped: (event) => disconnected(event.end_reason)
        });
        await api.connectLiveKitRoom({
          Room,
          RoomEvent,
          livekitUrl: session.livekit_url,
          livekitToken: session.livekit_token,
          signal,
          audioCaptureDefaults: { autoGainControl: Boolean(config.microphoneAutoGainControl) },
          onRoomCreated: (room) => {
            run.room = room;
          },
          attachTrack: (...args) => {
            if (isCurrent()) attachTrack(...args);
          },
          onDataReceived: (...args) => {
            if (isCurrent()) handleData(...args);
          },
          onDisconnected: disconnected
        });
        ensureCurrent();
        run.conversation = createSelfControlledSession({
          getRoom: () => run.room,
          getSessionId: () => run.sessionId,
          liveAvatarConfig: config,
          respondWithDialogueStream: api.respondWithDialogueStream,
          subtitleController,
          microphoneInitiallyMuted: true,
          onLog,
          onError: handleError,
          onPlaybackState: reportPlayback,
          onMicStateChange,
          onInputTimeout: async ({ expectedVersion, expectedEpoch }) => {
            const result = await api.pauseDialogueInput(run.sessionId, expectedVersion, {
              signal,
              expectedEpoch
            });
            if (!isCurrent() || !run.conversation.applyScenarioState(result.state)) return;
            run.state = result.state;
          },
          onAnswer: (result) => {
            if (!isCurrent()) return;
            if (result?.state && result.state.version >= run.state?.version)
              run.state = result.state;
            if (result?.state?.speechId) run.queuedSpeechId = result.state.speechId;
            onAnswer(result);
          }
        });
        run.conversation.setTransportReady(false);
        const bound = await api.bindDialogueSession(run.sessionId, { signal });
        ensureCurrent();
        run.conversation.applyScenarioState(bound.state);
        run.state = bound.state;
        let eventsReady;
        const events = new Promise((resolve) => {
          eventsReady = resolve;
        });
        run.events = api.subscribeDialogueEvents(run.sessionId, {
          epoch: bound.state.epoch,
          onState: (state, options = {}) => {
            if (!isCurrent()) return;
            if (!run.conversation.applyScenarioState(state, options)) return;
            if (options.replace) {
              run.speechBuffer.clear();
              run.pendingSegments = [];
              run.queuedSpeechId = state.speechId;
              run.snapshot = { state, openingSegments: [] };
            }
            run.state = state;
          },
          onConnectionChange: (connected, snapshot) => {
            if (!isCurrent()) return;
            run.eventsConnected = connected;
            if (!connected) {
              run.conversation.setTransportReady(false);
              onLog("進行チャンネル再接続中: マイク入力を停止");
              return;
            }
            const restarted =
              run.state?.epoch && snapshot.state.epoch && run.state.epoch !== snapshot.state.epoch;
            if (restarted) {
              run.conversation.recoverScenarioState(snapshot.state);
              run.pendingSegments = [];
              run.queuedSpeechId = null;
              onLog("サーバーが再起動しました。操作画面のジャンプで中断位置を指定してください。");
            }
            const changed = restarted || snapshot.state.version !== run.state?.version;
            const missingSpeech = snapshot.state.speechId
              ? snapshot.state.speechId !== run.queuedSpeechId || run.speechBuffer.incomplete
              : changed;
            run.speechBuffer.clear();
            run.state = snapshot.state;
            run.snapshot = snapshot;
            if (!run.ready) {
              if (changed || missingSpeech) run.pendingSegments = [];
              eventsReady();
            } else {
              // SSE断中に届かなかった操作は、再接続時の現在台詞で追いつく。
              if (missingSpeech) {
                queueBatch(
                  snapshot.openingSegments.map((segment, index) => ({
                    ...segment,
                    replace: index === 0,
                    state: snapshot.state
                  }))
                );
              }
              const silentReplacement = missingSpeech && snapshot.openingSegments.length === 0;
              run.conversation.applyScenarioState(snapshot.state, { replace: silentReplacement });
              if (silentReplacement) run.queuedSpeechId = snapshot.state.speechId;
              run.conversation.setTransportReady(true);
            }
          },
          onSpeechSegment: (segment) => {
            if (!isCurrent()) return;
            if (segment.state?.epoch && run.state?.epoch && segment.state.epoch !== run.state.epoch)
              return;
            if (segment.state?.version < run.state?.version) return;
            if (segment.speechId && segment.speechId === run.queuedSpeechId) return;
            run.state = segment.state;
            let batch;
            try {
              batch = run.speechBuffer.add(segment);
            } catch (error) {
              run.conversation.setTransportReady(false);
              handleError(error);
              return;
            }
            if (!batch) {
              run.conversation.setTransportReady(false);
              return;
            }
            if (!run.ready) {
              if (batch[0].replace) run.pendingSegments = [];
              run.pendingSegments.push(...batch);
            } else {
              queueBatch(batch);
              run.conversation.setTransportReady(run.eventsConnected);
            }
          }
        });
        await Promise.all([
          waitFor(events, 10_000, signal, "進行チャンネルに接続できませんでした。"),
          waitFor(audio, 15_000, signal, "アバターの音声が届きませんでした。再接続してください。")
        ]);
        ensureCurrent();
        await waitFor(
          new Promise((resolve) => setTimeout(resolve, 400)),
          1000,
          signal,
          "音声準備が完了しませんでした。"
        );
        ensureCurrent();
        const snapshot = run.snapshot;
        if (run.speechBuffer.incomplete)
          throw new Error("台詞の受信が途中で止まりました。再接続してください。");
        const opening = run.pendingSegments.length
          ? run.pendingSegments
          : (snapshot.state.epoch === bound.state.epoch &&
            snapshot.state.speechId === bound.state.speechId &&
            snapshot.state.version === bound.state.version
              ? bound.openingSegments
              : snapshot.openingSegments
            ).map((segment) => ({ ...segment, state: snapshot.state }));
        run.conversation.applyScenarioState(run.state);
        run.ready = true;
        await Promise.all(opening.map((segment) => run.conversation.speakText(segment)));
        run.queuedSpeechId = run.state?.speechId || null;
        ensureCurrent();
        run.conversation.setTransportReady(run.eventsConnected);
        onConnectionStateChange("connected");

        const heartbeat = async () => {
          if (!isCurrent()) return;
          sessionStartLock.refresh();
          try {
            await api.keepLiveAvatarSessionAlive(run.sessionId, { signal });
          } catch (error) {
            if (isCurrent()) onLog(`keep-alive failed: ${error.message}`);
          }
          if (isCurrent()) run.heartbeat = setTimeout(heartbeat, 60_000);
        };
        run.heartbeat = setTimeout(heartbeat, 60_000);
        if (verbose) onLog("LiveKit and scenario control connected");
      } catch (error) {
        releaseRun(run);
        stopRemote(run.token).catch(onError);
        throw error;
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }

  function dispose() {
    if (activeRun) releaseRun(activeRun);
    subtitleController.dispose();
  }

  return {
    start,
    stop,
    loadConfig,
    updateChromaKey,
    dispose,
    getConfig: () => config,
    getSessionId: () => activeRun?.sessionId || null,
    isStarted: () => Boolean(activeRun?.ready)
  };
}
