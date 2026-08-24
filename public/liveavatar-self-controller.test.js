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
  const micEnabledCalls = [];
  const room = {
    localParticipant: {
      isSpeaking: false,
      async publishData(payload) {
        publishedEvents.push(JSON.parse(new TextDecoder().decode(payload)));
      },
      async setMicrophoneEnabled(enabled) {
        micEnabledCalls.push(enabled);
      }
    }
  };

  return {
    room,
    publishedEvents,
    micEnabledCalls
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

test("merges a continuation that arrives after the first response already finished speaking", async () => {
  // 長い発話が息継ぎでVADに区切られ、前半への応答がすぐ完了した後に後半が届いた場合でも、
  // 独立した新規発話として扱わず結合・revision再判定すること(台本の誤った二重前進を防ぐ)。
  const calls = [];
  const logs = [];
  const conversation = createSelfControlledConversation({
    getRoom: () => null,
    getSessionId: () => "session-continuation-after-finish",
    debounceMs: 20,
    continuationWindowMs: 200,
    respondToTextStream: async ({ text }) => {
      calls.push(text);
      return { content: text };
    },
    onLog: (message) => logs.push(message)
  });

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "咳が出て"
  });

  await wait(40);

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "止まりません。"
  });

  await wait(50);

  assert.deepEqual(calls, ["咳が出て", "咳が出て止まりません。"]);
  assert.equal(logs.includes("user.transcription.resume: 咳が出て"), true);
  assert.equal(logs.includes("user.transcription.final: 咳が出て止まりません。 (revision)"), true);
});

test("stops merging once the continuation chain reaches maxContinuationChainLength", async () => {
  // 句点の付かない断片が継続時間内に届き続けても、結合は上限回数で打ち切られること。
  // (雑音などで断片が届き続けた場合に、結合が際限なく伸び続けるのを防ぐ)
  const calls = [];
  const logs = [];
  const conversation = createSelfControlledConversation({
    getRoom: () => null,
    getSessionId: () => "session-continuation-limit",
    debounceMs: 20,
    continuationWindowMs: 200,
    maxContinuationChainLength: 3,
    respondToTextStream: async ({ text }) => {
      calls.push(text);
      return { content: text };
    },
    onLog: (message) => logs.push(message)
  });

  conversation.handleAgentResponseEvent({ event_type: "user.transcription", text: "えっと" });
  await wait(40);

  conversation.handleAgentResponseEvent({ event_type: "user.transcription", text: "それでですね" });
  await wait(40);

  conversation.handleAgentResponseEvent({ event_type: "user.transcription", text: "実は" });
  await wait(40);

  // ここまでで結合チェーン長は3(上限)に達している。次の断片は結合されず独立した発話になる。
  conversation.handleAgentResponseEvent({ event_type: "user.transcription", text: "続いてます" });
  await wait(40);

  assert.deepEqual(calls, ["えっと", "えっとそれでですね", "えっとそれでですね実は", "続いてます"]);
  assert.equal(
    logs.includes("user.transcription.continuation_limit_reached: えっとそれでですね実は"),
    true
  );
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

test("句読点だけのASR断片は送信せず、アバターの発話も中断しない", async () => {
  const calls = [];
  const { room, publishedEvents } = createRoomWithPublishedEvents();
  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-non-lexical",
    debounceMs: 20,
    respondToTextStream: async ({ text }) => {
      calls.push(text);
      return { content: text };
    }
  });

  await conversation.speakText("たばこは、1日にどのくらい吸われていますか。");
  assert.equal(publishedEvents.length, 1);

  conversation.handleAgentResponseEvent({ event_type: "user.transcription", text: "。" });
  conversation.handleAgentResponseEvent({ event_type: "user.transcription", text: "あー" });

  await wait(60);

  // サーバーへ送らず、割り込み(avatar.interrupt)も発生しない
  assert.deepEqual(calls, []);
  assert.equal(publishedEvents.length, 1);
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

test("allowInterrupt=falseでは応答生成中(発話開始前)の音声も無視する", async () => {
  const calls = [];
  const conversation = createSelfControlledConversation({
    getRoom: () => null,
    getSessionId: () => "session-no-interrupt-generating",
    debounceMs: 20,
    allowInterrupt: false,
    respondToTextStream: ({ text }) => {
      calls.push(text);
      // サーバーからの応答がまだ返っていない(=発話は一切始まっていない)状態を再現する。
      return new Promise(() => {});
    }
  });

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "咳が出ます"
  });

  await wait(40);
  assert.deepEqual(calls, ["咳が出ます"]);

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "あの、質問があります"
  });

  await wait(50);

  // 発話開始前(応答生成中)の音声も無視され、2回目の応答生成は走らない
  assert.deepEqual(calls, ["咳が出ます"]);
});

