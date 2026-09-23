import assert from "node:assert/strict";
import test from "node:test";
import { createSelfControlledSession } from "./liveavatar-session-events.js";

function fixture(t, respond) {
  const commands = [];
  let complete;
  const result = new Promise((resolve) => {
    complete = resolve;
  });
  const room = {
    localParticipant: {
      publishData: async (bytes) => commands.push(JSON.parse(new TextDecoder().decode(bytes))),
      setMicrophoneEnabled: async () => {}
    }
  };
  const session = createSelfControlledSession({
    getRoom: () => room,
    getSessionId: () => "batch-test",
    liveAvatarConfig: { selfControlled: true, allowInterrupt: false, transcriptDebounceMs: 1 },
    respondWithDialogueStream: (...args) => respond(commands, ...args),
    onAnswer: (answer) => complete({ answer }),
    onError: (error) => complete({ error })
  });
  t.after(() => session.dispose());
  session.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "はい、お願いします。"
  });
  return { commands, session, result };
}

const segment = (index) => ({
  type: "speech_segment",
  data: { speechId: "reply", segmentIndex: index, segmentCount: 2, speechText: `説明${index}。` }
});

test("患者への返答も全セグメントを受信してから順番に発話する", { timeout: 2000 }, async (t) => {
  const { commands, session, result } = fixture(t, async (sent, id, text, { onEvent }) => {
    await onEvent(segment(0));
    assert.equal(sent.length, 0, "一文だけでは発話しない");
    await onEvent(segment(1));
    return { content: "説明0。説明1。" };
  });
  assert.ok((await result).answer);
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
});

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
