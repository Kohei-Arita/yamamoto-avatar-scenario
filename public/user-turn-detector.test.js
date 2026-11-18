import assert from "node:assert/strict";
import test from "node:test";
import { createUserTurnDetector } from "./user-turn-detector.js";

function fixture(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const ended = [];
  let localSpeaking = false;
  const detector = createUserTurnDetector({
    getLocalSpeaking: () => localSpeaking,
    onEnd: (details) => ended.push(details)
  });
  t.after(() => detector.reset());
  return {
    detector,
    ended,
    tick: (ms) => t.mock.timers.tick(ms),
    local: (speaking) => {
      localSpeaking = speaking;
      detector.localSpeechChanged();
    }
  };
}

test("LiveKitが無音扱いでもLiveAvatarの発話終了まで待ち、その後1.2秒の静かな状態を確認する", (t) => {
  const { detector, ended, tick } = fixture(t);
  detector.remoteSpeechChanged(true);
  detector.transcriptReceived();
  tick(2500);
  detector.transcriptReceived();
  tick(2500);
  assert.deepEqual(ended, []);
  detector.remoteSpeechChanged(false);
  tick(1199);
  assert.deepEqual(ended, []);
  tick(1);
  assert.equal(ended[0].reason, "silence");
  assert.equal(ended[0].quietMs, 1200);
});

test("発話中フラグが200msだけfalseになっても受付を確定しない", (t) => {
  const { detector, ended, tick, local } = fixture(t);
  local(true);
  detector.transcriptReceived();
  tick(2000);
  local(false);
  tick(200);
  local(true);
  tick(2000);
  assert.deepEqual(ended, []);
  local(false);
  tick(1199);
  assert.deepEqual(ended, []);
  tick(1);
  assert.equal(ended.length, 1);
});

test("発話終了通知の後に遅れて届いた文字起こしも1.2秒待ってから確定する", (t) => {
  const { detector, ended, tick } = fixture(t);
  detector.remoteSpeechChanged(true);
  tick(1000);
  detector.remoteSpeechChanged(false);
  tick(1000);
  detector.transcriptReceived();
  tick(1199);
  assert.deepEqual(ended, []);
  tick(1);
  assert.equal(ended[0].lastTranscriptAgeMs, 1200);
});

test("連続した文字起こしや重複した開始通知で30秒の受付期限を延長しない", (t) => {
  const { detector, ended, tick } = fixture(t);
  detector.remoteSpeechChanged(true);
  for (let second = 0; second < 29; second++) {
    tick(1000);
    detector.remoteSpeechChanged(true);
    detector.transcriptReceived();
  }
  tick(999);
  assert.deepEqual(ended, []);
  tick(1);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, "max_duration");
  assert.equal(ended[0].durationMs, 30_000);
});

test("文字起こしがない連続音声も30秒で終了し、無音待機中には期限を設けない", (t) => {
  const { detector, ended, tick, local } = fixture(t);
  tick(60_000);
  assert.deepEqual(ended, []);
  local(true);
  tick(30_000);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].lastTranscriptAgeMs, null);
  assert.equal(ended[0].reason, "max_duration");
  detector.reset();
  tick(60_000);
  assert.equal(ended.length, 1);
});

test("タイマーが遅延しても期限切れを入力時に判定できる", (t) => {
  const { detector, ended } = fixture(t);
  detector.remoteSpeechChanged(true);
  t.mock.timers.setTime(Date.now() + 30_001);
  assert.equal(detector.expireIfNeeded(), true);
  assert.equal(ended.length, 1);
  assert.equal(detector.expireIfNeeded(), false);
});

test("停止・再開後は以前の発話フラグと期限を引き継がない", (t) => {
  const { detector, ended, tick } = fixture(t);
  detector.remoteSpeechChanged(true);
  tick(29_000);
  detector.reset();
  tick(2000);
  assert.deepEqual(ended, []);
  detector.transcriptReceived();
  tick(1200);
  assert.equal(ended[0].reason, "silence");
  assert.equal(ended[0].durationMs, 1200);
});
