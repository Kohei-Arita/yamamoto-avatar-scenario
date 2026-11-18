import assert from "node:assert/strict";
import test from "node:test";
import { createSelfControlledSession } from "./liveavatar-session-events.js";

function fixture(t, respond) {
  const commands = [];
  const playbackStates = [];
  const microphoneEnabled = [];
  let complete;
  const result = new Promise((resolve) => {
    complete = resolve;
  });
  const room = {
    localParticipant: {
      publishData: async (bytes) => commands.push(JSON.parse(new TextDecoder().decode(bytes))),
      setMicrophoneEnabled: async (enabled) => microphoneEnabled.push(enabled)
    }
  };
  const session = createSelfControlledSession({
    getRoom: () => room,
    getSessionId: () => "batch-test",
    liveAvatarConfig: { selfControlled: true, allowInterrupt: false, transcriptDebounceMs: 1 },
    respondWithDialogueStream: (...args) => respond(commands, ...args),
    onPlaybackState: (state) => playbackStates.push(state),
    onAnswer: (answer) => complete({ answer }),
    onError: (error) => complete({ error })
  });
  t.after(() => session.dispose());
  session.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "はい、お願いします。"
  });
  return { commands, session, result, playbackStates, microphoneEnabled };
}

const segment = (index) => ({
  type: "speech_segment",
  data: { speechId: "reply", segmentIndex: index, segmentCount: 2, speechText: `説明${index}。` }
});

test(
  "字幕表示なしで全セグメントを順番に発話し、発話通知とマイク制御を維持する",
  { timeout: 2000 },
  async (t) => {
    const { commands, session, result, playbackStates, microphoneEnabled } = fixture(
      t,
      async (sent, id, text, { onEvent }) => {
        await onEvent(segment(0));
        assert.equal(sent.length, 0, "一文だけでは発話しない");
        await onEvent(segment(1));
        return { content: "説明0。説明1。" };
      }
    );
    assert.ok((await result).answer);
    assert.deepEqual(microphoneEnabled, [false]);
    assert.deepEqual(playbackStates, []);
    const first = commands.find((event) => event.event_type === "avatar.speak_text");
    assert.equal(first.text, "説明0。");
    session.handleAgentResponseEvent({
      event_type: "avatar.speak_started",
      source_event_id: first.event_id
    });
    session.handleAgentResponseEvent({
      event_type: "avatar.speak_ended",
      source_event_id: first.event_id
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(commands.at(-1).text, "説明1。");
    assert.deepEqual(microphoneEnabled, [false], "文の合間はマイクを開かない");
    assert.deepEqual(playbackStates, ["speaking"], "途中の終了通知でidleにしない");
    const second = commands.at(-1);
    for (const event_type of ["avatar.speak_started", "avatar.speak_ended"]) {
      session.handleAgentResponseEvent({ event_type, source_event_id: second.event_id });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(playbackStates, ["speaking", "speaking", "idle"]);
    assert.deepEqual(microphoneEnabled, [false, true]);
  }
);

test("完了イベントがあっても台詞が欠けていれば異常として止める", { timeout: 2000 }, async (t) => {
  const { commands, result } = fixture(t, async (sent, id, text, { onEvent }) => {
    await onEvent(segment(0));
    return { content: "説明0。説明1。" };
  });
  assert.match((await result).error.message, /最後まで受信/u);
  assert.equal(
    commands.some((event) => event.event_type === "avatar.speak_text"),
    false
  );
});
