// ミュート操作を直列化する。成功した状態だけを記録し、失敗は間隔を空けて再試行する。
export function createMicrophoneController({
  getRoom,
  initialMuted = false,
  retryMs = 500,
  maxRetries = 5,
  onLog = () => {},
  onState = () => {},
  onError = () => {}
}) {
  let desired = initialMuted;
  let applied = initialMuted;
  let running = false;
  let disposed = false;
  let retryTimer = null;
  let retries = 0;

  async function sync() {
    if (disposed || running || desired === applied) return;
    const participant = getRoom()?.localParticipant;
    if (typeof participant?.setMicrophoneEnabled !== "function") return;

    running = true;
    const target = desired;
    try {
      await participant.setMicrophoneEnabled(!target);
      applied = target;
      retries = 0;
      if (!disposed) {
        onLog(target ? "microphone.muted" : "microphone.unmuted");
        onState(target ? "muted" : "listening");
      }
    } catch (error) {
      if (!disposed) {
        onLog(`microphone.${target ? "mute" : "unmute"}_failed: ${error.message}`);
        if (retries++ < maxRetries) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            sync();
          }, retryMs);
        } else {
          onState("error");
          onError(
            new Error("マイクの切り替えに失敗しました。音声機器を確認して再接続してください。")
          );
        }
      }
    } finally {
      running = false;
    }
    if (!disposed && applied !== desired && !retryTimer && retries === 0) sync();
  }

  return {
    setMuted(muted) {
      if (disposed) return;
      if (desired !== muted) {
        desired = muted;
        retries = 0;
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      sync();
    },
    dispose() {
      disposed = true;
      clearTimeout(retryTimer);
    }
  };
}
