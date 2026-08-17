import {
  createSessionToken,
  getPublicConfig,
  startSession,
  stopSession
} from "./liveavatar.service.js";
import { registerKnownSessionId } from "../dialogue/session-registry.js";

const RECENT_SESSION_TOKEN_TTL_MS = 10_000;
const recentSessionTokens = new Map();
const inFlightSessionTokens = new Map();

function getReferer(req) {
  return req.get("referer") || null;
}

function getOrigin(req) {
  return req.get("origin") || null;
}

function sendError(res, step, error) {
  const status = error.status || 500;

  console.error(
    `[liveavatar] ${step}_error`,
    JSON.stringify({
      status,
      message: error.message,
      details: error.details || null
    })
  );

  res.status(status).json({
    ok: false,
    step,
    error: error.details || error.message
  });
}

function getClientFingerprint(req) {
  return JSON.stringify({
    ip: req.ip || req.socket?.remoteAddress || "unknown",
    userAgent: req.get("user-agent") || "",
    origin: req.get("origin") || "",
    referer: req.get("referer") || ""
  });
}

function pruneExpiredRecentSessionTokens() {
  const now = Date.now();

  for (const [key, entry] of recentSessionTokens.entries()) {
    if (!entry || entry.expiresAt <= now) {
      recentSessionTokens.delete(key);
    }
  }
}

function getRecentSessionToken(req) {
  pruneExpiredRecentSessionTokens();
  const existing = recentSessionTokens.get(getClientFingerprint(req));
  return existing?.data ?? null;
}

function rememberRecentSessionToken(req, data) {
  pruneExpiredRecentSessionTokens();
  recentSessionTokens.set(getClientFingerprint(req), {
    data,
    expiresAt: Date.now() + RECENT_SESSION_TOKEN_TTL_MS
  });
}

function buildSessionTokenResponse(data) {
  registerKnownSessionId(data?.session_id || null);

  return {
    ok: true,
    session_id: data.session_id || null,
    session_token: data.session_token || null,
    raw: data
  };
}

function logSessionTokenEvent(eventName, req, data) {
  console.log(
    `[liveavatar] ${eventName}`,
    JSON.stringify({
      sessionId: data?.session_id || null,
      referer: getReferer(req)
    })
  );
}

export function getLiveAvatarConfig(req, res) {
  res.json({
    ok: true,
    config: getPublicConfig()
  });
}

export async function postSessionToken(req, res) {
  const key = getClientFingerprint(req);

  try {
    const recentData = getRecentSessionToken(req);

    if (recentData) {
      logSessionTokenEvent("create_session_token_reused", req, recentData);
      return res.json(buildSessionTokenResponse(recentData));
    }

    const inFlight = inFlightSessionTokens.get(key);

    if (inFlight) {
      const data = await inFlight;
      logSessionTokenEvent("create_session_token_joined", req, data);
      return res.json(buildSessionTokenResponse(data));
    }

    console.log(
      "[liveavatar] create_session_token_request",
      JSON.stringify({
        referer: getReferer(req),
        origin: getOrigin(req)
      })
    );

    const requestPromise = createSessionToken();
    inFlightSessionTokens.set(key, requestPromise);

    try {
      const data = await requestPromise;
      rememberRecentSessionToken(req, data);
      return res.json(buildSessionTokenResponse(data));
    } finally {
      inFlightSessionTokens.delete(key);
    }
  } catch (error) {
    return sendError(res, "create_session_token", error);
  }
}

export async function postStartSession(req, res) {
  try {
    const { sessionToken } = req.body;

    if (!sessionToken) {
      return res.status(400).json({
        ok: false,
        step: "start_session",
        error: "sessionToken is required"
      });
    }

    console.log(
      "[liveavatar] start_session_request",
      JSON.stringify({
        referer: getReferer(req),
        hasSessionToken: Boolean(sessionToken)
      })
    );

    const data = await startSession(sessionToken);

    console.log(
      "[liveavatar] start_session_ok",
      JSON.stringify({
        livekitUrl: data.livekit_url || null,
        hasLivekitToken: Boolean(data.livekit_token)
      })
    );

    return res.json({
      ok: true,
      livekit_url: data.livekit_url,
      livekit_token: data.livekit_token,
      raw: data
    });
  } catch (error) {
    return sendError(res, "start_session", error);
  }
}

export async function postStopSession(req, res) {
  try {
    const { sessionToken } = req.body;

    if (!sessionToken) {
      return res.status(400).json({
        ok: false,
        step: "stop_session",
        error: "sessionToken is required"
      });
    }

    const data = await stopSession(sessionToken);

    return res.json({ ok: true, raw: data });
  } catch (error) {
    return sendError(res, "stop_session", error);
  }
}
