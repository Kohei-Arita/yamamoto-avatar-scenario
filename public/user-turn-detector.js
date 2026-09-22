// 1回の受付期限は最初の発話検出から固定。文字起こしや雑音で延長しない。
export const MAX_USER_TURN_MS = 30_000;

export function createUserTurnDetector({
  getLocalSpeaking,
  silenceMs = 1200,
  maxDurationMs = MAX_USER_TURN_MS,
  pollMs = 250,
  onEnd,
  onLog = () => {}
}) {
  let startedAt = null;
  let quietSince = null;
  let lastTranscriptAt = null;
  let remoteSpeaking = false;
  let timer = null;

  function reset() {
    clearTimeout(timer);
    timer = null;
    startedAt = null;
    quietSince = null;
    lastTranscriptAt = null;
    remoteSpeaking = false;
  }

  function finish(reason) {
    const now = Date.now();
    const details = {
      reason,
      durationMs: now - startedAt,
      quietMs: quietSince === null ? 0 : now - quietSince,
      lastTranscriptAgeMs: lastTranscriptAt === null ? null : now - lastTranscriptAt,
      liveKitSpeaking: Boolean(getLocalSpeaking()),
      liveAvatarSpeaking: remoteSpeaking
    };
    reset();
    onEnd(details);
  }

  // タイマーの実行が遅れた場合も、期限後に到着した断片を取り込まない。
  function expireIfNeeded() {
    if (startedAt !== null && Date.now() - startedAt >= maxDurationMs) {
      finish("max_duration");
      return true;
    }
    return false;
  }

  function begin(source) {
    if (startedAt !== null) return;
    startedAt = Date.now();
    onLog(`user.turn.started: ${JSON.stringify({ source, maxDurationMs })}`);
  }

  function observeSilence() {
    if (remoteSpeaking || getLocalSpeaking()) quietSince = null;
    else quietSince ??= Date.now();
  }

  function schedule() {
    clearTimeout(timer);
    const now = Date.now();
    const quietRemaining =
      quietSince === null
        ? pollMs
        : silenceMs - (now - Math.max(quietSince, lastTranscriptAt ?? quietSince));
    timer = setTimeout(
      check,
      Math.max(0, Math.min(pollMs, maxDurationMs - (now - startedAt), quietRemaining))
    );
  }

  function check() {
    if (startedAt === null || expireIfNeeded()) return;
    observeSilence();
    if (
      quietSince !== null &&
      Date.now() - Math.max(quietSince, lastTranscriptAt ?? quietSince) >= silenceMs
    ) {
      finish("silence");
      return;
    }
    schedule();
  }

  function transcriptReceived() {
    begin("transcript");
    lastTranscriptAt = Date.now();
    observeSilence();
    schedule();
  }

  function remoteSpeechChanged(speaking) {
    remoteSpeaking = speaking;
    if (speaking) begin("liveavatar");
    if (startedAt === null) return;
    observeSilence();
    schedule();
  }

  function localSpeechChanged() {
    if (getLocalSpeaking()) begin("livekit");
    if (startedAt === null) return;
    observeSilence();
    schedule();
  }

  return { transcriptReceived, remoteSpeechChanged, localSpeechChanged, expireIfNeeded, reset };
}
