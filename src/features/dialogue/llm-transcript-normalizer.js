function extractRecentContext(historyMessages = []) {
  return historyMessages
    .slice(-4)
    .map((message) => `${message.role || "user"}: ${String(message.content || "").trim()}`)
    .filter((line) => !/^(user|assistant):\s*$/u.test(line))
    .join("\n");
}

export function buildMedicalTranscriptNormalizationMessages(
  rawText,
  { candidateText = "", historyMessages = [] } = {}
) {
  const context = extractRecentContext(historyMessages);

  return [
    {
      role: "system",
      content: [
        "あなたは肺がん診療の会話に特化した日本語の医療音声認識補正器です。",
        "役割は、患者発話の音声認識テキストを、肺がん関連の医学用語として最も自然な表現に補正することだけです。",
        "質問への回答は禁止です。",
        "新しい症状、病期、薬剤名、判断は足さないでください。",
        "確信が低い語は無理に直さず、そのまま残してください。",
        "文全体を書き換えず、必要最小限の語句修正に留めてください。",
        '出力は JSON のみとし、形式は {"normalizedText":"..."} に厳密に従ってください。'
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "以下の音声認識テキストを補正してください。漢字にすべきところは漢字で補正してください。",
        context ? `最近の会話文脈:\n${context}` : "最近の会話文脈:\nなし",
        `音声認識原文:\n${String(rawText || "").trim()}`,
        `ルールベース補正候補:\n${String(candidateText || "").trim() || "なし"}`,
        "",
        "補正の重点:",
        "- 肺癌、非小細胞肺癌、小細胞肺癌,肺尖部胸壁浸潤癌,脳転移,肺末梢小型病変,前浸潤性病変,中枢気道,癌性心膜炎,悪液質,臨床病期,勧められる",
        "- 放射線治療、予防的全脳照射、PCI、線量,仮想気管支鏡ナビゲーション,自家蛍光（autofluorescence）観察/狭帯域光観察,",
        "- 手術、化学療法、免疫療法、分子標的治療、ダブラフェニブ、トラメチ二ブ、セルペカチニブ、ソトラシブ、タルラタナブ、ラムシルマブ、ドセタキセル、アテゾリズマブ、シスプラチン、カルボプラチン",
        "- EGFR、ALK、ROS1、KRAS、BRAF、MET、RET、HER2、PD-L1",
        "- M因子、T因子、N因子",
        "- 肺門部肺癌, プラチナ製剤、経皮的針生検,光線力学的治療法（PDT）,テガフール・ウラシル配合剤療法,包括的がんゲノムプロファイリング（CGP）,ラジアル型EBUS,コンベックス型EBUS-TBNA,クライオ生検,選択的グレリン受容体刺激薬",
        "",
        "JSON のみを返してください。"
      ].join("\n")
    }
  ];
}

function extractJsonObject(text = "") {
  const trimmed = String(text || "").trim();

  if (!trimmed) {
    return "";
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);

  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

export function parseMedicalTranscriptNormalizationResponse(content, fallbackText = "") {
  const jsonText = extractJsonObject(content);

  if (!jsonText) {
    return String(fallbackText || "").trim();
  }

  try {
    const parsed = JSON.parse(jsonText);
    const normalizedText = String(parsed?.normalizedText || "").trim();

    return normalizedText || String(fallbackText || "").trim();
  } catch {
    return String(fallbackText || "").trim();
  }
}

export function applyLlmTranscriptNormalization(transcript, normalizedText, model = "") {
  const nextText = String(normalizedText || "").trim();
  const previousText = String(transcript?.normalizedText || "").trim();

  if (!nextText || nextText === previousText) {
    return {
      ...transcript,
      llmNormalization: {
        attempted: true,
        changed: false,
        model
      }
    };
  }

  return {
    ...transcript,
    normalizedText: nextText,
    repairs: [
      ...(Array.isArray(transcript?.repairs) ? transcript.repairs : []),
      {
        type: "llm_medical_term_normalization",
        before: previousText,
        after: nextText
      }
    ],
    changed: nextText !== String(transcript?.rawText || "").trim(),
    llmNormalization: {
      attempted: true,
      changed: true,
      model
    }
  };
}
