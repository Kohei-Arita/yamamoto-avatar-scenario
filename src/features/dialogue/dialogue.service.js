import env from "../../config/env.js";
import { getScenarioEngine } from "../scenario/scenario-engine.js";
import {
  adoptConversationSession,
  appendConversationTurn,
  getConversationMessages,
  initializeConversationSession
} from "./conversation.store.js";
import {
  appendDialogueLog,
  bindDebugSession,
  getLatestBoundSessionId
} from "./dialogue-log.store.js";
import { broadcastSpeechSegments } from "./dialogue-events.js";
import { callUpstreamOpenAi } from "./openai-client.js";
import {
  applyLlmTranscriptNormalization,
  buildMedicalTranscriptNormalizationMessages,
  parseMedicalTranscriptNormalizationResponse
} from "./llm-transcript-normalizer.js";
import { maybeParaphraseLines } from "./speech-paraphrase.js";
import { sanitizeSpeechContent, sanitizeSubtitleContent } from "./speech-content.js";
import { flushSpeechSegment, pullCompletedSpeechSegments } from "./streaming-speech.js";
import { normalizeMedicalTranscript } from "./transcript-normalizer.js";

function resolveSessionId(sessionId) {
  return sessionId || getLatestBoundSessionId() || "unbound-session";
}

async function maybeNormalizeTranscriptWithLlm(transcript, { historyMessages, signal } = {}) {
  if (!env.dialogueLlmTranscriptNormalizationEnabled || !env.openAiApiKey) {
    return transcript;
  }

  try {
    const content = await callUpstreamOpenAi(
      buildMedicalTranscriptNormalizationMessages(transcript.rawText, {
        candidateText: transcript.normalizedText,
        historyMessages
      }),
      {
        temperature: 0,
        signal,
        model: env.dialogueLlmTranscriptNormalizationModel
      }
    );

    return applyLlmTranscriptNormalization(
      transcript,
      parseMedicalTranscriptNormalizationResponse(content, transcript.normalizedText),
      env.dialogueLlmTranscriptNormalizationModel
    );
  } catch (error) {
    console.warn(
      "[dialogue] transcript_normalization_llm_error",
      JSON.stringify({ message: error.message, details: error.details || null })
    );
    return transcript;
  }
}

export function toSpeechSegments(content) {
  const { segments, remaining } = pullCompletedSpeechSegments(content);
  const trailing = flushSpeechSegment(remaining);

  if (trailing) {
    segments.push(trailing);
  }

  return segments;
}

async function buildScenarioReply(
  { text, sessionId, revision = false, expectedVersion } = {},
  { signal } = {}
) {
  const startedAt = Date.now();
  const userText = String(text || "");
  const resolvedSessionId = resolveSessionId(sessionId);
  const engine = getScenarioEngine();
  // 音声補正待ちの間のオペレーター操作も検出する。
  const requestVersion = expectedVersion ?? engine.getInputState(resolvedSessionId).version;

  const historyMessages = getConversationMessages(resolvedSessionId);
  const ruleBasedTranscript = normalizeMedicalTranscript(userText, { historyMessages });
  const transcript = await maybeNormalizeTranscriptWithLlm(ruleBasedTranscript, {
    historyMessages,
    signal
  });

  const engineResult = await engine.handlePatientUtterance(
    resolvedSessionId,
    transcript.normalizedText,
    { revision, expectedVersion: requestVersion, signal }
  );

  let {
    text: content,
    paraphrased,
    fallbackReason
  } = await maybeParaphraseLines(engineResult.lines, { signal });

  signal?.throwIfAborted();
  const currentState = engine.getInputState(resolvedSessionId);
  if (engineResult.state.version !== currentState.version) {
    content = "";
    engineResult.kind = "superseded";
    engineResult.lines = [];
    engineResult.state = currentState;
  }

  appendDialogueLog({
    sessionId: resolvedSessionId,
    kind: engineResult.kind,
    nodeId: engineResult.nodeId,
    scene: engineResult.scene,
    intent: engineResult.intent || null,
    intentMethod: engineResult.intentMethod || null,
    matchedKeywords: engineResult.matchedKeywords || [],
    deviation: engineResult.deviation || null,
    revision,
    userText,
    normalizedUserText: transcript.normalizedText,
    transcriptRepairs: transcript.repairs,
    speechMode: env.scenarioSpeechMode,
    paraphrased,
    paraphraseFallbackReason: fallbackReason,
    latencyMs: Date.now() - startedAt,
    answerPreview: content.slice(0, 160)
  });

  const isNoOpResult = engineResult.kind === "superseded" || engineResult.kind === "ignored";

  if (resolvedSessionId !== "unbound-session" && !isNoOpResult) {
    appendConversationTurn(resolvedSessionId, [
      { role: "user", content: transcript.normalizedText },
      { role: "assistant", content }
    ]);
  }

  return {
    content,
    speechContent: sanitizeSpeechContent(content),
    engineResult,
    sessionId: resolvedSessionId
  };
}

