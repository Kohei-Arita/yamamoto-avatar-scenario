import * as browserApi from "./liveavatar-browser-api.js";
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
  const sessionStartLock = createSessionStartLock();
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
    if (!sessionStartLock.acquire())
      return Promise.reject(new Error("別のタブでセッションが進行中です。"));

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
      state: null
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

    startPromise = (async () => {
      onConnectionStateChange("starting");
      try {
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
          onError,
          onMicStateChange,
          onInputTimeout: async ({ expectedVersion }) => {
            const result = await api.pauseDialogueInput(run.sessionId, expectedVersion, { signal });
            if (!isCurrent() || !run.conversation.applyScenarioState(result.state)) return;
            run.state = result.state;
          },
          onAnswer: (result) => {
            if (!isCurrent()) return;
            if (result?.state && result.state.version >= run.state?.version)
              run.state = result.state;
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
          onState: (state) => {
            if (!isCurrent()) return;
            run.state = state;
            run.conversation.applyScenarioState(state);
          },
          onConnectionChange: (connected, snapshot) => {
            if (!isCurrent()) return;
            run.eventsConnected = connected;
            if (!connected) {
              run.conversation.setTransportReady(false);
              onLog("進行チャンネル再接続中: マイク入力を停止");
              return;
            }
            const changed = snapshot.state.version !== run.state?.version;
            run.state = snapshot.state;
            run.snapshot = snapshot;
            if (!run.ready) {
              if (changed) run.pendingSegments = [];
              eventsReady();
            } else {
              // SSE断中に届かなかった操作は、再接続時の現在台詞で追いつく。
              if (changed) {
                for (const [index, segment] of snapshot.openingSegments.entries()) {
                  run.conversation
                    .receiveOperatorSegment({
                      ...segment,
                      replace: index === 0,
                      state: snapshot.state
                    })
                    .catch(onError);
                }
              }
              run.conversation.applyScenarioState(snapshot.state);
              run.conversation.setTransportReady(true);
            }
          },
          onSpeechSegment: (segment) => {
            if (!isCurrent()) return;
            run.state = segment.state;
            if (!run.ready) {
              if (segment.replace) run.pendingSegments = [];
              run.pendingSegments.push(segment);
            } else {
              run.conversation.receiveOperatorSegment(segment).catch(onError);
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
        const opening = run.pendingSegments.length
          ? run.pendingSegments
          : (snapshot.state.version === bound.state.version
              ? bound.openingSegments
              : snapshot.openingSegments
            ).map((segment) => ({ ...segment, state: snapshot.state }));
        run.conversation.applyScenarioState(run.state);
        run.ready = true;
        await Promise.all(opening.map((segment) => run.conversation.speakText(segment)));
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
