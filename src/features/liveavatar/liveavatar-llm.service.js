import crypto from "node:crypto";
import env from "../../config/env.js";
import { requestLiveAvatar } from "./liveavatar-api.js";

function withResolvedId(payload, keys) {
  const resolvedId = keys.find((key) => typeof payload?.[key] === "string") || null;

  return {
    ...payload,
    id: resolvedId ? payload[resolvedId] : payload?.id || null
  };
}

async function liveAvatarRequest(path, body, { sessionToken } = {}) {
  return requestLiveAvatar(path, {
    method: "POST",
    body,
    sessionToken,
    errorMessage: `LiveAvatar request failed: ${path}`
  });
}

async function liveAvatarGet(path, { sessionToken } = {}) {
  return requestLiveAvatar(path, {
    method: "GET",
    sessionToken,
    errorMessage: `LiveAvatar request failed: ${path}`
  });
}

async function liveAvatarPatch(path, body, { sessionToken } = {}) {
  return requestLiveAvatar(path, {
    method: "PATCH",
    body,
    sessionToken,
    errorMessage: `LiveAvatar request failed: ${path}`
  });
}

function getEndpointSecretValue() {
  return env.ragEndpointApiKey || crypto.randomUUID();
}

export async function createLiveAvatarSecret({
  secretName = "yamamotoavator-demo-rag-endpoint",
  secretValue = getEndpointSecretValue()
} = {}) {
  const payload = await liveAvatarRequest("/secrets", {
    secret_type: "OPENAI_API_KEY",
    secret_name: secretName,
    secret_value: secretValue
  });

  return withResolvedId(payload, ["id", "secret_id"]);
}

export async function createLiveAvatarLlmConfiguration({
  baseUrl,
  displayName = "yamamotoavator-demo-rag",
  modelName = env.openAiModel,
  secretId
}) {
  const payload = await liveAvatarRequest("/llm-configurations", {
    url: baseUrl,
    display_name: displayName,
    model_name: modelName,
    secret_id: secretId
  });

  return withResolvedId(payload, ["id", "llm_configuration_id"]);
}

export async function getLiveAvatarLlmConfiguration(configId) {
  const payload = await liveAvatarGet(`/llm-configurations/${configId}`);
  return withResolvedId(payload, ["id", "llm_configuration_id"]);
}

export async function updateLiveAvatarLlmConfiguration(configId, updates) {
  const payload = await liveAvatarPatch(`/llm-configurations/${configId}`, updates);
  return withResolvedId(payload, ["id", "llm_configuration_id"]);
}
