const WHOLE_BRAIN_IRRADIATION_VARIANTS = "(消者|しょうしゃ|照射)";
const PREVENTIVE_WHOLE_BRAIN_IRRADIATION_PATTERN = new RegExp(
  `予防的全[能脳]${WHOLE_BRAIN_IRRADIATION_VARIANTS}|全[能脳]${WHOLE_BRAIN_IRRADIATION_VARIANTS}`,
  "u"
);
const PREVENTIVE_WHOLE_BRAIN_IRRADIATION_GLOBAL_PATTERN = new RegExp(
  `予防的全[能脳]${WHOLE_BRAIN_IRRADIATION_VARIANTS}`,
  "gu"
);
const WHOLE_BRAIN_IRRADIATION_GLOBAL_PATTERN = new RegExp(
  `(?<!予防的)全[能脳]${WHOLE_BRAIN_IRRADIATION_VARIANTS}`,
  "gu"
);
const LUNG_CANCER_HOMOPHONE_FOLLOWING_PATTERN =
  "(について|とは|って|の|は|を|に|で|が|治療|診断|ガイドライン|教えて|知りたい|ですか)";
const LUNG_CANCER_HOMOPHONE_PATTERN = new RegExp(
  `(対岸|たいがん)(?=${LUNG_CANCER_HOMOPHONE_FOLLOWING_PATTERN})`,
  "u"
);
const LUNG_CANCER_HOMOPHONE_GLOBAL_PATTERN = new RegExp(
  `(対岸|たいがん)(?=${LUNG_CANCER_HOMOPHONE_FOLLOWING_PATTERN})`,
  "gu"
);

function hasSymptomContext(historyMessages = []) {
  const contextText = historyMessages
    .slice(-4)
    .map((message) => String(message?.content || ""))
    .join(" ");

  return /咳|せき|痰|たん|息切れ|発熱|胸痛/u.test(contextText);
}

export function normalizeMedicalTranscript(rawText, { historyMessages = [] } = {}) {
  let normalizedText = String(rawText || "").trim();
  const repairs = [];
  const symptomContext = hasSymptomContext(historyMessages);

  const rules = [
    {
      name: "breathlessness_homophone",
      test: /(行き|生き|息)切れ/u,
      apply: (text) => text.replace(/(行き|生き)切れ/gu, "息切れ")
    },
    {
      name: "high_risk_group_homophone",
      test: /ハイリスク分/u,
      apply: (text) => text.replace(/ハイリスク分/gu, "ハイリスク群")
    },
    {
      name: "hilar_lung_homophone",
      test: /背門部/u,
      apply: (text) => text.replace(/背門部/gu, "肺門部")
    },
    {
      name: "lung_cancer_homophone",
      test: LUNG_CANCER_HOMOPHONE_PATTERN,
      apply: (text) => text.replace(LUNG_CANCER_HOMOPHONE_GLOBAL_PATTERN, "肺がん")
    },
    {
      name: "cough_homophone",
      test: /席が?(出|続|止|とま|ひど|つら)/u,
      apply: (text) => text.replace(/席(?=が?(出|続|止|とま|ひど|つら))/gu, "咳")
    },
    {
      name: "sputum_phrase",
      test: /(漫画|まんが)(から|がら)(みます|みま|みる|み|んです)|((漫画|まんが)から見ます)/u,
      apply: (text) =>
        text.replace(
          /(漫画|まんが)(から|がら)(みます|みま|みる|み|んです)|((漫画|まんが)から見ます)/gu,
          "痰が絡みます"
        )
    },
    {
      name: "first_line_homophone",
      test: /(一日|1日)(?=治療)/u,
      apply: (text) => text.replace(/(一日|1日)(?=治療)/gu, "一次")
    },
    {
      name: "pci_whole_brain_irradiation_homophone",
      test: PREVENTIVE_WHOLE_BRAIN_IRRADIATION_PATTERN,
      apply: (text) =>
        text
          .replace(PREVENTIVE_WHOLE_BRAIN_IRRADIATION_GLOBAL_PATTERN, "予防的全脳照射")
          .replace(WHOLE_BRAIN_IRRADIATION_GLOBAL_PATTERN, "全脳照射")
    },
    {
      name: "recommendation_wording_homophone",
      test: /進められる|進め合える/u,
      apply: (text) => text.replace(/進められる|進め合える/gu, "勧められる")
    },
    {
      name: "radiation_dose_homophone",
      test: /(勧められる|進められる)占領|予防的全脳照射.*占領/u,
      apply: (text) =>
        text
          .replace(/(?<=(勧められる|進められる))占領/gu, "線量")
          .replace(/予防的全脳照射([^。、「」]*)占領/gu, "予防的全脳照射$1線量")
    },
    {
      name: "cough_contextual_confirmation",
      test: symptomContext && /^(はい[、, ]*)?席です[。.]?$/u.test(normalizedText),
      apply: (text) => text.replace(/席/gu, "咳")
    }
  ];

  for (const rule of rules) {
    // test は RegExp または boolean。RegExpの場合は現在のテキストに対して評価する。
    const shouldApply =
      rule.test instanceof RegExp ? rule.test.test(normalizedText) : Boolean(rule.test);

    if (!shouldApply) {
      continue;
    }

    const nextText = rule.apply(normalizedText);

    if (nextText !== normalizedText) {
      repairs.push({
        type: rule.name,
        before: normalizedText,
        after: nextText
      });
      normalizedText = nextText;
    }
  }

  return {
    rawText: String(rawText || "").trim(),
    normalizedText,
    repairs,
    changed: normalizedText !== String(rawText || "").trim()
  };
}
