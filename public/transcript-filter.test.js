import test from "node:test";
import assert from "node:assert/strict";
import { isSubstantiveTranscript } from "./transcript-filter.js";

test("句読点・記号だけの断片は発話として扱わない", () => {
  assert.equal(isSubstantiveTranscript("。"), false);
  assert.equal(isSubstantiveTranscript("、"), false);
  assert.equal(isSubstantiveTranscript("？"), false);
  assert.equal(isSubstantiveTranscript("..."), false);
  assert.equal(isSubstantiveTranscript("ー"), false);
  assert.equal(isSubstantiveTranscript("  "), false);
  assert.equal(isSubstantiveTranscript(""), false);
});

test("意味を持たない一音だけの断片は発話として扱わない", () => {
  assert.equal(isSubstantiveTranscript("あ"), false);
  assert.equal(isSubstantiveTranscript("あー"), false);
  assert.equal(isSubstantiveTranscript("ん。"), false);
  assert.equal(isSubstantiveTranscript("えー、"), false);
});

test("正規の短い返答は必ず通す", () => {
  assert.equal(isSubstantiveTranscript("はい"), true);
  assert.equal(isSubstantiveTranscript("うん"), true);
  assert.equal(isSubstantiveTranscript("ない"), true);
  assert.equal(isSubstantiveTranscript("いいえ"), true);
  assert.equal(isSubstantiveTranscript("特に"), true);
  assert.equal(isSubstantiveTranscript("はい。"), true);
});

test("通常の発話は通す", () => {
  assert.equal(isSubstantiveTranscript("階段や坂道では少し息が切れることがあります。"), true);
  assert.equal(isSubstantiveTranscript("1日40本を52年です"), true);
});
