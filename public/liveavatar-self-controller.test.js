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
  assert.equal(logs.includes("user.transcription.final: を疑う病変に知りたい。"), true);
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