test("allowInterrupt=falseでは複数文発話の合間(次セグメント送出中)の音声も無視する", async () => {
  const { room, publishedEvents } = createRoomWithPublishedEvents();
  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-no-interrupt-gap",
    allowInterrupt: false,
    respondToTextStream: async () => ({ content: "" })
  });

  await conversation.speakText("最初の文です。");
  await conversation.speakText("次の文です。");
  assert.equal(publishedEvents.length, 1);

  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_started",
    client_response_id: publishedEvents[0].client_response_id,
    client_generation_id: publishedEvents[0].client_generation_id,
    client_segment_id: publishedEvents[0].client_segment_id
  });

  // 1文目の発話終了イベント。内部的には次の文の送出が同期的に始まる瞬間。
  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_ended",
    client_response_id: publishedEvents[0].client_response_id,
    client_generation_id: publishedEvents[0].client_generation_id,
    client_segment_id: publishedEvents[0].client_segment_id
  });

  // isSpeakingがfalseに戻った直後(=次のセグメント送出中)に届いた音声も無視されること。
  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "あの、ちょっと"
  });

  await wait(50);

  // 2文目の発話コマンドは中断されずそのまま送出されている
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

test("応答中は自分のマイクをミュートし、アイドルに戻ったらミュートを解除する", async () => {
  // avatar.interrupt/avatar.stop_listeningのようなコマンド送信はLiveAvatar側の処理に
  // 依存するため信頼しきれない。マイクの発行自体を止めれば、相手に音声が物理的に
  // 届かなくなるため、プラットフォーム側の反応経路を含めて確実に防げる。
  const { room, publishedEvents, micEnabledCalls } = createRoomWithPublishedEvents();
  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-mic-mute",
    respondToTextStream: async () => ({ content: "" })
  });

  await conversation.speakText("最初の文です。");

  // 発話コマンドを送る前にミュートされている(false = setMicrophoneEnabled(false))
  assert.deepEqual(micEnabledCalls, [false]);

  const speakTextEvent = publishedEvents[0];

  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_started",
    client_response_id: speakTextEvent.client_response_id,
    client_generation_id: speakTextEvent.client_generation_id,
    client_segment_id: speakTextEvent.client_segment_id
  });

  // 発話中はミュートしたまま(重複でsetMicrophoneEnabledを呼ばない)
  assert.deepEqual(micEnabledCalls, [false]);

  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_ended",
    client_response_id: speakTextEvent.client_response_id,
    client_generation_id: speakTextEvent.client_generation_id,
    client_segment_id: speakTextEvent.client_segment_id
  });

  // 完全にアイドルへ戻ったのでミュート解除(true)が呼ばれる
  assert.deepEqual(micEnabledCalls, [false, true]);
});

test("複数文の発話中はセグメントの合間でマイクのミュートを解除しない", async () => {
  const { room, publishedEvents, micEnabledCalls } = createRoomWithPublishedEvents();
  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-mic-mute-multi-segment",
    respondToTextStream: async () => ({ content: "" })
  });

  await conversation.speakText("一文目です。");
  await conversation.speakText("二文目です。");

  assert.deepEqual(micEnabledCalls, [false]);

  const firstSpeak = publishedEvents[0];

  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_started",
    client_response_id: firstSpeak.client_response_id,
    client_generation_id: firstSpeak.client_generation_id,
    client_segment_id: firstSpeak.client_segment_id
  });

  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_ended",
    client_response_id: firstSpeak.client_response_id,
    client_generation_id: firstSpeak.client_generation_id,
    client_segment_id: firstSpeak.client_segment_id
  });

  // 1文目が終わっても2文目がまだ控えているため、ミュートは解除しない
  assert.deepEqual(micEnabledCalls, [false]);

  // 2文目のavatar.speak_text送出(pendingSpeechSegmentへの反映)はマイクロタスクで
  // 一呼吸置いて完了するため、speak_startedを送る前に少し待つ。
  await wait(0);

  const secondSpeak = publishedEvents
    .filter((event) => event.event_type === "avatar.speak_text")
    .find((event) => event.text === "二文目です。");

  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_started",
    client_response_id: secondSpeak.client_response_id,
    client_generation_id: secondSpeak.client_generation_id,
    client_segment_id: secondSpeak.client_segment_id
  });

  conversation.handleAgentResponseEvent({
    event_type: "avatar.speak_ended",
    client_response_id: secondSpeak.client_response_id,
    client_generation_id: secondSpeak.client_generation_id,
    client_segment_id: secondSpeak.client_segment_id
  });

  assert.deepEqual(micEnabledCalls, [false, true]);
});

