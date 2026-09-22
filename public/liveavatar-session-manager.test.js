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
  const state = { version: 4, nodeId: "s1_adl", acceptsPatientInput: true };
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
