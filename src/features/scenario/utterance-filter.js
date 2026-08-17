// 音声認識が無音区間や発話の切れ目で出力する「句読点だけ」「相槌未満の一音だけ」の
// 断片を、患者発話として扱わないためのフィルタ。
// これを通してしまうと patient_any ノードが素通しされ、台本が勝手に進む。
//
// 「はい」「うん」「ない」などの正規の短答は必ず通すこと。

const PUNCTUATION_AND_SYMBOLS_PATTERN =
  /[\s、。，．・…‥！？!?,.「」『』（）()［\]【】〈〉《》〜~ー―‐-]/gu;

// 単独では意味を持たない母音・撥音・促音(「あ」「んー」など)
const NON_LEXICAL_SINGLE_CHAR_PATTERN = /^[ぁあぃいぅうぇえぉおっんァアィイゥウェエォオッン]$/u;

export function stripNonLexicalCharacters(text = "") {
  return String(text || "")
    .normalize("NFKC")
    .replace(PUNCTUATION_AND_SYMBOLS_PATTERN, "")
    .trim();
}

export function isSubstantiveUtterance(text = "") {
  const stripped = stripNonLexicalCharacters(text);

  if (!stripped) {
    return false;
  }

  if (NON_LEXICAL_SINGLE_CHAR_PATTERN.test(stripped)) {
    return false;
  }

  return true;
}
