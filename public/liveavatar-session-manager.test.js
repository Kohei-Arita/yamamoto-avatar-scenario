import assert from "node:assert/strict";
import test from "node:test";
import { createSessionManager } from "./liveavatar-session-manager.js";

const managers = [];
test.beforeEach(() => {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    }
  };
});
test.afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  delete globalThis.window;
});

function element() {
  return {
    classList: { add() {}, remove() {} },
    play: async () => {},
    pause() {},
    load() {},
    removeAttribute() {},
    textContent: ""
  };
}
function fixture(overrides = {}) {
  const rooms = [];
  const sources = [];
  const stopped = [];
  const disconnected = [];
  let count = 0;
  const state = {
    epoch: "original-server",
    speechId: "initial-speech",
    version: 4,
    nodeId: "s1_adl",
    acceptsPatientInput: true
  };
  const api = {
    fetchLiveAvatarConfig: async () => ({ selfControlled: true, allowInterrupt: false }),
    ensureMicrophoneAccess: async () => {},
    createLiveAvatarSessionToken: async () => ({
      session_token: `token-${++count}`,
      session_id: `session-${count}`
    }),
    startLiveAvatarSession: async () => ({ livekit_url: "mock", livekit_token: "mock" }),
    stopLiveAvatarSession: async (token) => {
      stopped.push(token);
    },
    keepLiveAvatarSessionAlive: async () => {},
    connectLiveKitRoom: async (callbacks) => {
      const commands = [];
      const mic = [];
      const room = {
        callbacks,
        commands,
        mic,
        localParticipant: {
          publishData: async (bytes) => {
            commands.push(JSON.parse(new TextDecoder().decode(bytes)));
          },
          setMicrophoneEnabled: async (enabled) => {
            mic.push(enabled);
          }
        },
        disconnect: async () => {
          callbacks.onDisconnected("client");
        }
      };
      rooms.push(room);
      callbacks.onRoomCreated(room);
      callbacks.attachTrack({ kind: "audio", attach() {} });
      return room;
    },
    bindDialogueSession: async () => ({
      state,
      openingSegments: [{ speechText: "途中の質問です。", subtitleText: "途中の質問です。" }]
    }),
    subscribeDialogueEvents: (id, callbacks) => {
      const source = {
        id,
        callbacks,
        closed: false,
        close() {
          this.closed = true;
        }
      };
      sources.push(source);
      queueMicrotask(() =>
        callbacks.onConnectionChange(true, {
          state,
          openingSegments: [{ speechText: "途中の質問です。" }]
        })
      );
      return source;
    },
    respondWithDialogueStream: async () => ({ content: "" }),
    ...overrides
  };
  const manager = createSessionManager({
    api,
    LivekitClient: { Track: { Kind: { Audio: "audio", Video: "video" } } },
    elements: {
      remoteVideo: element(),
      remoteAudio: element(),
      videoPlaceholder: element(),
      subtitleBox: element()
    },
    onDisconnected: (reason) => disconnected.push(reason)
  });
  managers.push(manager);
  return { manager, api, rooms, sources, stopped, disconnected, state };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("起動準備中に無言ノードへジャンプしたら、古い開始台詞を再生しない", async () => {
  const { manager, api, rooms, sources, state } = fixture();
  const connect = api.connectLiveKitRoom;
  let audioReady;
  api.connectLiveKitRoom = (callbacks) =>
    connect({
      ...callbacks,
      attachTrack: (...args) => {
        audioReady = () => callbacks.attachTrack(...args);
      }
    });
  const starting = manager.start();
  await tick();
  sources[0].callbacks.onState(
    {
      ...state,
      version: state.version + 1,
      speechId: "silent-start",
      nodeId: "s1_voting1_wait",
      acceptsPatientInput: false
    },
    { replace: true }
  );
  audioReady();
  await starting;
  assert.equal(
    rooms[0].commands.some((command) => command.event_type === "avatar.speak_text"),
    false
  );
  assert.equal(rooms[0].mic.includes(true), false);
});

for (const reconnect of [false, true]) {
  test(`無言の投票待ちへの操作は古い発話を中断し、入力を閉じる（再接続: ${reconnect}）`, async () => {
    const { manager, rooms, sources, state } = fixture();
    await manager.start();
    const waiting = {
      ...state,
      version: state.version + 1,
      speechId: "silent-vote",
      nodeId: "s1_voting1_wait",
      acceptsPatientInput: false
    };
    if (reconnect) {
      sources[0].callbacks.onConnectionChange(false);
      sources[0].callbacks.onConnectionChange(true, { state: waiting, openingSegments: [] });
    } else {
      sources[0].callbacks.onState(waiting, { replace: true });
    }
    await tick();
    assert.equal(rooms[0].commands.at(-1).event_type, "avatar.interrupt");
    assert.equal(rooms[0].mic.includes(true), false);
    const commandCount = rooms[0].commands.length;
    sources[0].callbacks.onConnectionChange(false);
    sources[0].callbacks.onConnectionChange(true, { state: waiting, openingSegments: [] });
    await tick();
    assert.equal(rooms[0].commands.length, commandCount, "受信済みの無言操作を再実行しない");
  });
}

test("接続後は復帰先の台詞を読み、初期化中にはマイクを開かない", async () => {
  const { manager, rooms } = fixture();
  await manager.start();
  assert.equal(manager.isStarted(), true);
  assert.deepEqual(
    rooms[0].commands.map((e) => e.text),
    ["途中の質問です。"]
  );
  assert.deepEqual(rooms[0].mic, []);
  const source = rooms[0].commands[0].event_id;
  const send = (event) =>
    rooms[0].callbacks.onDataReceived(
      new TextEncoder().encode(JSON.stringify(event)),
      null,
      null,
      "agent-response"
    );
  send({ event_type: "avatar.speak_started", source_event_id: source });
  send({ event_type: "avatar.speak_ended", source_event_id: source });
  await tick();
  assert.deepEqual(rooms[0].mic, [true]);
});

test("切断で旧SSEを閉じ、旧部屋の遅延イベントは再接続を破壊しない", async () => {
  const { manager, rooms, sources, disconnected } = fixture();
  await manager.start();
  rooms[0].callbacks.onDisconnected("network");
  assert.equal(sources[0].closed, true);
  assert.equal(manager.getSessionId(), null);
  await manager.start();
  assert.equal(manager.getSessionId(), "session-2");
  rooms[0].callbacks.onDisconnected("late");
  sources[0].callbacks.onSpeechSegment({ replace: true, speechText: "古い操作です。" });
  await tick();
  assert.equal(manager.getSessionId(), "session-2");
  assert.equal(manager.isStarted(), true);
  assert.deepEqual(disconnected, ["network"]);
  assert.equal(
    rooms[1].commands.some((e) => e.text === "古い操作です。"),
    false
  );
});

test("トークン発行中のStop後も、遅れて返ったトークンを停止する", async () => {
  let completeToken;
  const { manager, stopped } = fixture({
    createLiveAvatarSessionToken: () =>
      new Promise((resolve) => {
        completeToken = resolve;
      })
  });
  const starting = manager.start({ skipMicrophonePreflight: true });
  await tick();
  await manager.stop();
  completeToken({ session_token: "late-token", session_id: "late-session" });
  await assert.rejects(starting);
  await tick();
  assert.deepEqual(stopped, ["late-token"]);
  assert.equal(manager.getSessionId(), null);
});

test("SSEが切れたら入力を停止し、復帰時には現在の台詞で追いつく", async () => {
  const { manager, rooms, sources } = fixture();
  await manager.start();
  sources[0].callbacks.onConnectionChange(false);
  sources[0].callbacks.onConnectionChange(true, {
    state: { version: 6, nodeId: "s1_voting1_wait", acceptsPatientInput: false },
    openingSegments: [{ speechText: "投票へ進みます。" }]
  });
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal(rooms[0].commands.at(-1).text, "投票へ進みます。");
  assert.equal(rooms[0].mic.includes(true), false);
});

test("起動準備中にSSEが切れても、発話終了後にマイクを開かない", async () => {
  const { manager, api, rooms, sources, state } = fixture();
  const connect = api.connectLiveKitRoom;
  let audioReady;
  api.connectLiveKitRoom = (callbacks) =>
    connect({
      ...callbacks,
      attachTrack: (...args) => {
        audioReady = () => callbacks.attachTrack(...args);
      }
    });
  const starting = manager.start();
  await tick();
  sources[0].callbacks.onConnectionChange(false);
  audioReady();
  await starting;
  for (const event_type of ["avatar.speak_started", "avatar.speak_ended"]) {
    rooms[0].callbacks.onDataReceived(
      new TextEncoder().encode(
        JSON.stringify({
          event_type,
          source_event_id: rooms[0].commands[0].event_id
        })
      ),
      null,
      null,
      "agent-response"
    );
  }
  await tick();
  assert.deepEqual(rooms[0].mic, []);
  sources[0].callbacks.onConnectionChange(true, { state, openingSegments: [] });
  await tick();
  assert.deepEqual(rooms[0].mic, [true]);
});

test("起動準備中のSSE再接続では、切断前のキューより復帰時の台詞を優先する", async () => {
  const { manager, api, rooms, sources, state } = fixture();
  const connect = api.connectLiveKitRoom;
  let audioReady;
  api.connectLiveKitRoom = (callbacks) =>
    connect({
      ...callbacks,
      attachTrack: (...args) => {
        audioReady = () => callbacks.attachTrack(...args);
      }
    });
  const starting = manager.start();
  await tick();
  sources[0].callbacks.onSpeechSegment({
    replace: true,
    state: { ...state, version: 5 },
    speechText: "切断前の古い台詞です。"
  });
  sources[0].callbacks.onConnectionChange(false);
  sources[0].callbacks.onConnectionChange(true, {
    state: { ...state, version: 6 },
    openingSegments: [{ speechText: "復帰時の台詞です。" }]
  });
  audioReady();
  await starting;
  assert.deepEqual(
    rooms[0].commands.map((event) => event.text),
    ["復帰時の台詞です。"]
  );
});

test("マイクの許可待ちでもStopで起動を中断できる", async () => {
  const { manager, stopped } = fixture({ ensureMicrophoneAccess: () => new Promise(() => {}) });
  const starting = manager.start();
  await tick();
  await manager.stop();
  await assert.rejects(starting);
  assert.equal(manager.getSessionId(), null);
  assert.deepEqual(stopped, []);
});

function finishSpeech(room) {
  const speech = room.commands.filter((event) => event.event_type === "avatar.speak_text").at(-1);
  for (const event_type of ["avatar.speak_started", "avatar.speak_ended"]) {
    room.callbacks.onDataReceived(
      new TextEncoder().encode(JSON.stringify({ event_type, source_event_id: speech.event_id })),
      null,
      null,
      "agent-response"
    );
  }
}

test("同じ進行番号で再接続しても、一部だけ受信した台詞を全体で回収する", async () => {
  const { manager, rooms, sources, state } = fixture();
  await manager.start();
  const room = rooms[0];
  finishSpeech(room);
  await tick();
  const next = { ...state, version: 5, speechId: "next-speech" };
  const openingSegments = ["説明の一文目です。", "重要な二文目です。"].map(
    (speechText, segmentIndex) => ({
      speechText,
      state: next,
      speechId: next.speechId,
      segmentIndex,
      segmentCount: 2,
      replace: segmentIndex === 0
    })
  );
  sources[0].callbacks.onSpeechSegment(openingSegments[0]);
  await tick();
  assert.equal(
    room.commands.some((event) => event.text === openingSegments[0].speechText),
    false
  );
  assert.equal(room.mic.at(-1), false);
  sources[0].callbacks.onConnectionChange(false);
  sources[0].callbacks.onConnectionChange(true, { state: next, openingSegments });
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal(room.commands.at(-1).text, openingSegments[0].speechText);
  finishSpeech(room);
  await tick();
  assert.equal(room.commands.at(-1).text, openingSegments[1].speechText);
  assert.equal(room.mic.at(-1), false);
  finishSpeech(room);
  await tick();
  assert.equal(room.mic.at(-1), true);
  const spoken = room.commands.length;
  sources[0].callbacks.onConnectionChange(false);
  sources[0].callbacks.onConnectionChange(true, { state: next, openingSegments });
  await tick();
  assert.equal(room.commands.length, spoken, "受信済みの台詞は再接続だけで重複再生しない");
});

test("サーバー世代が変われば低い進行番号で同期し、操作係のジャンプから復帰する", async () => {
  const { manager, rooms, sources, state } = fixture();
  await manager.start();
  const room = rooms[0];
  finishSpeech(room);
  await tick();
  sources[0].callbacks.onConnectionChange(false);
  const resetState = {
    ...state,
    epoch: "restarted-server",
    version: 0,
    inputPaused: true,
    recoveryRequired: true,
    acceptsPatientInput: false,
    speechId: "recovery"
  };
  sources[0].callbacks.onConnectionChange(true, { state: resetState, openingSegments: [] });
  await tick();
  assert.equal(room.mic.at(-1), false);
  sources[0].callbacks.onSpeechSegment({
    state,
    speechText: "旧サーバーの遅着です。",
    replace: true
  });
  const jumped = {
    ...resetState,
    version: 1,
    inputPaused: false,
    recoveryRequired: false,
    acceptsPatientInput: true,
    speechId: "jumped"
  };
  sources[0].callbacks.onSpeechSegment({
    state: jumped,
    speechId: "jumped",
    segmentIndex: 0,
    segmentCount: 1,
    speechText: "中断位置の質問です。",
    replace: true
  });
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal(room.commands.at(-1).text, "中断位置の質問です。");
  assert.equal(
    room.commands.some((event) => event.text === "旧サーバーの遅着です。"),
    false
  );
  finishSpeech(room);
  await tick();
  assert.equal(room.mic.at(-1), true);
});

test("起動準備中にサーバーが再起動しても、同じversionの旧挨拶を再生しない", async () => {
  const { manager, api, rooms, sources, state } = fixture();
  state.version = 0;
  const connect = api.connectLiveKitRoom;
  let audioReady;
  api.connectLiveKitRoom = (callbacks) =>
    connect({
      ...callbacks,
      attachTrack: (...args) => {
        audioReady = () => callbacks.attachTrack(...args);
      }
    });
  const starting = manager.start();
  await tick();
  sources[0].callbacks.onConnectionChange(false);
  sources[0].callbacks.onConnectionChange(true, {
    state: {
      ...state,
      epoch: "restarted-server",
      speechId: "recovery",
      inputPaused: true,
      recoveryRequired: true,
      acceptsPatientInput: false
    },
    openingSegments: []
  });
  audioReady();
  await starting;
  assert.equal(
    rooms[0].commands.some((event) => event.event_type === "avatar.speak_text"),
    false
  );
  assert.equal(rooms[0].mic.includes(true), false);
});

test("15分の投票待ちでも入力を閉じて接続維持を続け、一時失敗後も再試行する", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const keptAlive = [];
  const { manager, rooms, state } = fixture({
    keepLiveAvatarSessionAlive: async (sessionId) => {
      keptAlive.push(sessionId);
      if (keptAlive.length === 1) throw new Error("temporary network failure");
    }
  });
  state.nodeId = "s2_voting2_wait";
  state.acceptsPatientInput = false;
  const starting = manager.start();
  await tick();
  t.mock.timers.tick(400);
  await starting;
  finishSpeech(rooms[0]);
  await tick();

  for (let minute = 1; minute <= 15; minute += 1) {
    t.mock.timers.tick(60_000);
    await tick();
    assert.equal(keptAlive.length, minute);
    assert.equal(manager.isStarted(), true);
    assert.equal(rooms[0].mic.includes(true), false);
  }
  assert.deepEqual(keptAlive, Array(15).fill("session-1"));
  assert.equal(rooms[0].commands.length, 1, "投票待ちの間に台詞を勝手に再生しない");

  await manager.stop();
  t.mock.timers.tick(120_000);
  await tick();
  assert.equal(keptAlive.length, 15, "停止後は接続維持要求を送らない");
});

