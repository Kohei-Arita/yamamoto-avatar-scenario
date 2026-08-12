import env, { assertRuntimeConfig } from "../../config/env.js";
import { requestLiveAvatar } from "./liveavatar-api.js";

function buildVoiceSettings() {
  return {
    model: env.liveAvatarVoiceModel,
    speed: env.liveAvatarVoiceSpeed,
    stability: env.liveAvatarVoiceStability,
    similarity_boost: env.liveAvatarVoiceSimilarityBoost,
    style: env.liveAvatarVoiceStyle,
    use_speaker_boost: true
  };
}

function buildAvatarPersona() {
  const avatarPersona = {
    language: env.liveAvatarLanguage,
    voice_settings: buildVoiceSettings()
  };

  if (env.liveAvatarVoiceId) {
    avatarPersona.voice_id = env.liveAvatarVoiceId;
  }

  if (!env.liveAvatarSelfControlled && env.liveAvatarContextId) {
    avatarPersona.context_id = env.liveAvatarContextId;
  }

  return avatarPersona;
}

function getDefaultVideoSettings() {
  return {
    quality: env.liveAvatarVideoQuality,
    encoding: env.liveAvatarVideoEncoding
  };
}

export function getPublicConfig() {
  return {
    avatarId: env.liveAvatarAvatarId,
    language: env.liveAvatarLanguage,
    mode: env.liveAvatarMode,
    isSandbox: env.liveAvatarUseSandbox,
    selfControlled: env.liveAvatarSelfControlled,
    transcriptDebounceMs: env.liveAvatarTranscriptDebounceMs,
    transcriptContinuationMs: env.liveAvatarTranscriptContinuationMs,
    assistantName: env.liveAvatarAssistantName,
    assistantPersona: env.liveAvatarAssistantPersona,
    openingGreeting: env.liveAvatarOpeningGreeting,
    hasVoiceId: Boolean(env.liveAvatarVoiceId),
    hasContextId: Boolean(env.liveAvatarContextId),
    hasLlmConfigurationId: Boolean(env.liveAvatarLlmConfigurationId)
  };
}

export async function createSessionToken() {
  assertRuntimeConfig();

  const payload = {
    mode: env.liveAvatarMode,
    is_sandbox: env.liveAvatarUseSandbox,
    avatar_id: env.liveAvatarAvatarId,
    avatar_persona: buildAvatarPersona(),
    video_settings: getDefaultVideoSettings()
  };

  if (!env.liveAvatarSelfControlled && env.liveAvatarLlmConfigurationId) {
    payload.llm_configuration = env.liveAvatarLlmConfigurationId;
  }

  console.log(
    "[liveavatar] create_session_token",
    JSON.stringify({
      mode: payload.mode,
      isSandbox: payload.is_sandbox,
      avatarId: payload.avatar_id,
      selfControlled: env.liveAvatarSelfControlled,
      hasContextId: Boolean(payload.avatar_persona?.context_id),
      hasVoiceId: Boolean(payload.avatar_persona?.voice_id),
      llmConfiguration: payload.llm_configuration || null
    })
  );

  const data = await requestLiveAvatar("/sessions/token", {
    method: "POST",
    body: payload,
    errorMessage: "Failed to create LiveAvatar session token"
  });

  console.log(
    "[liveavatar] create_session_token_ok",
    JSON.stringify({
      sessionId: data?.session_id || null,
      selfControlled: env.liveAvatarSelfControlled,
      hasSessionToken: Boolean(data?.session_token),
      llmConfiguration: payload.llm_configuration || null
    })
  );

  return data;
}

export async function startSession(sessionToken) {
  const payload = await requestLiveAvatar("/sessions/start", {
    method: "POST",
    sessionToken,
    errorMessage: "Failed to start LiveAvatar session"
  });

  const livekitUrl =
    payload?.livekit_url ||
    payload?.liveKitUrl ||
    payload?.ws_url ||
    payload?.room_url ||
    payload?.url ||
    null;

  const livekitToken =
    payload?.livekit_token ||
    payload?.livekit_client_token ||
    payload?.liveKitToken ||
    payload?.room_token ||
    payload?.token ||
    payload?.client_token ||
    null;

  return {
    ...payload,
    livekit_url: livekitUrl,
    livekit_token: livekitToken
  };
}

export async function stopSession(sessionToken) {
  return requestLiveAvatar("/sessions/stop", {
    method: "POST",
    sessionToken,
    errorMessage: "Failed to stop LiveAvatar session"
  });
}
