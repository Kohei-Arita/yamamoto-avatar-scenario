import { clearChromaKeyCanvas, setupChromaKey } from "./liveavatar-chroma-key.js";
import { normalizeSubtitleText } from "./liveavatar-subtitles.js";

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

function createTabId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

export function createSessionStartLock({
  storageKey = "liveavatar-session-start-lock",
  ttlMs = 15 * 60 * 1000,
  storage = window.localStorage,
  tabId = createTabId()
} = {}) {
  function readLock() {
    try {
      const raw = storage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;

      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.tabId !== "string" ||
        !Number.isFinite(parsed.expiresAt)
      ) {
        if (raw) {
          storage.removeItem(storageKey);
        }

        return null;
      }

      return parsed;
    } catch {
      storage.removeItem(storageKey);
      return null;
    }
  }

  function clearExpiredLock() {
    const existingLock = readLock();

    if (!existingLock || existingLock.expiresAt > Date.now()) {
      return existingLock;
    }

    storage.removeItem(storageKey);
    return null;
  }

  return {
    acquire() {
      const existingLock = clearExpiredLock();

      if (existingLock && existingLock.tabId !== tabId) {
        return false;
      }

      storage.setItem(
        storageKey,
        JSON.stringify({
          tabId,
          expiresAt: Date.now() + ttlMs
        })
      );

      return true;
    },
    refresh() {
      const existingLock = clearExpiredLock();

      if (!existingLock || existingLock.tabId !== tabId) {
        return false;
      }

      storage.setItem(
        storageKey,
        JSON.stringify({
          tabId,
          expiresAt: Date.now() + ttlMs
        })
      );

      return true;
    },
    release() {
      const existingLock = readLock();

      if (existingLock?.tabId === tabId) {
        storage.removeItem(storageKey);
      }
    }
  };
}

export function createSubtitleController({
  subtitleBox,
  showSubtitles = true,
  hideDelayMs = 1200
} = {}) {
  let clearTimer = null;

  function set(text) {
    clearTimeout(clearTimer);

    const normalizedText = normalizeSubtitleText(text);

    if (!subtitleBox || !showSubtitles || !normalizedText) {
      subtitleBox?.classList.add("hidden");

      if (subtitleBox) {
        subtitleBox.textContent = "";
      }

      return;
    }

    subtitleBox.textContent = normalizedText;
    subtitleBox.classList.remove("hidden");
  }

  function clearSoon() {
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      set("");
    }, hideDelayMs);
  }

  function clearNow() {
    clearTimeout(clearTimer);
    set("");
  }

  function dispose() {
    clearTimeout(clearTimer);
  }

  return {
    set,
    clearSoon,
    clearNow,
    dispose
  };
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
  { Track, remoteVideo, remoteAudio, videoPlaceholder } = {}
) {
  if (track.kind === Track.Kind.Video) {
    track.attach(remoteVideo);
    videoPlaceholder?.classList.add("hidden");
    remoteVideo.play().catch(() => {});
    return "video";
  }

  if (track.kind === Track.Kind.Audio) {
    track.attach(remoteAudio);
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
