import dotenv from "dotenv";

dotenv.config();

const str = (name, fallback = "") => process.env[name] || fallback;
const int = (name, fallback) => Number.parseInt(str(name, fallback), 10);
const float = (name, fallback) => Number.parseFloat(str(name, fallback));
const bool = (name, fallback) => str(name, fallback) === "true";

const env = {
  port: int("PORT", "3000"),
  host: str("HOST", "127.0.0.1"),
  liveAvatarApiKey: str("LIVEAVATAR_API_KEY"),
  liveAvatarAvatarId: str("LIVEAVATAR_AVATAR_ID", "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a"),
  liveAvatarVoiceId: str("LIVEAVATAR_VOICE_ID"),
  liveAvatarLanguage: str("LIVEAVATAR_LANGUAGE", "ja"),
  liveAvatarMode: str("LIVEAVATAR_MODE", "FULL"),
  liveAvatarUseSandbox: bool("LIVEAVATAR_USE_SANDBOX", "false"),
  liveAvatarVideoQuality: str("LIVEAVATAR_VIDEO_QUALITY", "medium"),
  liveAvatarVideoEncoding: str("LIVEAVATAR_VIDEO_ENCODING", "H264"),
  liveAvatarSelfControlled: bool("LIVEAVATAR_SELF_CONTROLLED", "true"),
  liveAvatarMicrophoneAutoGainControl: bool("LIVEAVATAR_MICROPHONE_AUTO_GAIN_CONTROL", "false"),
  liveAvatarVoiceModel: str("LIVEAVATAR_VOICE_MODEL", "eleven_multilingual_v2"),
  liveAvatarVoiceSpeed: float("LIVEAVATAR_VOICE_SPEED", "0.9"),
  liveAvatarVoiceStability: float("LIVEAVATAR_VOICE_STABILITY", "0.75"),
  liveAvatarVoiceSimilarityBoost: float("LIVEAVATAR_VOICE_SIMILARITY_BOOST", "0.75"),
  liveAvatarVoiceStyle: float("LIVEAVATAR_VOICE_STYLE", "0.15"),
  liveAvatarTranscriptDebounceMs: int("LIVEAVATAR_TRANSCRIPT_DEBOUNCE_MS", "1200"),
  liveAvatarTranscriptContinuationMs: int("LIVEAVATAR_TRANSCRIPT_CONTINUATION_MS", "1800"),
  // false(既定): アバター発話中の患者音声(エコー含む)を完全に無視し、必ず話し切らせる。
  // 会場が広く雑音・スピーカー回り込みを拾いやすいため、割り込みは既定で無効。
  liveAvatarAllowInterrupt: bool("LIVEAVATAR_ALLOW_INTERRUPT", "false"),
  liveAvatarAssistantName: str("LIVEAVATAR_ASSISTANT_NAME", "山本"),
  liveAvatarAssistantPersona: str("LIVEAVATAR_ASSISTANT_PERSONA", "肺がん専門の内科医"),
  liveAvatarOpeningGreeting: str("LIVEAVATAR_OPENING_GREETING", ""),
  scenarioId: str("SCENARIO_ID", "haigan-2026"),
  scenarioDir: str("SCENARIO_DIR", "./data/scenarios"),
  scenarioSpeechMode: str("SCENARIO_SPEECH_MODE", "fixed"),
  scenarioIntentLlm: bool("SCENARIO_INTENT_LLM", "true"),
  operatorToken: str("OPERATOR_TOKEN"),
  dialogueLogLimit: int("DIALOGUE_LOG_LIMIT", "200"),
  dialogueLlmTranscriptNormalizationEnabled: bool(
    "DIALOGUE_LLM_TRANSCRIPT_NORMALIZATION_ENABLED",
    "false"
  ),
  dialogueLlmTranscriptNormalizationModel: str(
    "DIALOGUE_LLM_TRANSCRIPT_NORMALIZATION_MODEL",
    str("OPENAI_MODEL", "gpt-4.1-mini")
  ),
  dialogueConversationHistoryLimit: int("DIALOGUE_CONVERSATION_HISTORY_LIMIT", "12"),
  dialogueSessionLimit: int("DIALOGUE_SESSION_LIMIT", "200"),
  dialogueLlmTimeoutMs: int("DIALOGUE_LLM_TIMEOUT_MS", "6000"),
  openAiApiBaseUrl: str("OPENAI_API_BASE_URL", "https://api.openai.com/v1"),
  openAiApiKey: str("OPENAI_API_KEY"),
  openAiModel: str("OPENAI_MODEL", "gpt-4.1-mini")
};

export function assertRuntimeConfig() {
  const missing = [
    !env.liveAvatarApiKey && "LIVEAVATAR_API_KEY",
    !env.liveAvatarAvatarId && "LIVEAVATAR_AVATAR_ID",
    !env.operatorToken && "OPERATOR_TOKEN"
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  if (!["fixed", "paraphrase"].includes(env.scenarioSpeechMode)) {
    throw new Error(
      `SCENARIO_SPEECH_MODE must be "fixed" or "paraphrase" (got "${env.scenarioSpeechMode}")`
    );
  }
  if (!env.liveAvatarSelfControlled || env.liveAvatarMode !== "FULL") {
    throw new Error(
      "このアプリは LIVEAVATAR_SELF_CONTROLLED=true / LIVEAVATAR_MODE=FULL 専用です。"
    );
  }
  if (process.env.NODE_ENV === "production" && env.scenarioSpeechMode !== "fixed") {
    throw new Error("本番環境では SCENARIO_SPEECH_MODE=fixed を使用してください。");
  }
  if (!Number.isFinite(env.dialogueLlmTimeoutMs) || env.dialogueLlmTimeoutMs <= 0) {
    throw new Error("DIALOGUE_LLM_TIMEOUT_MS must be a positive number");
  }
}

export default env;
