import test from "node:test";
import assert from "node:assert/strict";

import {
  extractAvatarSubtitleText,
  isAvatarSubtitleEndEvent,
  normalizeSubtitleText
} from "./liveavatar-subtitles.js";

test("normalizeSubtitleText collapses whitespace", () => {
  assert.equal(normalizeSubtitleText("  肺がん \n ガイドライン  "), "肺がん ガイドライン");
});

test("extractAvatarSubtitleText reads avatar transcription payloads", () => {
  assert.equal(
    extractAvatarSubtitleText({
      event_type: "avatar.transcription",
      text: "  こちらが \n 字幕です "
    }),
    "こちらが 字幕です"
  );
});

test("extractAvatarSubtitleText accepts AVATAR_TALKING_MESSAGE style payloads", () => {
  assert.equal(
    extractAvatarSubtitleText({
      type: "AVATAR_TALKING_MESSAGE",
      data: {
        message: "現在話している内容"
      }
    }),
    "現在話している内容"
  );
});

test("extractAvatarSubtitleText ignores user transcription payloads", () => {
  assert.equal(
    extractAvatarSubtitleText({
      event_type: "user.transcription",
      text: "ユーザー発話"
    }),
    ""
  );
});

test("isAvatarSubtitleEndEvent matches multiple end-event variants", () => {
  assert.equal(isAvatarSubtitleEndEvent({ event_type: "avatar.speak_ended" }), true);
  assert.equal(isAvatarSubtitleEndEvent({ type: "AVATAR_STOP_TALKING" }), true);
  assert.equal(isAvatarSubtitleEndEvent({ type: "AVATAR_END_MESSAGE" }), true);
  assert.equal(isAvatarSubtitleEndEvent({ event_type: "session.stopped" }), false);
});
