import { getScenario } from "./scenario-loader.js";
import {
  adoptScenarioSession,
  getOrCreateScenarioSession,
  moveScenarioSession,
  resetScenarioSession,
  rewindLastPatientMove,
  rememberScenarioSpeech
} from "./scenario.store.js";
import { matchIntent } from "./intent-matcher.js";
import {
  buildDeviationLines,
  classifyDeviation,
  classifyUtteranceControl
} from "./deviation-handler.js";
import { isSubstantiveUtterance } from "./utterance-filter.js";

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

  function getInputState(sessionId) {
    const currentScenario = resolveScenario();
    const session = getOrCreateScenarioSession(sessionId, currentScenario.entryNode);
    const node = getNode(currentScenario, session.nodeId);
    return {
      nodeId: session.nodeId,
      version: session.version,
      epoch: session.epoch,
      speechId: session.speechId,
      recoveryRequired: session.recoveryRequired,
      inputPaused: session.inputPaused,
      acceptsPatientInput:
        !session.inputPaused &&
        (node?.advance || []).some(
          (entry) => entry.type === "patient_any" || entry.type === "patient_intent"
        )
    };
  }

  function getSessionState(sessionId) {
    const currentScenario = resolveScenario();
    const session = getOrCreateScenarioSession(sessionId, currentScenario.entryNode);
    const node = getNode(currentScenario, session.nodeId);

    return {
      ...getInputState(sessionId),
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
      history: session.history,
      playback: session.playback
    };
  }

  async function handlePatientUtterance(
    sessionId,
    text,
    { revision = false, expectedVersion, expectedEpoch, signal } = {}
  ) {
    const currentScenario = resolveScenario();
    const session = getOrCreateScenarioSession(sessionId, currentScenario.entryNode);
    const noSpeech = (kind) => ({
      kind,
      deviation: null,
      nodeId: session.nodeId,
      scene: getNode(currentScenario, session.nodeId)?.scene ?? null,
      intent: null,
      lines: [],
      state: getInputState(sessionId)
    });

    signal?.throwIfAborted();
    if (expectedEpoch && expectedEpoch !== session.epoch) return noSpeech("superseded");
    if (
      expectedVersion !== undefined &&
      expectedVersion !== session.version &&
      !(revision && session.lastPatientMove?.fromVersion === expectedVersion)
    ) {
      return noSpeech("superseded");
    }
    if (session.inputPaused) return noSpeech("ignored");

    // 操作待ちでは遅れて届いた音声・言い直しも無視し、司会や投票に割り込まない。
    const advances = getNode(currentScenario, session.nodeId)?.advance || [];
    if (advances.length > 0 && advances.every((entry) => entry.type === "operator")) {
      return noSpeech("ignored");
    }

    // ASRが出す句読点だけ・一音だけの断片では進行させない(発話もしない)。
    // patient_anyノードをこれで通すと台本が勝手に進んでしまう。
    if (!isSubstantiveUtterance(text)) {
      console.log(
        "[scenario] utterance_ignored",
        JSON.stringify({ sessionId: session.sessionId, nodeId: session.nodeId, text })
      );

      return noSpeech("ignored");
    }

    // 発話の言い直し(途切れた発話の結合再送)の場合、直前の患者遷移を取り消してから
    // 結合後の発話で判定し直す。これをしないと同じ発話で台本が二重に進んでしまう。
    if (revision) {
      const rewound = rewindLastPatientMove(session);

      if (rewound) {
        console.log(
          "[scenario] revision_rewind",
          JSON.stringify({ sessionId: session.sessionId, nodeId: session.nodeId })
        );
      } else {
        // オペレーター操作後や期限切れの言い直しを、新規発話として進行させない。
        return noSpeech("superseded");
      }
    }

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
        state: getInputState(sessionId),
        lines: buildDeviationLines("closed", node, currentScenario)
      };
    }

    const anyEntry = getAdvanceEntries(node, "patient_any")[0];
    const intentEntries = getAdvanceEntries(node, "patient_intent");
    function rememberPatientTurn(fromSpeechLines = session.lastSpeechLines) {
      session.lastPatientMove = {
        fromNodeId: node.id,
        fromVersion: session.version,
        fromSpeechLines: [...fromSpeechLines],
        at: Date.now()
      };
    }
    const control = classifyUtteranceControl(text);

    function deviationResult(category) {
      const fromSpeechLines = [...session.lastSpeechLines];
      const lines =
        category === "repeat"
          ? getNodeLines(sessionId).lines
          : buildDeviationLines(category, node, currentScenario);
      rememberScenarioSpeech(session, lines);
      rememberPatientTurn(fromSpeechLines);
      return {
        kind: "deviation",
        deviation: category,
        nodeId: node.id,
        scene: node.scene,
        intent: null,
        state: getInputState(sessionId),
        lines
      };
    }

    // 「待って」「もう一度」を患者の回答として消費しない。
    if ((anyEntry || intentEntries.length) && control) return deviationResult(control);

    if (anyEntry) {
      const { lines, nodeId } = collectLinesFrom(currentScenario, anyEntry.next);
      moveScenarioSession(session, nodeId, "patient_any", lines);

      return {
        kind: "advance",
        deviation: null,
        nodeId,
        scene: getNode(currentScenario, nodeId)?.scene ?? null,
        intent: null,
        state: getInputState(sessionId),
        lines
      };
    }

    if (intentEntries.length > 0) {
      const category = classifyDeviation(text);
      // 「手術の費用」などは単語一致より先に台本外の質問として扱う。
      if (category === "medical_advice" || category === "case_conflict")
        return deviationResult(category);
      const version = session.version;
      const match = await matchIntent(text, intentEntries, {
        doctorLine: node.doctorLines.at(-1) || "",
        signal
      });

      // LLM分類の待機中にoperator操作(次へ/分岐/ジャンプ等)で状態が動いた場合は、
      // 古い判定結果を捨てて何も発話しない(operator操作を上書きしない)。
      signal?.throwIfAborted();
      if (session.version !== version) {
        console.warn(
          "[scenario] utterance_superseded",
          JSON.stringify({
            sessionId: session.sessionId,
            staleNodeId: node.id,
            nodeId: session.nodeId
          })
        );

        return noSpeech("superseded");
      }

      if (match) {
        const { lines, nodeId } = collectLinesFrom(currentScenario, match.next);
        moveScenarioSession(session, nodeId, `intent:${match.intent}`, lines);

        return {
          kind: "advance",
          deviation: null,
          nodeId,
          scene: getNode(currentScenario, nodeId)?.scene ?? null,
          intent: match.intent,
          intentMethod: match.method,
          matchedKeywords: match.matchedKeywords,
          state: getInputState(sessionId),
          lines
        };
      }

      // 候補語はあるが否定・競合で分類できなければ聞き直す。
      // 雑談なら従来どおり受け止めてから現在の質問へ戻す。
      const normalized = String(text).normalize("NFKC").toLowerCase();
      const mentionsCandidate = intentEntries.some((entry) =>
        (entry.keywords || []).some((word) =>
          normalized.includes(word.normalize("NFKC").toLowerCase())
        )
      );
      return deviationResult(mentionsCandidate ? "unclear" : category);
    }

    return noSpeech("ignored");
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
    moveScenarioSession(session, nodeId, `operator:${branch}`, lines);

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
    moveScenarioSession(session, nodeId, "operator:force_next", lines);

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
    moveScenarioSession(session, finalNodeId, "operator:jump", lines);

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
      lines: session.recoveryRequired
        ? []
        : !nodeId && session.lastSpeechLines.length
          ? session.lastSpeechLines
          : node.doctorLines
    };
  }

  function repeat(sessionId, nodeId) {
    const result = getNodeLines(sessionId, nodeId);
    const session = getOrCreateScenarioSession(sessionId, resolveScenario().entryNode);
    moveScenarioSession(session, session.nodeId, "operator:say", result.lines);
    return result;
  }

  function setInputPaused(sessionId, paused) {
    const session = getOrCreateScenarioSession(sessionId, resolveScenario().entryNode);
    if (!paused && session.recoveryRequired) {
      const error = new Error(
        "サーバー再起動後はジャンプで中断位置を指定するか、リセットしてください。"
      );
      error.status = 409;
      throw error;
    }
    session.inputPaused = paused;
    moveScenarioSession(session, session.nodeId, "operator:input", session.lastSpeechLines);
    return getInputState(sessionId);
  }

  function requireRecovery(sessionId) {
    const session = getOrCreateScenarioSession(sessionId, resolveScenario().entryNode);
    session.inputPaused = true;
    session.recoveryRequired = true;
    session.lastPatientMove = null;
    return getInputState(sessionId);
  }

  function reportPlayback(sessionId, { status, message, sequence, expectedEpoch }) {
    const session = getOrCreateScenarioSession(sessionId, resolveScenario().entryNode);
    if (expectedEpoch !== session.epoch || sequence <= session.playback.sequence) return false;
    session.playback = { status, message, sequence, updatedAt: new Date().toISOString() };
    return true;
  }

  // セッション再接続時に旧セッションの進行を新セッションへ引き継ぐ。
  function adoptProgress(fromSessionId, toSessionId) {
    const currentScenario = resolveScenario();
    return adoptScenarioSession(fromSessionId, toSessionId, currentScenario.entryNode);
  }

  return {
    getInputState,
    getSessionState,
    handlePatientUtterance,
    applyOperatorBranch,
    forceNext,
    jumpTo,
    reset,
    getNodeLines,
    repeat,
    setInputPaused,
    adoptProgress,
    requireRecovery,
    reportPlayback
  };
}

let defaultEngine = null;

export function getScenarioEngine() {
  if (!defaultEngine) {
    defaultEngine = createScenarioEngine();
  }

  return defaultEngine;
}
