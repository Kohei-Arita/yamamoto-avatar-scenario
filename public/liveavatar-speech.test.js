import test from "node:test";
import assert from "node:assert/strict";

import { isAvatarSpeechEndEvent, normalizeSpeechText } from "./liveavatar-speech.js";

test("normalizeSpeechText collapses whitespace", () => {
  assert.equal(normalizeSpeechText("  肺がん \n ガイドライン  "), "肺がん ガイドライン");
});

test("isAvatarSpeechEndEvent matches multiple end-event variants", () => {
  assert.equal(isAvatarSpeechEndEvent({ event_type: "avatar.speak_ended" }), true);
  assert.equal(isAvatarSpeechEndEvent({ type: "AVATAR_STOP_TALKING" }), true);
  assert.equal(isAvatarSpeechEndEvent({ type: "AVATAR_END_MESSAGE" }), true);
  assert.equal(isAvatarSpeechEndEvent({ event_type: "session.stopped" }), false);
  assert.equal(isAvatarSpeechEndEvent({ event_type: "user.speak_ended" }), false);
});
