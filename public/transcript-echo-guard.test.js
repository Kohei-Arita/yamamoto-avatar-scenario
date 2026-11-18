import test from "node:test";
import assert from "node:assert/strict";
import { createEchoGuard } from "./transcript-echo-guard.js";

const AVATAR_LINE =
  "画像では、右下葉に約40mmの不整形な結節を認めます。PET-CTでは集積が強く、悪性腫瘍を疑う所見です。";

test("アバター発話とほぼ同一の文字起こしはエコーと判定する", () => {
  const guard = createEchoGuard();
  guard.rememberAvatarSpeech(AVATAR_LINE);

  assert.equal(guard.isLikelyEcho(AVATAR_LINE), true);
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

test("挨拶の返礼と、質問に含まれる選択肢の復唱を捨てない", () => {
  const guard = createEchoGuard();
  guard.rememberAvatarSpeech("こんにちは。山本です。本日はよろしくお願いします。");
  guard.rememberAvatarSpeech(
    "治療効果、副作用、入院、仕事や生活への影響など、何を一番重視されますか。"
  );
  guard.rememberAvatarSpeech("入院や在宅酸素が必要になったことはありますか。");
  for (const text of [
    "よろしくお願いします",
    "はい、よろしくお願いします。",
    "仕事や生活への影響",
    "入院や在宅酸素"
  ]) {
    assert.equal(guard.isLikelyEcho(text), false, text);
  }
});

test("別々の文の語句を組み合わせた患者の返答をエコーにしない", () => {
  const guard = createEchoGuard();
  guard.rememberAvatarSpeech("仕事や生活への影響を確認します。");
  guard.rememberAvatarSpeech("ご希望を大切にして考えます。");
  assert.equal(guard.isLikelyEcho("仕事や生活への影響を大切にして考えます"), false);
});
