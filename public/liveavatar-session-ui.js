import { clearChromaKeyCanvas, setupChromaKey } from "./liveavatar-chroma-key.js";
export { createSessionStartLock } from "./session-start-lock.js";

export function describeSessionError(error, { defaultMessage = "Unknown error" } = {}) {
  if (!error) {
    return defaultMessage;
  }

  if (error.name === "NotAllowedError" || error.message === "Permission dismissed") {
    return "マイク権限が許可されていません。ブラウザのマイク設定を確認してください。";
  }

  if (error.name === "NotFoundError") {
    return "利用できるマイクが見つかりません。入力デバイスを確認してください。";
  }

  if (error.name === "NotReadableError") {
    return "マイクが他のアプリに使用されています。ほかの通話・録音アプリを停止してください。";
  }

  return error.message || defaultMessage;
}

export function createChromaKeyController({
  remoteVideo,
  remoteCanvas,
  containerElement,
  options = {}
} = {}) {
  let stopProcessing = null;

  function stop({ clearCanvas = false, showVideo = true } = {}) {
    if (stopProcessing) {
      stopProcessing();
      stopProcessing = null;
    }

    if (clearCanvas) {
      clearChromaKeyCanvas(remoteCanvas);
    }

    if (showVideo) {
      remoteVideo?.classList.remove("chroma-source-hidden");
    }

    containerElement?.classList.remove("chroma-key-active");
    remoteCanvas?.classList.add("hidden");
  }

  function hasRenderableVideo() {
    return (
      remoteVideo?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && remoteVideo.videoWidth > 0
    );
  }

  function update(enabled) {
    stop({ clearCanvas: true, showVideo: true });

    if (!enabled || !hasRenderableVideo()) {
      return;
    }

    remoteVideo.classList.add("chroma-source-hidden");
    containerElement?.classList.add("chroma-key-active");
    remoteCanvas.classList.remove("hidden");
    stopProcessing = setupChromaKey(remoteVideo, remoteCanvas, options);
  }

  return {
    hasRenderableVideo,
    stop,
    update
  };
}

export function attachTrackToMediaElements(
  track,
  { Track, remoteVideo, remoteAudio, videoPlaceholder, onAudioBlocked = () => {} } = {}
) {
  if (track.kind === Track.Kind.Video) {
    track.attach(remoteVideo);
    videoPlaceholder?.classList.add("hidden");
    remoteVideo.play().catch(() => {});
    return "video";
  }

  if (track.kind === Track.Kind.Audio) {
    track.attach(remoteAudio);

    // autostart時などユーザー操作なしで開始した場合、ブラウザの自動再生制限で
    // 音声がブロックされることがある。検知して呼び出し元に通知する(タップで解除)。
    remoteAudio.play()?.catch?.((error) => {
      onAudioBlocked(error);
    });
    return "audio";
  }

  return "unknown";
}

export function resetRemoteMediaElements({ remoteVideo, remoteAudio, videoPlaceholder } = {}) {
  for (const mediaElement of [remoteVideo, remoteAudio]) {
    if (!mediaElement) {
      continue;
    }

    mediaElement.pause();
    mediaElement.srcObject = null;
    mediaElement.removeAttribute("src");
    mediaElement.load();
  }

  videoPlaceholder?.classList.remove("hidden");
}
