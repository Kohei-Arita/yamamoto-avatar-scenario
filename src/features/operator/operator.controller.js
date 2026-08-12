import env from "../../config/env.js";
import { getScenarioEngine } from "../scenario/scenario-engine.js";
import { getDialogueLogs, getLatestBoundSessionId } from "../dialogue/dialogue-log.store.js";
import { deliverOperatorSpeech } from "../dialogue/dialogue.service.js";

export function requireOperatorToken(req, res, next) {
  if (!env.operatorToken) {
    return res.status(503).json({
      ok: false,
      error: "OPERATOR_TOKEN is not configured on the server"
    });
  }

  const authHeader = req.headers.authorization || "";

  if (authHeader !== `Bearer ${env.operatorToken}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  return next();
}

function resolveSessionId(req) {
  return (
    req.body?.sessionId || req.query?.sessionId || getLatestBoundSessionId() || "unbound-session"
  );
}

function sendOperatorError(res, action, error) {
  const status = error.status || 500;

  console.error(`[operator] ${action}_error`, JSON.stringify({ status, message: error.message }));

  return res.status(status).json({ ok: false, error: error.message });
}

function buildStateResponse(sessionId, extra = {}) {
  const engine = getScenarioEngine();
  const state = engine.getSessionState(sessionId);

  return {
    ok: true,
    ...extra,
    state,
    logs: getDialogueLogs(sessionId).slice(-20)
  };
}

export function getOperatorState(req, res) {
  const sessionId = resolveSessionId(req);

  try {
    return res.json(buildStateResponse(sessionId));
  } catch (error) {
    return sendOperatorError(res, "state", error);
  }
}

function applyEngineAction(req, res, action, run) {
  const sessionId = resolveSessionId(req);

  try {
    const engineResult = run(getScenarioEngine(), sessionId);
    const delivery = deliverOperatorSpeech(sessionId, engineResult, { action });

    console.log(
      `[operator] ${action}`,
      JSON.stringify({
        sessionId,
        nodeId: engineResult.nodeId,
        branch: engineResult.branch || null,
        delivered: delivery.delivered
      })
    );

    return res.json(buildStateResponse(sessionId, { delivery }));
  } catch (error) {
    return sendOperatorError(res, action, error);
  }
}

export function postOperatorBranch(req, res) {
  const { branch } = req.body || {};

  if (!branch || typeof branch !== "string") {
    return res.status(400).json({ ok: false, error: "branch is required" });
  }

  return applyEngineAction(req, res, "branch", (engine, sessionId) =>
    engine.applyOperatorBranch(sessionId, branch)
  );
}

export function postOperatorNext(req, res) {
  return applyEngineAction(req, res, "next", (engine, sessionId) => engine.forceNext(sessionId));
}

export function postOperatorJump(req, res) {
  const { nodeId } = req.body || {};

  if (!nodeId || typeof nodeId !== "string") {
    return res.status(400).json({ ok: false, error: "nodeId is required" });
  }

  return applyEngineAction(req, res, "jump", (engine, sessionId) =>
    engine.jumpTo(sessionId, nodeId)
  );
}

export function postOperatorReset(req, res) {
  return applyEngineAction(req, res, "reset", (engine, sessionId) => engine.reset(sessionId));
}

export function postOperatorSay(req, res) {
  const { nodeId } = req.body || {};

  return applyEngineAction(req, res, "say", (engine, sessionId) =>
    engine.getNodeLines(sessionId, nodeId || null)
  );
}
