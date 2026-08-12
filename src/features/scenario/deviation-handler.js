const DEFAULT_REPLIES = {
  medical_advice:
    "ご心配なお気持ち、よくわかります。詳しくは専門のチームで検討し、あらためてご説明しますね。",
  case_conflict:
    "そうでしたか。今日は、紹介元の先生からいただいている情報を中心に確認させてください。",
  off_topic: "そうなんですね。ありがとうございます。",
  unclear: "すみません、もう一度お聞かせいただけますか。",
  hold: "ただいま会場の皆さまにお伺いしていますので、少しだけお待ちください。",
  closed: "本日の診察はここまでです。ありがとうございました。"
};

const MEDICAL_ADVICE_PATTERN =
  /余命|あと何年|何年生き|生きられ|助かり|死んで|死にま|治る確率|生存率|再発率|費用|お金|いくら|値段|高額/u;
const CASE_CONFLICT_PATTERN =
  /(昔|以前|前に|過去に).{0,8}(手術|入院|抗がん剤|放射線)|手術を受けたこと|治療したこと/u;

export function classifyDeviation(text = "") {
  const normalized = String(text || "")
    .normalize("NFKC")
    .trim();

  if (!normalized || normalized.length < 2) {
    return "unclear";
  }

  if (MEDICAL_ADVICE_PATTERN.test(normalized)) {
    return "medical_advice";
  }

  if (CASE_CONFLICT_PATTERN.test(normalized)) {
    return "case_conflict";
  }

  return "off_topic";
}

function resolveReply(category, node, scenario) {
  return (
    node?.onDeviation?.[category] ||
    scenario?.globalDeviationReplies?.[category] ||
    DEFAULT_REPLIES[category] ||
    DEFAULT_REPLIES.off_topic
  );
}

export function buildDeviationLines(category, node, scenario) {
  const reply = resolveReply(category, node, scenario);
  const lines = [reply];

  // 聞き取り不能・進行待ち・終了時は再提示せず、それ以外は現在ノードの質問へ戻す
  if (!["unclear", "hold", "closed"].includes(category)) {
    const lastLine = (node?.doctorLines || []).at(-1);

    if (lastLine && lastLine !== reply) {
      lines.push(lastLine);
    }
  }

  return lines;
}