export async function answerUserText(userText, sessionId) {
  return buildScenarioReply({ text: userText, sessionId });
}

export async function streamScenarioReply(
  request = {},
  { signal, onSpeechSegment = () => {} } = {}
) {
  const result = await buildScenarioReply(request, { signal });

  for (const segment of toSpeechSegments(result.content)) {
    await onSpeechSegment({ ...segment, state: result.engineResult.state });
  }

  return result;
}

// 新しいLiveAvatarセッションのbind時、直前のセッションからシナリオ進行と
// 会話履歴を引き継ぐ。セッション切断→再接続で台本が先頭に戻る事故を防ぐ。
export function bindDialogueSession(sessionId) {
  const previousSessionId = getLatestBoundSessionId();
  const engine = getScenarioEngine();

  if (previousSessionId && previousSessionId !== sessionId) {
    const adopted = engine.adoptProgress(previousSessionId, sessionId);

    if (adopted) {
      adoptConversationSession(previousSessionId, sessionId);
      console.log(
        "[dialogue] session_progress_adopted",
        JSON.stringify({ from: previousSessionId, to: sessionId })
      );
    }
  }

  bindDebugSession(sessionId, { source: "browser" });
  engine.getSessionState(sessionId);

  const conversation = initializeConversationSession(sessionId, {
    openingGreeting: env.liveAvatarOpeningGreeting || undefined
  });
  const state = engine.getInputState(sessionId);
  const lines = engine.getNodeLines(sessionId).lines;
  const openingText =
    state.version === 0 && env.liveAvatarOpeningGreeting
      ? env.liveAvatarOpeningGreeting
      : lines.join("\n");
  return { ...conversation, state, openingSegments: toSpeechSegments(openingText) };
}

// operator操作(branch/next/jump/reset/say)の結果セリフを、
// SSEイベントチャンネル経由でブラウザの読み上げキューへ届ける。
export function deliverOperatorSpeech(sessionId, engineResult, { action } = {}) {
  const resolvedSessionId = resolveSessionId(sessionId);
  const content = (engineResult.lines || []).join("\n");
  const segments = toSpeechSegments(content);
  const state = getScenarioEngine().getInputState(resolvedSessionId);
  const subscriberCount = broadcastSpeechSegments(resolvedSessionId, segments, state);

  appendDialogueLog({
    sessionId: resolvedSessionId,
    kind: `operator_${action || engineResult.kind}`,
    nodeId: engineResult.nodeId,
    scene: engineResult.scene,
    branch: engineResult.branch || null,
    deviation: null,
    intent: null,
    speechMode: env.scenarioSpeechMode,
    delivered: subscriberCount > 0,
    subscriberCount,
    answerPreview: content.slice(0, 160)
  });

  if (resolvedSessionId !== "unbound-session" && content) {
    appendConversationTurn(resolvedSessionId, [{ role: "assistant", content }]);
  }

  return {
    sessionId: resolvedSessionId,
    content,
    subtitleContent: sanitizeSubtitleContent(content),
    delivered: subscriberCount > 0,
    subscriberCount,
    segmentCount: segments.length
  };
}
