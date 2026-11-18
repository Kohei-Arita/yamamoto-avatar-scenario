// 音声認識が無音区間や発話の切れ目で出力する「句読点だけ」「相槌未満の一音だけ」の
// 断片を、患者発話として扱わないためのフィルタ（サーバー側 utterance-filter.js と同じ判定）。
//
// ブラウザ側で弾く理由:
//   1. 台本が勝手に進むのを防ぐ（サーバー側でも二重に防御している）
//   2. アバター発話中にこの断片が届くと割り込み扱いになり、発話が中断されてしまう
//
// 「はい」「うん」「ない」などの正規の短答は必ず通すこと。

const PUNCTUATION_AND_SYMBOLS_PATTERN =
  /[\s、。，．・…‥！？!?,.「」『』（）()［\]【】〈〉《》〜~ー―‐-]/gu;

const NON_LEXICAL_SINGLE_CHAR_PATTERN = /^[ぁあぃいぅうぇえぉおっんァアィイゥウェエォオッン]$/u;

export function isSubstantiveTranscript(text = "") {
  const stripped = String(text || "")
    .normalize("NFKC")
    .replace(PUNCTUATION_AND_SYMBOLS_PATTERN, "")
    .trim();

  if (!stripped) {
    return false;
  }

  return !NON_LEXICAL_SINGLE_CHAR_PATTERN.test(stripped);
}
