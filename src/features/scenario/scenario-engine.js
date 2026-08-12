import { getScenario } from "./scenario-loader.js";
import {
  getOrCreateScenarioSession,
  moveScenarioSession,
  resetScenarioSession
} from "./scenario.store.js";
import { matchIntent } from "./intent-matcher.js";
import { buildDeviationLines, classifyDeviation } from "./deviation-handler.js";

function getNode(scenario, nodeId) {
  return scenario.nodes.find((node) => node.id === nodeId) || null;
}

function getAdvanceEntries(node, type) {
  return (node?.advance || []).filter((entry) => entry.type === type);
}

// 対象ノードのセリフを集め、auto遷移が続く限り次ノードへ連結する。
// 戻り値の nodeId は連結後に停止したノード。
function collectLinesFrom(scenario, startNodeId) {
  const lines = [];
  const visited = new Set();
  let nodeId = startNodeId;

  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = getNode(scenario, nodeId);

    if (!node) {
      break;
    }

    lines.push(...node.doctorLines);

    const autoEntry = getAdvanceEntries(node, "auto")[0];

    if (!autoEntry) {
      return { lines, nodeId };
    }

    nodeId = autoEntry.next;
  }

  return { lines, nodeId };
}

export function createScenarioEngine({ scenario = null } = {}) {
  const resolveScenario = () => scenario || getScenario();

  function getSessionState(sessionId) {
    const currentScenario = resolveScenario();
    const session = getOrCreateScenarioSession(sessionId, currentScenario.entryNode);
    const node = getNode(currentScenario, session.nodeId);

    return {
      sessionId: session.sessionId,
      scenarioId: currentScenario.id,
      nodeId: session.nodeId,
      scene: node?.scene ?? null,
      doctorLines: node?.doctorLines || [],
      placeholder: Boolean(node?.placeholder),
      awaitingBranches: getAdvanceEntries(node, "operator").map((entry) => ({
        branch: entry.branch,
        next: entry.next
      })),
      isTerminal: (node?.advance || []).length === 0,
      allNodeIds: currentScenario.nodes.map((candidate) => candidate.id),
      history: session.history
    };
  }

  async function handlePatientUtterance(sessionId, text, { signal } = {}) {
    const currentScenario = resolveScenario();
    const session = getOrCreateScenarioSession(sessionId, currentScenario.entryNode);
    const node = getNode(currentScenario, session.nodeId);

    if (!node) {
      throw new Error(`現在ノードが見つかりません: ${session.nodeId}`);
    }

    // 終端ノード
    if ((node.advance || []).length === 0) {
      return {
        kind: "deviation",
        deviation: "closed",
        nodeId: node.id,
        scene: node.scene,
        intent: null,
        lines: buildDeviationLines("closed", node, currentScenario)
      };
    }

    const anyEntry = getAdvanceEntries(node, "patient_any")[0];

    if (anyEntry) {
      const { lines, nodeId } = collectLinesFrom(currentScenario, anyEntry.next);
      moveScenarioSession(session, nodeId, "patient_any");

      return {
        kind: "advance",
        deviation: null,
        nodeId,
        scene: getNode(currentScenario, nodeId)?.scene ?? null,
        intent: null,
        lines
      };
    }

    const intentEntries = getAdvanceEntries(node, "patient_intent");

    if (intentEntries.length > 0) {
      const match = await matchIntent(text, intentEntries, {
        doctorLine: node.doctorLines.at(-1) || "",
        signal
      });

      if (match) {
        const { lines, nodeId } = collectLinesFrom(currentScenario, match.next);
        moveScenarioSession(session, nodeId, `intent:${match.intent}`);

        return {
          kind: "advance",
          deviation: null,
          nodeId,
          scene: getNode(currentScenario, nodeId)?.scene ?? null,
          intent: match.intent,
          intentMethod: match.method,
          matchedKeywords: match.matchedKeywords,
          lines
        };
      }

      const category = classifyDeviation(text);

      return {
        kind: "deviation",
        deviation: category,
        nodeId: node.id,
        scene: node.scene,
        intent: null,
        lines: buildDeviationLines(category, node, currentScenario)
      };
    }

    // operator遷移待ちノードで患者が発話した場合は待機応答
    return {
      kind: "hold",
      deviation: "hold",
      nodeId: node.id,
      scene: node.scene,
      intent: null,
      lines: buildDeviationLines("hold", node, currentScenario)
    };
  }

  function applyOperatorBranch(sessionId, branch) {
    const currentScenario = resolveScenario();
    const session = getOrCreateScenarioSession(sessionId, currentScenario.entryNode);
    const node = getNode(currentScenario, session.nodeId);
    const operatorEntries = getAdvanceEntries(node, "operator");

    if (operatorEntries.length === 0) {
      const error = new Error(`現在ノード(${session.nodeId})はoperator遷移を受け付けません`);
      error.status = 409;
      throw error;
    }

    const entry = operatorEntries.find((candidate) => candidate.branch === branch);

    if (!entry) {
      const error = new Error(
        `分岐 "${branch}" は現在ノード(${session.nodeId})に定義されていません`
      );
      error.status = 400;
      throw error;
    }

    const { lines, nodeId } = collectLinesFrom(currentScenario, entry.next);
    moveScenarioSession(session, nodeId, `operator:${branch}`);

    return {
      kind: "advance",
      nodeId,
      scene: getNode(currentScenario, nodeId)?.scene ?? null,
      branch,
      lines
    };
  }

  function forceNext(sessionId) {
    const currentScenario = resolveScenario();
    const session = getOrCreateScenarioSession(sessionId, currentScenario.entryNode);
    const node = getNode(currentScenario, session.nodeId);
    const firstEntry = (node?.advance || [])[0];

    if (!firstEntry) {
      const error = new Error(`現在ノード(${session.nodeId})は終端のため次へ進めません`);
      error.status = 409;
      throw error;
    }

    const { lines, nodeId } = collectLinesFrom(currentScenario, firstEntry.next);
    moveScenarioSession(session, nodeId, "operator:force_next");

    return {
      kind: "advance",
      nodeId,
      scene: getNode(currentScenario, nodeId)?.scene ?? null,
      lines
    };
  }

  function jumpTo(sessionId, nodeId) {
    const currentScenario = resolveScenario();
    const session = getOrCreateScenarioSession(sessionId, currentScenario.entryNode);
    const target = getNode(currentScenario, nodeId);

    if (!target) {
      const error = new Error(`ノードが見つかりません: ${nodeId}`);
      error.status = 400;
      throw error;
    }

    const { lines, nodeId: finalNodeId } = collectLinesFrom(currentScenario, nodeId);
    moveScenarioSession(session, finalNodeId, "operator:jump");

    return {
      kind: "advance",
      nodeId: finalNodeId,
      scene: getNode(currentScenario, finalNodeId)?.scene ?? null,
      lines
    };
  }

  function reset(sessionId) {
    const currentScenario = resolveScenario();
    resetScenarioSession(sessionId, currentScenario.entryNode);
    const entryNode = getNode(currentScenario, currentScenario.entryNode);

    return {
      kind: "reset",
      nodeId: currentScenario.entryNode,
      scene: entryNode?.scene ?? null,
      lines: entryNode?.doctorLines || []
    };
  }

  function getNodeLines(sessionId, nodeId) {
    const currentScenario = resolveScenario();
    const session = getOrCreateScenarioSession(sessionId, currentScenario.entryNode);
    const targetNodeId = nodeId || session.nodeId;
    const node = getNode(currentScenario, targetNodeId);

    if (!node) {
      const error = new Error(`ノードが見つかりません: ${targetNodeId}`);
      error.status = 400;
      throw error;
    }

    return {
      kind: "say",
      nodeId: node.id,
      scene: node.scene ?? null,
      lines: node.doctorLines
    };
  }

  return {
    getSessionState,
    handlePatientUtterance,
    applyOperatorBranch,
    forceNext,
    jumpTo,
    reset,
    getNodeLines
  };
}

let defaultEngine = null;

export function getScenarioEngine() {
  if (!defaultEngine) {
    defaultEngine = createScenarioEngine();
  }

  return defaultEngine;
}
