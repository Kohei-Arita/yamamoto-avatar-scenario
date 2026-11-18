// SSEの一文目だけで受信済み扱いにしない。全件が揃うまで発話も入力受付もしない。
export function createSpeechBatchBuffer() {
  let pending = null;
  return {
    clear() {
      pending = null;
    },
    get incomplete() {
      return Boolean(pending);
    },
    add(segment) {
      if (!segment.speechId) return [segment]; // 旧形式との互換。現行サーバーは必ずIDを付ける。
      const { speechId, segmentIndex, segmentCount } = segment;
      if (
        !Number.isInteger(segmentCount) ||
        segmentCount < 1 ||
        segmentCount > 200 ||
        !Number.isInteger(segmentIndex) ||
        segmentIndex < 0 ||
        segmentIndex >= segmentCount
      ) {
        throw new Error("台詞の受信情報が不正です。再接続してください。");
      }
      if (!pending || pending.id !== speechId)
        pending = { id: speechId, count: segmentCount, segments: new Map() };
      if (pending.count !== segmentCount) throw new Error("台詞の受信件数が一致しません。");
      pending.segments.set(segmentIndex, segment);
      if (pending.segments.size !== pending.count) return null;
      const batch = Array.from({ length: pending.count }, (_, index) => ({
        ...pending.segments.get(index),
        replace: index === 0
      }));
      pending = null;
      return batch;
    }
  };
}
