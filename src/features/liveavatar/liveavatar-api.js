import env from "../../config/env.js";
import { fetchJson } from "../../shared/http/fetch-json.js";

const LIVEAVATAR_API_BASE_URL = "https://api.liveavatar.com/v1";

function buildHeaders({ sessionToken, hasBody = false } = {}) {
  const headers = {
    accept: "application/json"
  };

  if (hasBody) {
    headers["content-type"] = "application/json";
  }

  if (sessionToken) {
    headers.authorization = `Bearer ${sessionToken}`;
  } else {
    headers["X-API-KEY"] = env.liveAvatarApiKey;
  }

  return headers;
}

export function unwrapLiveAvatarPayload(payload) {
  if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") {
    return payload.data;
  }

  return payload;
}

export async function requestLiveAvatar(
  path,
  { method = "GET", body, sessionToken, errorMessage = `LiveAvatar request failed: ${path}` } = {}
) {
  const result = await fetchJson(`${LIVEAVATAR_API_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(20_000),
    method,
    headers: buildHeaders({
      sessionToken,
      hasBody: body !== undefined
    }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

  if (!result.ok) {
    const error = new Error(errorMessage);
    error.status = result.status;
    error.details = result.data;
    throw error;
  }

  return unwrapLiveAvatarPayload(result.data);
}
