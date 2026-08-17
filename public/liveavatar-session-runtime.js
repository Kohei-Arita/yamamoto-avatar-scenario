import {
  createSelfControlledSession,
  startOpeningGreeting as startSelfControlledOpeningGreeting
} from "./liveavatar-session-events.js";
import { attachTrackToMediaElements } from "./liveavatar-session-ui.js";

export function createTrackAttacher({
  Track,
  remoteVideo,
  remoteAudio,
  videoPlaceholder,
  onVideoTrackAttached = () => {},
  onAudioTrackAttached = () => {},
  onAudioBlocked = () => {}
} = {}) {
  return function attachTrack(track) {
    const attachedKind = attachTrackToMediaElements(track, {
      Track,
      remoteVideo,
      remoteAudio,
      videoPlaceholder,
      onAudioBlocked
    });

    if (attachedKind === "video") {
      onVideoTrackAttached();
    }

    if (attachedKind === "audio") {
      onAudioTrackAttached();
    }
  };
}

export function initializeSelfControlledConversation({
  getRoom,
  getSessionId,
  liveAvatarConfig,
  respondWithDialogueStream,
  subtitleController,
  onLog = () => {},
  onAnswer = () => {},
  onError = () => {}
} = {}) {
  return createSelfControlledSession({
    getRoom,
    getSessionId,
    liveAvatarConfig,
    respondWithDialogueStream,
    subtitleController,
    onLog,
    onAnswer,
    onError
  });
}

export async function startOpeningGreeting({
  liveAvatarConfig,
  selfControlledConversation,
  onError = () => {}
} = {}) {
  try {
    await startSelfControlledOpeningGreeting(liveAvatarConfig, selfControlledConversation);
  } catch (error) {
    onError(error);
  }
}

export function createSessionLockHeartbeat(sessionStartLock, { intervalMs = 60_000 } = {}) {
  let timerId = null;

  return {
    start() {
      clearInterval(timerId);
      timerId = setInterval(() => {
        sessionStartLock.refresh();
      }, intervalMs);
    },
    stop() {
      clearInterval(timerId);
      timerId = null;
    }
  };
}

export async function disconnectRoom(room) {
  if (!room) {
    return;
  }

  try {
    await room.localParticipant.setMicrophoneEnabled(false);
  } catch {
    // Ignore microphone shutdown errors during teardown.
  }

  room.disconnect();
}

export async function stopLiveAvatarSessionSafely(
  sessionToken,
  stopLiveAvatarSession,
  { onError = () => {} } = {}
) {
  if (!sessionToken) {
    return;
  }

  try {
    await stopLiveAvatarSession(sessionToken);
  } catch (error) {
    onError(error);
  }
}
