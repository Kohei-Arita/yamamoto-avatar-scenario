import assert from "node:assert/strict";
import test from "node:test";

import { createSelfControlledConversation } from "./liveavatar-self-controller.js";

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createAbortableResponder(calls) {
  return async ({ text, signal }) => {
    calls.push(text);

    if (calls.length > 1) {
      return { content: text };
    }

    return new Promise((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true }
      );
    });
  };
}

function createRoomWithPublishedEvents() {
  const publishedEvents = [];
  const room = {
    localParticipant: {
      isSpeaking: false,
      async publishData(payload) {
        publishedEvents.push(JSON.parse(new TextDecoder().decode(payload)));
      }
    }
  };

  return {
    room,
    publishedEvents
  };
}

test("buffers adjacent transcription fragments into one final utterance", async () => {
  const calls = [];
  const conversation = createSelfControlledConversation({
    getRoom: () => null,
    getSessionId: () => "session-1",
    debounceMs: 20,
    continuationWindowMs: 80,
    respondToTextStream: async ({ text }) => {
      calls.push(text);
      return { content: text };
    }
  });

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "肺がんの"
  });
  await wait(10);
  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "治療"
  });

  await wait(40);

  assert.deepEqual(calls, ["肺がんの治療"]);
});

test("rebuilds the utterance when a short continuation arrives after finalization", async () => {
  const calls = [];
  const logs = [];
  const conversation = createSelfControlledConversation({
    getRoom: () => null,
    getSessionId: () => "session-2",
    debounceMs: 20,
    continuationWindowMs: 120,
    respondToTextStream: createAbortableResponder(calls),
    onLog: (message) => logs.push(message)
  });

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "を疑う病変に"
  });

  await wait(40);

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "知りたい。"
  });

  await wait(50);

  assert.deepEqual(calls, ["を疑う病変に", "を疑う病変に知りたい。"]);
  assert.equal(logs.includes("user.transcription.resume: を疑う病変に"), true);
  assert.equal(logs.includes("user.transcription.final: を疑う病変に知りたい。 (revision)"), true);
});

test("does not merge a new utterance when the previous final already ended with punctuation", async () => {
  const calls = [];
  const conversation = createSelfControlledConversation({
    getRoom: () => null,
    getSessionId: () => "session-3",
    debounceMs: 20,
    continuationWindowMs: 120,
    respondToTextStream: createAbortableResponder(calls)
  });

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "知りたい。"
  });

  await wait(40);

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "副作用は？"
  });

  await wait(50);

  assert.deepEqual(calls, ["知りたい。", "副作用は？"]);
});

test("waits for local microphone speech to stop before finalizing", async () => {
  const calls = [];
  const room = {
    localParticipant: {
      isSpeaking: true
    }
  };
  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-4",
    debounceMs: 20,
    continuationWindowMs: 120,
    flushPollMs: 15,
    respondToTextStream: async ({ text }) => {
      calls.push(text);
      return { content: text };
    }
  });

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "長い質問の途中"
  });

  await wait(40);
  assert.deepEqual(calls, []);

  room.localParticipant.isSpeaking = false;

  await wait(30);
  assert.deepEqual(calls, ["長い質問の途中"]);
});

test("matches avatar lifecycle events by echoed client ids before advancing the queue", async () => {
  const startedSubtitles = [];
  const { room, publishedEvents } = createRoomWithPublishedEvents();
  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-5",
    respondToTextStream: async () => ({ content: "" }),
    onSpeechStart: (text) => startedSubtitles.push(text)
  });

  await conversation.speakText("最初の文です。");
  await conversation.speakText("次の文です。");

  assert.equal(publishedEvents.length, 1);
  assert.equal(publishedEvents[0].event_type, "avatar.speak_text");

  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_started",
    client_response_id: "stale-response",
    client_segment_id: "stale-segment"
  });

  assert.deepEqual(startedSubtitles, []);

  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_started",
    client_response_id: publishedEvents[0].client_response_id,
    client_generation_id: publishedEvents[0].client_generation_id,
    client_segment_id: publishedEvents[0].client_segment_id
  });

  assert.deepEqual(startedSubtitles, ["最初の文です。"]);

  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_ended",
    client_response_id: "stale-response",
    client_segment_id: "stale-segment"
  });

  assert.equal(publishedEvents.length, 1);

  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_ended",
    client_response_id: publishedEvents[0].client_response_id,
    client_generation_id: publishedEvents[0].client_generation_id,
    client_segment_id: publishedEvents[0].client_segment_id
  });

  assert.equal(publishedEvents.length, 2);
  assert.equal(publishedEvents[1].event_type, "avatar.speak_text");
  assert.equal(publishedEvents[1].text, "次の文です。");
});

