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
