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
  liveAvatarContextId: str("LIVEAVATAR_CONTEXT_ID"),
  liveAvatarLanguage: str("LIVEAVATAR_LANGUAGE", "en"),
  liveAvatarMode: str("LIVEAVATAR_MODE", "FULL"),
  liveAvatarUseSandbox: bool("LIVEAVATAR_USE_SANDBOX", "true"),
  liveAvatarVideoQuality: str("LIVEAVATAR_VIDEO_QUALITY", "medium"),
  liveAvatarVideoEncoding: str("LIVEAVATAR_VIDEO_ENCODING", "H264"),
  liveAvatarLlmConfigurationId: str("LIVEAVATAR_LLM_CONFIGURATION_ID"),
  liveAvatarSelfControlled: bool("LIVEAVATAR_SELF_CONTROLLED", "false"),
  liveAvatarVoiceModel: str("LIVEAVATAR_VOICE_MODEL", "eleven_multilingual_v2"),
  liveAvatarVoiceSpeed: float("LIVEAVATAR_VOICE_SPEED", "0.9"),
  liveAvatarVoiceStability: float("LIVEAVATAR_VOICE_STABILITY", "0.75"),
  liveAvatarVoiceSimilarityBoost: float("LIVEAVATAR_VOICE_SIMILARITY_BOOST", "0.75"),
  liveAvatarVoiceStyle: float("LIVEAVATAR_VOICE_STYLE", "0.15"),
  liveAvatarTranscriptDebounceMs: int("LIVEAVATAR_TRANSCRIPT_DEBOUNCE_MS", "1200"),
  liveAvatarTranscriptContinuationMs: int("LIVEAVATAR_TRANSCRIPT_CONTINUATION_MS", "1800"),
  liveAvatarAssistantName: str("LIVEAVATAR_ASSISTANT_NAME", "山本"),
  liveAvatarAssistantPersona: str("LIVEAVATAR_ASSISTANT_PERSONA", "肺がん専門の内科医"),
  liveAvatarOpeningGreeting: str(
    "LIVEAVATAR_OPENING_GREETING",
    "内科医の山本です。ガイドラインをもとに一般的な説明をします。今日はどうされましたか？"
  ),
  ragEnabled: bool("RAG_ENABLED", "true"),
  ragDataPath: str("RAG_DATA_PATH", "./data/processed/lung-cancer-guideline-hybrid.jsonl"),
  ragTopK: int("RAG_TOP_K", "6"),
  ragLogLimit: int("RAG_LOG_LIMIT", "200"),
  ragMinScore: int("RAG_MIN_SCORE", "2"),
  ragLlmTranscriptNormalizationEnabled: bool("RAG_LLM_TRANSCRIPT_NORMALIZATION_ENABLED", "true"),
  ragLlmTranscriptNormalizationModel: str(
    "RAG_LLM_TRANSCRIPT_NORMALIZATION_MODEL",
    str("OPENAI_MODEL", "gpt-4.1-mini")
  ),
  ragConversationHistoryLimit: int("RAG_CONVERSATION_HISTORY_LIMIT", "12"),
  ragSessionLimit: int("RAG_SESSION_LIMIT", "200"),
  ragEndpointApiKey: str("RAG_ENDPOINT_API_KEY"),
  openAiApiBaseUrl: str("OPENAI_API_BASE_URL", "https://api.openai.com/v1"),
  openAiApiKey: str("OPENAI_API_KEY"),
  openAiModel: str("OPENAI_MODEL", "gpt-4.1-mini")
};

export function assertRuntimeConfig() {
  const missing = [
    !env.liveAvatarApiKey && "LIVEAVATAR_API_KEY",
    !env.liveAvatarAvatarId && "LIVEAVATAR_AVATAR_ID"
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

export default env;