test("接続維持の応答待ちで切断・再接続しても、旧セッションの更新を再開しない", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const requests = [];
  let finishOldRequest;
  const { manager, rooms, state } = fixture({
    keepLiveAvatarSessionAlive: async (sessionId, { signal }) => {
      requests.push({ sessionId, signal });
      if (sessionId === "session-1")
        await new Promise((resolve) => {
          finishOldRequest = resolve;
        });
    }
  });
  state.nodeId = "s1_voting1_wait";
  state.acceptsPatientInput = false;
  const starting = manager.start();
  await tick();
  t.mock.timers.tick(400);
  await starting;
  finishSpeech(rooms[0]);
  await tick();
  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(requests.length, 1);

  rooms[0].callbacks.onDisconnected("network");
  assert.equal(requests[0].signal.aborted, true);
  const restarting = manager.start();
  await tick();
  t.mock.timers.tick(400);
  await restarting;
  finishSpeech(rooms[1]);
  finishOldRequest();
  await tick();
  t.mock.timers.tick(60_000);
  await tick();
  assert.deepEqual(
    requests.map((request) => request.sessionId),
    ["session-1", "session-2"]
  );
  assert.equal(manager.getSessionId(), "session-2");
  assert.equal(rooms[1].mic.includes(true), false);
  await manager.stop();
});
