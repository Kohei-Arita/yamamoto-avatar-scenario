import assert from "node:assert/strict";
import test from "node:test";
import { createSpeechBatchBuffer } from "./speech-batch.js";

test("全セグメントが揃うまで保留し、重複を数えず番号順で渡す", () => {
  const buffer = createSpeechBatchBuffer();
  const segment = (index) => ({
    speechId: "batch",
    segmentIndex: index,
    segmentCount: 2,
    speechText: `文${index}`
  });
  assert.equal(buffer.add(segment(1)), null);
  assert.equal(buffer.add(segment(1)), null);
  assert.equal(buffer.incomplete, true);
  const batch = buffer.add(segment(0));
  assert.deepEqual(
    batch.map((part) => part.speechText),
    ["文0", "文1"]
  );
  assert.equal(batch[0].replace, true);
  assert.equal(batch[1].replace, false);
  assert.equal(buffer.incomplete, false);
});

test("新しい台詞で未完了の古い台詞を置き換え、不正な件数を拒否する", () => {
  const buffer = createSpeechBatchBuffer();
  buffer.add({ speechId: "old", segmentCount: 2, segmentIndex: 0 });
  const batch = buffer.add({ speechId: "new", segmentCount: 1, segmentIndex: 0 });
  assert.equal(batch.length, 1);
  assert.equal(batch[0].speechId, "new");
  assert.throws(() => buffer.add({ speechId: "bad", segmentCount: 1_000_000, segmentIndex: 0 }));
});
