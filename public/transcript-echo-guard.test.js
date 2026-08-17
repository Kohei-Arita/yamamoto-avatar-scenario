import test from "node:test";
import assert from "node:assert/strict";
import { createEchoGuard } from "./transcript-echo-guard.js";

const AVATAR_LINE =
  "画像では、右下葉に約40mmの不整形な結節を認めます。PET-CTでは集積が強く、悪性腫瘍を疑う所見です。";

test("アバター発話とほぼ同一の文字起こしはエコーと判定する", () => {
  const guard = createEchoGuard();
  guard.rememberAvatarSpeech(AVATAR_LINE);

  assert.equal(guard.isLikelyEcho("画像では右下葉に約40mmの不整形な結節を認めます"), true);
  assert.equal(guard.isLikelyEcho("PET-CTでは集積が強く悪性腫瘍を疑う所見です。"), true);
});

test("句読点・空白・表記ゆれがあってもエコーと判定する", () => {
  const guard = createEchoGuard();
  guard.rememberAvatarSpeech(
    "現在、咳、痰、血痰、息切れ、胸の痛み、発熱、体重減少などはありますか。"
  );

  assert.equal(
    guard.isLikelyEcho("現在 咳 痰 血痰 息切れ 胸の痛み 発熱 体重減少などはありますか"),
    true
  );
});

test("患者の通常の返答はエコーと判定しない", () => {
  const guard = createEchoGuard();
  guard.rememberAvatarSpeech(AVATAR_LINE);
  guard.rememberAvatarSpeech("たばこは、1日にどのくらい、何年くらい吸われていますか。");

  assert.equal(guard.isLikelyEcho("特にありません"), false);
  assert.equal(guard.isLikelyEcho("1日40本を52年くらい吸っています"), false);
  assert.equal(guard.isLikelyEcho("手術で取れば治るのでしょうか"), false);
});

test("短い発話(はい・いいえ等)はエコー判定の対象外", () => {
  const guard = createEchoGuard();
  guard.rememberAvatarSpeech(AVATAR_LINE);

  assert.equal(guard.isLikelyEcho("はい"), false);
  assert.equal(guard.isLikelyEcho("います"), false);
});

test("TTLを過ぎた発話はエコー判定に使われない", () => {
  let currentTime = 1_000;
  const guard = createEchoGuard({ ttlMs: 5_000, now: () => currentTime });

  guard.rememberAvatarSpeech(AVATAR_LINE);
  currentTime = 7_000;

  assert.equal(guard.isLikelyEcho("画像では右下葉に約40mmの不整形な結節を認めます"), false);
});

test("resetで記憶を消去できる", () => {
  const guard = createEchoGuard();
  guard.rememberAvatarSpeech(AVATAR_LINE);
  guard.reset();

  assert.equal(guard.isLikelyEcho("画像では右下葉に約40mmの不整形な結節を認めます"), false);
});
