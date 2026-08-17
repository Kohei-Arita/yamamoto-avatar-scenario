import {
  bindDialogueSession,
  connectLiveKitRoom,
  createLiveAvatarSessionToken,
  ensureMicrophoneAccess,
  fetchLiveAvatarConfig,
  respondWithDialogueStream,
  subscribeDialogueEvents,
  startLiveAvatarSession,
  stopLiveAvatarSession
} from "./liveavatar-browser-api.js";
import { createLiveAvatarDataHandler } from "./liveavatar-session-events.js";
import {
  createSessionLockHeartbeat,
  createTrackAttacher,
  disconnectRoom,
  initializeSelfControlledConversation,
  startOpeningGreeting,
  stopLiveAvatarSessionSafely
} from "./liveavatar-session-runtime.js";
import {
  createChromaKeyController,
  createSessionStartLock,
  createSubtitleController,
  resetRemoteMediaElements
} from "./liveavatar-session-ui.js";

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
  onDisconnected = () => {}
}) {
  const { Room, RoomEvent, Track } = LivekitClient;
  const { remoteVideo, remoteCanvas, remoteAudio, videoPlaceholder, subtitleBox, chromaKeyToggle } =
    elements;

  let room = null;
  let sessionToken = null;
  let started = false;
  let currentSessionId = null;
  let config = null;
  let selfControlledConversation = null;
  let dialogueEventSource = null;
  let startPromise = null;
  // stop()のたびに増える世代番号。start処理は各await後にこれを確認し、
  // 処理中にstopが割り込んでいたら安全に中断する(半端な起動状態を防ぐ)。
  let lifecycleEpoch = 0;
  // アバターの音声トラックが届いた(=HeyGenエージェントが入室済み)ことを知らせる。
  // これを待たずに挨拶のspeak_textを送ると、エージェント入室前でコマンドが失われ
  // 開始挨拶が無音になることがある。
  let notifyAvatarAudioReady = () => {};

  const AVATAR_MEDIA_READY_TIMEOUT_MS = 10_000;
  const AVATAR_MEDIA_READY_GRACE_MS = 400;

  function createAvatarAudioReadyPromise() {
    return new Promise((resolve) => {
      notifyAvatarAudioReady = resolve;
    });
  }

  async function waitForAvatarAudio(readyPromise) {
    const ready = await Promise.race([
      readyPromise.then(() => true),
      new Promise((resolve) => {
        setTimeout(() => resolve(false), AVATAR_MEDIA_READY_TIMEOUT_MS);
      })
    ]);

    if (!ready) {
      onLog("avatar audio track not detected before greeting (timeout, continuing)");
      return;
    }

    // トラック公開直後はエージェント側のコマンド受信準備が整いきっていない
    // ことがあるため、わずかに待ってから挨拶を送る。
    await new Promise((resolve) => {
      setTimeout(resolve, AVATAR_MEDIA_READY_GRACE_MS);
    });
  }

  const sessionStartLock = createSessionStartLock();
  const sessionLockHeartbeat = createSessionLockHeartbeat(sessionStartLock);
  const subtitleController = createSubtitleController({ subtitleBox, showSubtitles });
  const chromaKeyController = createChromaKeyController({
    remoteVideo,
    remoteCanvas,
    containerElement: videoPlaceholder?.parentElement,
    options: chromaKeyOptions
  });

  function updateChromaKey() {
    chromaKeyController.update(Boolean(chromaKeyToggle?.checked));
  }

  const attachTrack = createTrackAttacher({
    Track,
    remoteVideo,
    remoteAudio,
    videoPlaceholder,
    onVideoTrackAttached: updateChromaKey,
    onAudioTrackAttached: () => notifyAvatarAudioReady(),
    onAudioBlocked
  });

  const handleDataReceived = createLiveAvatarDataHandler({
    getSelfControlledConversation: () => selfControlledConversation,
    isSelfControlled: () => Boolean(config?.selfControlled),
    subtitleController,
    onUserTranscription: (text) => onLog(`user.transcription: ${text}`),
    onAvatarSubtitle: verbose ? (text) => onLog(`avatar.subtitle: ${text}`) : undefined,
    onSessionStopped: () => {
      onLog("LiveAvatar session stopped");
      stop().catch(onError);
    }
  });

  async function internalConnectRoom(livekitUrl, livekitToken) {
    room = await connectLiveKitRoom({
      Room,
      RoomEvent,
      livekitUrl,
      livekitToken,
      attachTrack,
      onConnected: () => {
        onConnectionStateChange("connected");
        if (verbose) onLog("LiveKit connected");
      },
      onDisconnected: (reason) => {
        onConnectionStateChange("disconnected");
        if (verbose) onLog(`LiveKit disconnected ${reason || ""}`);
        chromaKeyController.stop({ clearCanvas: true, showVideo: true });
        room = null;
        started = false;
        onDisconnected();
      },
      onTrackSubscribed: verbose
        ? (track, _pub, participant) =>
            onLog(`Track subscribed: ${track.kind} from ${participant.identity}`)
        : undefined,
      onTrackUnsubscribed: verbose
        ? (track) => onLog(`Track unsubscribed: ${track.kind}`)
        : undefined,
      onDataReceived: handleDataReceived,
      onParticipantConnected: verbose
        ? (participant) => onLog(`Participant connected: ${participant.identity}`)
        : undefined,
      onParticipantDisconnected: verbose
        ? (participant) => onLog(`Participant disconnected: ${participant.identity}`)
        : undefined
    });

    onMicStateChange("on");
    if (verbose) onLog("Microphone enabled");
  }

  async function resetState() {
    dialogueEventSource?.close();
    dialogueEventSource = null;
    selfControlledConversation?.reset();
    selfControlledConversation = null;
    currentSessionId = null;
    chromaKeyController.stop({ clearCanvas: true, showVideo: true });
    sessionLockHeartbeat.stop();

    if (room) {
      await disconnectRoom(room);
      room = null;
    }

    resetRemoteMediaElements({ remoteVideo, remoteAudio, videoPlaceholder });
    subtitleController.clearNow();
    onConnectionStateChange("idle");
    onMicStateChange("off");
    started = false;
  }

  async function stop() {
    lifecycleEpoch += 1;

    try {
      await stopLiveAvatarSessionSafely(sessionToken, stopLiveAvatarSession, {
        onError: (error) => onLog(`Stop session warning: ${error.message}`)
      });
    } finally {
      sessionToken = null;
      sessionStartLock.release();
      await resetState();
    }
  }

  async function loadConfig() {
    config = await fetchLiveAvatarConfig();
    return config;
  }

  async function start({ skipMicrophonePreflight = false } = {}) {
    if (started) return;
    if (startPromise) return startPromise;

    if (!sessionStartLock.acquire()) {
      throw new Error("別のタブでセッションが進行中です。");
    }

    const epoch = lifecycleEpoch;

    // start処理中にstop()が割り込んだ場合、以降の処理を中断して二重状態を防ぐ。
    // (以前はstopがcurrentSessionIdをnullに戻した後もstartが続行し、
    //  sessionIdなしでbind/SSE購読され、以降の対話が403で拒否される事故があった)
    function ensureNotStopped() {
      if (lifecycleEpoch !== epoch) {
        throw new Error("セッション開始中に停止されました。もう一度Startしてください。");
      }
    }

    startPromise = (async () => {
      onConnectionStateChange("starting");

      try {
        if (!config) {
          config = await fetchLiveAvatarConfig();
          ensureNotStopped();
        }

        if (!skipMicrophonePreflight) {
          await ensureMicrophoneAccess({
            unsupportedMessage: "このブラウザではマイク取得 API が使えません。"
          });
          ensureNotStopped();
        }

        const tokenResponse = await createLiveAvatarSessionToken();
        // 先にトークンを保持してからstop割り込みを確認する
        // (中断時にcatch側のstop()が、作成済みセッションを確実に破棄できるように)
        sessionToken = tokenResponse.session_token;
        const startSessionId = tokenResponse.session_id || null;
        currentSessionId = startSessionId;
        ensureNotStopped();

        if (!startSessionId) {
          throw new Error("LiveAvatarのセッションIDを取得できませんでした。");
        }

        const session = await startLiveAvatarSession(sessionToken);
        ensureNotStopped();

        // 接続前にpromiseを作っておく(接続処理内のattachExistingTracksで即解決されうる)
        const avatarAudioReady = createAvatarAudioReadyPromise();
        await internalConnectRoom(session.livekit_url, session.livekit_token);
        ensureNotStopped();

        selfControlledConversation = initializeSelfControlledConversation({
          getRoom: () => room,
          // stop()でcurrentSessionIdがnullに戻っても影響を受けないよう、
          // このstartで確定したsessionIdを固定値として使う。
          getSessionId: () => startSessionId,
          liveAvatarConfig: config,
          respondWithDialogueStream,
          subtitleController,
          onLog,
          onAnswer,
          onError
        });

        sessionLockHeartbeat.start();
        await bindDialogueSession(startSessionId);
        ensureNotStopped();

        dialogueEventSource = subscribeDialogueEvents(startSessionId, {
          onSpeechSegment: (segment) => {
            onLog(`operator.speech_segment: ${segment.speechText}`);
            selfControlledConversation?.speakText(segment).catch(onError);
          }
        });

        // アバターの音声トラック到着(=エージェント入室)を待ってから開始挨拶を送る。
        await waitForAvatarAudio(avatarAudioReady);
        ensureNotStopped();

        await startOpeningGreeting({
          liveAvatarConfig: config,
          selfControlledConversation,
          onError
        });
        ensureNotStopped();

        started = true;
      } catch (error) {
        await stop();
        throw error;
      } finally {
        startPromise = null;
      }
    })();

    return startPromise;
  }

  function dispose() {
    chromaKeyController.stop();
    subtitleController.dispose();
    sessionLockHeartbeat.stop();
    sessionStartLock.release();
    if (room) room.disconnect();
  }

  return {
    start,
    stop,
    loadConfig,
    updateChromaKey,
    dispose,
    getConfig: () => config,
    getSessionId: () => currentSessionId,
    isStarted: () => started
  };
}