test("speak_started未着時はspeak_textを一度だけ自動再送する(開始挨拶の無音対策)", async () => {
  const { room, publishedEvents } = createRoomWithPublishedEvents();
  const startedSubtitles = [];
  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-speak-retry",
    respondToTextStream: async () => ({ content: "" }),
    speakStartTimeoutMs: 30,
    speakEndTimeoutBaseMs: 200,
    speakEndTimeoutPerCharMs: 0,
    onSpeechStart: (text) => startedSubtitles.push(text)
  });

  await conversation.speakText("こんにちは。山本です。");
  assert.equal(publishedEvents.length, 1);

  // speak_startedが届かないままタイムアウト → 同じsegmentIdで再送される
  await wait(50);

  const speakEvents = publishedEvents.filter((event) => event.event_type === "avatar.speak_text");
  assert.equal(speakEvents.length, 2);
  assert.equal(speakEvents[0].client_segment_id, speakEvents[1].client_segment_id);

  // 再送分にspeak_startedが返れば通常どおり発話開始扱いになる
  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_started",
    client_segment_id: speakEvents[1].client_segment_id
  });
  assert.deepEqual(startedSubtitles, ["こんにちは。山本です。"]);

  // 3回目の再送はしない
  await wait(50);
  assert.equal(
    publishedEvents.filter((event) => event.event_type === "avatar.speak_text").length,
    2
  );
});

test("speak_started/endedが届かなくてもウォッチドッグでキューが前進する", async () => {
  const { room, publishedEvents } = createRoomWithPublishedEvents();
  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-watchdog",
    respondToTextStream: async () => ({ content: "" }),
    speakStartTimeoutMs: 30,
    speakEndTimeoutBaseMs: 30,
    speakEndTimeoutPerCharMs: 0
  });

  await conversation.speakText("一文目です。");
  await conversation.speakText("二文目です。");

  assert.equal(publishedEvents.length, 1);

  // アバターからのライフサイクルイベントが一切届かなくても、
  // 再送(1回)→発話中とみなす→endウォッチドッグの経過後に次のセグメントへ前進する
  await wait(200);

  const texts = publishedEvents
    .filter((event) => event.event_type === "avatar.speak_text")
    .map((event) => event.text);
  assert.equal(texts.filter((text) => text === "一文目です。").length, 2);
  assert.ok(texts.includes("二文目です。"));
});

test("アバター発話のエコー(回り込み文字起こし)を患者発話として扱わない", async () => {
  const calls = [];
  const { room } = createRoomWithPublishedEvents();
  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-echo",
    debounceMs: 20,
    respondToTextStream: async ({ text }) => {
      calls.push(text);
      return { content: text };
    }
  });

  await conversation.speakText("画像では、右下葉に約40mmの不整形な結節を認めます。");

  // アバターの発話がスピーカー→マイク経由で文字起こしされて返ってきた
  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "画像では右下葉に約40mmの不整形な結節を認めます"
  });

  await wait(60);
  assert.deepEqual(calls, []);

  // 本物の患者発話は通る
  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "特にありません"
  });

  await wait(60);
  assert.deepEqual(calls, ["特にありません"]);
});

test("継続発話の結合再送にはrevisionフラグが付く", async () => {
  const requests = [];
  const conversation = createSelfControlledConversation({
    getRoom: () => null,
    getSessionId: () => "session-revision",
    debounceMs: 20,
    continuationWindowMs: 120,
    respondToTextStream: async ({ text, revision, signal }) => {
      requests.push({ text, revision });

      if (requests.length > 1) {
        return { content: text };
      }

      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    }
  });

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "坂道で少し"
  });

  await wait(40);

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "息切れがします。"
  });

  await wait(50);

  assert.deepEqual(requests, [
    { text: "坂道で少し", revision: false },
    { text: "坂道で少し息切れがします。", revision: true }
  ]);
});

test("allowInterrupt=falseではアバター発話中の音声を無視する", async () => {
  const calls = [];
  const { room, publishedEvents } = createRoomWithPublishedEvents();
  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-no-interrupt",
    debounceMs: 20,
    allowInterrupt: false,
    respondToTextStream: async ({ text }) => {
      calls.push(text);
      return { content: text };
    }
  });

  await conversation.speakText("説明の途中です。");
  assert.equal(publishedEvents.length, 1);

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "あの、質問があります"
  });

  await wait(50);

  // 発話中の音声は無視され、割り込み(interrupt)も発生しない
  assert.deepEqual(calls, []);
  assert.equal(publishedEvents.length, 1);
});

test("holds new speech until the interrupt grace window passes and clears stale subtitles", async () => {
  const resets = [];
  const startedSubtitles = [];
  const { room, publishedEvents } = createRoomWithPublishedEvents();
  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-6",
    respondToTextStream: async () => ({ content: "" }),
    interruptGraceMs: 40,
    onSpeechStart: (text) => startedSubtitles.push(text),
    onSpeechReset: () => resets.push("reset")
  });

  await conversation.speakText("古い文です。");
  assert.equal(publishedEvents.length, 1);

  conversation.reset();

  assert.equal(publishedEvents.length, 2);
  assert.equal(publishedEvents[1].event_type, "avatar.interrupt");
  assert.deepEqual(resets, ["reset"]);

  await conversation.speakText("新しい文です。");

  assert.equal(publishedEvents.length, 2);

  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_started",
    client_response_id: "stale-response",
    client_segment_id: "stale-segment"
  });

  assert.deepEqual(startedSubtitles, []);

  await wait(60);

  assert.equal(publishedEvents.length, 3);
  assert.equal(publishedEvents[2].event_type, "avatar.speak_text");
  assert.equal(publishedEvents[2].text, "新しい文です。");
});
