import { requireApplicationAccess } from "../access/access-control.js";
import { getScenarioEngine } from "../scenario/scenario-engine.js";
import { getDialogueLogs, getLatestBoundSessionId } from "../dialogue/dialogue-log.store.js";
import { deliverOperatorSpeech } from "../dialogue/dialogue.service.js";
import {
  broadcastScenarioState,
  countDialogueEventSubscribers
} from "../dialogue/dialogue-events.js";

export function requireOperatorToken(req, res, next) {
  return requireApplicationAccess(req, res, next);
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
    avatarConnected: countDialogueEventSubscribers(sessionId) > 0,
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
    assertExpectedVersion(req, sessionId);
    if (
      getScenarioEngine().getInputState(sessionId).recoveryRequired &&
      !["jump", "reset"].includes(action)
    ) {
      const error = new Error("サーバー再起動後は、ジャンプで中断位置を指定してください。");
      error.status = 409;
      throw error;
    }
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

function assertExpectedVersion(req, sessionId) {
  const expected = req.body?.expectedVersion;
  const epoch = req.body?.expectedEpoch;
  const current = getScenarioEngine().getInputState(sessionId);
  if (
    (epoch && epoch !== current.epoch) ||
    (expected !== undefined && expected !== current.version)
  ) {
    const error = new Error("進行が更新されました。現在の状態を確認して操作してください。");
    error.status = 409;
    throw error;
  }
}

export function postOperatorInput(req, res) {
  const sessionId = resolveSessionId(req);
  if (typeof req.body?.paused !== "boolean") {
    return res.status(400).json({ ok: false, error: "paused must be a boolean" });
  }
  try {
    assertExpectedVersion(req, sessionId);
    const state = getScenarioEngine().setInputPaused(sessionId, req.body.paused);
    broadcastScenarioState(sessionId, state);
    return res.json(buildStateResponse(sessionId));
  } catch (error) {
    return sendOperatorError(res, "input", error);
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
    engine.repeat(sessionId, nodeId || null)
  );
}
