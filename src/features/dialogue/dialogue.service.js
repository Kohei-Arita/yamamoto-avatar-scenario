import env from "../../config/env.js";
import { getScenarioEngine } from "../scenario/scenario-engine.js";
import { appendConversationTurn, initializeConversationSession } from "./conversation.store.js";
import { appendDialogueLog, getLatestBoundSessionId } from "./dialogue-log.store.js";
import { broadcastSpeechSegments } from "./dialogue-events.js";
import { getLastUserMessage } from "./chat-message.js";
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

async function maybeNormalizeTranscriptWithLlm(transcript, { signal } = {}) {
  if (!env.dialogueLlmTranscriptNormalizationEnabled || !env.openAiApiKey) {
    return transcript;
  }

  try {
    const content = await callUpstreamOpenAi(
      buildMedicalTranscriptNormalizationMessages(transcript.rawText, {
        candidateText: transcript.normalizedText
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

async function buildScenarioReply(body = {}, { signal } = {}) {
  const startedAt = Date.now();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userText = getLastUserMessage(messages);
  const sessionId = resolveSessionId(body?.metadata?.sessionId);
  const engine = getScenarioEngine();

  const ruleBasedTranscript = normalizeMedicalTranscript(userText);
  const transcript = await maybeNormalizeTranscriptWithLlm(ruleBasedTranscript, { signal });

  const engineResult = await engine.handlePatientUtterance(sessionId, transcript.normalizedText, {
    signal
  });

  const {
    text: content,
    paraphrased,
    fallbackReason
  } = await maybeParaphraseLines(engineResult.lines, { signal });

  appendDialogueLog({
    sessionId,
    kind: engineResult.kind,
    nodeId: engineResult.nodeId,
    scene: engineResult.scene,
    intent: engineResult.intent || null,
    intentMethod: engineResult.intentMethod || null,
    matchedKeywords: engineResult.matchedKeywords || [],
    deviation: engineResult.deviation || null,
    userText,
    normalizedUserText: transcript.normalizedText,
    transcriptRepairs: transcript.repairs,
    speechMode: env.scenarioSpeechMode,
    paraphrased,
    paraphraseFallbackReason: fallbackReason,
    latencyMs: Date.now() - startedAt,
    answerPreview: content.slice(0, 160)
  });

  if (sessionId !== "unbound-session") {
    appendConversationTurn(sessionId, [
      { role: "user", content: transcript.normalizedText },
      { role: "assistant", content }
    ]);
  }

  return {
    content,
    speechContent: sanitizeSpeechContent(content),
    engineResult,
    sessionId
  };
}

export async function answerUserText(userText, sessionId) {
  return buildScenarioReply({
    messages: [{ role: "user", content: userText }],
    metadata: sessionId ? { sessionId } : {}
  });
}

export async function handleChatCompletion(body = {}) {
  return buildScenarioReply(body);
}

export async function streamChatCompletion(body = {}, { signal, onSpeechSegment = () => {} } = {}) {
  const result = await buildScenarioReply(body, { signal });

  for (const segment of toSpeechSegments(result.content)) {
    await onSpeechSegment(segment);
  }

  return result;
}

export function bindDialogueSession(sessionId) {
  const engine = getScenarioEngine();
  engine.getSessionState(sessionId);

  return initializeConversationSession(sessionId, {
    openingGreeting: env.liveAvatarOpeningGreeting || undefined
  });
}

// operator操作(branch/next/jump/reset/say)の結果セリフを、
// SSEイベントチャンネル経由でブラウザの読み上げキューへ届ける。
export function deliverOperatorSpeech(sessionId, engineResult, { action } = {}) {
  const resolvedSessionId = resolveSessionId(sessionId);
  const content = (engineResult.lines || []).join("\n");
  const segments = toSpeechSegments(content);
  const subscriberCount = broadcastSpeechSegments(resolvedSessionId, segments);

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
