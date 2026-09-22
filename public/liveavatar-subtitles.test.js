import test from "node:test";
import assert from "node:assert/strict";

import { isAvatarSubtitleEndEvent, normalizeSubtitleText } from "./liveavatar-subtitles.js";

test("normalizeSubtitleText collapses whitespace", () => {
  assert.equal(normalizeSubtitleText("  肺がん \n ガイドライン  "), "肺がん ガイドライン");
});

test("isAvatarSubtitleEndEvent matches multiple end-event variants", () => {
  assert.equal(isAvatarSubtitleEndEvent({ event_type: "avatar.speak_ended" }), true);
  assert.equal(isAvatarSubtitleEndEvent({ type: "AVATAR_STOP_TALKING" }), true);
  assert.equal(isAvatarSubtitleEndEvent({ type: "AVATAR_END_MESSAGE" }), true);
  assert.equal(isAvatarSubtitleEndEvent({ event_type: "session.stopped" }), false);
  assert.equal(isAvatarSubtitleEndEvent({ event_type: "user.speak_ended" }), false);
});
