import {
  bindRagSession,
  connectLiveKitRoom,
  createLiveAvatarSessionToken,
  ensureMicrophoneAccess,
  fetchLiveAvatarConfig,
  respondWithRagStream,
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
  onRagAnswer = () => {},
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
  let startPromise = null;

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
    onVideoTrackAttached: updateChromaKey
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

    startPromise = (async () => {
      onConnectionStateChange("starting");

      try {
        if (!config) {
          config = await fetchLiveAvatarConfig();
        }

        if (!skipMicrophonePreflight) {
          await ensureMicrophoneAccess({
            unsupportedMessage: "このブラウザではマイク取得 API が使えません。"
          });
        }

        const tokenResponse = await createLiveAvatarSessionToken();
        sessionToken = tokenResponse.session_token;
        currentSessionId = tokenResponse.session_id || null;

        const session = await startLiveAvatarSession(sessionToken);
        await internalConnectRoom(session.livekit_url, session.livekit_token);

        selfControlledConversation = initializeSelfControlledConversation({
          getRoom: () => room,
          getSessionId: () => currentSessionId,
          liveAvatarConfig: config,
          respondWithRagStream,
          subtitleController,
          onLog,
          onAnswer: onRagAnswer,
          onError
        });

        sessionLockHeartbeat.start();
        await bindRagSession(currentSessionId);
        await startOpeningGreeting({
          liveAvatarConfig: config,
          selfControlledConversation,
          onError
        });

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