test("マイクミュート中に届いた文字起こしは無視され、割り込みは起きない", async () => {
  // マイクをミュートしていても、LiveAvatar側から届く古いバッファ分の文字起こしや
  // エコー等が届く可能性を想定し、allowInterrupt=falseの無視ロジックと組み合わさって
  // 二重に安全であることを確認する。
  const calls = [];
  const { room, micEnabledCalls } = createRoomWithPublishedEvents();
  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-mic-mute-allow-interrupt-false",
    debounceMs: 20,
    allowInterrupt: false,
    respondToTextStream: async ({ text }) => {
      calls.push(text);
      return { content: text };
    }
  });

  await conversation.speakText("説明の途中です。");
  assert.deepEqual(micEnabledCalls, [false]);

  conversation.handleAgentResponseEvent({
    event_type: "user.transcription",
    text: "あの、質問があります"
  });

  await wait(50);

  assert.deepEqual(calls, []);
  assert.deepEqual(micEnabledCalls, [false]);
});

test("マイクのミュート解除に失敗したら再試行して実状態を復帰させる", async () => {
  // 解除失敗を「適用済み」として扱うと、マイクが落ちたまま患者の声が二度と届かなくなる。
  const micEnabledCalls = [];
  let failNextUnmute = true;
  const room = {
    localParticipant: {
      isSpeaking: false,
      async publishData() {},
      async setMicrophoneEnabled(enabled) {
        micEnabledCalls.push(enabled);

        if (enabled && failNextUnmute) {
          failNextUnmute = false;
          throw new Error("device busy");
        }
      }
    }
  };

  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-mic-unmute-retry",
    micSyncRetryMs: 10,
    respondToTextStream: async () => ({ content: "" })
  });

  await conversation.speakText("説明です。");
  await wait(0);
  assert.deepEqual(micEnabledCalls, [false]);

  conversation.handleAgentResponseEvent({ event_type: "avatar.speak_started" });
  conversation.handleAgentResponseEvent({ event_type: "avatar.speak_ended" });

  await wait(0);
  // 1回目の解除は失敗する
  assert.deepEqual(micEnabledCalls, [false, true]);

  await wait(40);
  // 再試行で解除が成功する
  assert.deepEqual(micEnabledCalls, [false, true, true]);

  conversation.reset();
});

test("マイクのミュート要求が連続しても実状態が反転しないよう直列化する", async () => {
  // setMicrophoneEnabledの完了順が入れ替わると、発話中なのにマイクが開く事故になる。
  const micEnabledCalls = [];
  const resolvers = [];
  const room = {
    localParticipant: {
      isSpeaking: false,
      async publishData() {},
      setMicrophoneEnabled(enabled) {
        micEnabledCalls.push(enabled);
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      }
    }
  };

  const conversation = createSelfControlledConversation({
    getRoom: () => room,
    getSessionId: () => "session-mic-serialized",
    respondToTextStream: async () => ({ content: "" })
  });

  await conversation.speakText("一文目です。");
  assert.deepEqual(micEnabledCalls, [false]);

  // ミュートが未完了のうちに発話が終わり、解除要求が重なる状況を作る。
  conversation.handleAgentResponseEvent({ event_type: "avatar.speak_started" });
  conversation.handleAgentResponseEvent({ event_type: "avatar.speak_ended" });

  // 前のミュートが完了するまで解除は発行しない
  assert.deepEqual(micEnabledCalls, [false]);

  resolvers[0]();
  await wait(0);

  // ミュート完了後に、最新の目標(解除)へ追随する
  assert.deepEqual(micEnabledCalls, [false, true]);

  resolvers[1]();
  await wait(0);

  conversation.reset();
});
