import env from "../../config/env.js";
import {
  appendConversationTurn,
  getConversationMessages,
  initializeConversationSession
} from "./conversation.store.js";
import { appendRagLog, getLatestBoundSessionId } from "./rag-log.store.js";
import {
  applyLlmTranscriptNormalization,
  buildMedicalTranscriptNormalizationMessages,
  parseMedicalTranscriptNormalizationResponse
} from "./llm-transcript-normalizer.js";
import {
  buildNoEvidenceFallbackPrompt,
  buildNoEvidenceResponse,
  finalizeAssistantTexts,
  formatSources,
  toSpeechContent,
  toSubtitleContent
} from "./assistant-text.js";
import { getLastUserMessage, replaceLastUserMessage } from "./chat-message.js";
import {
  buildConversationSystemPrompt,
  buildRagContext,
  buildRagFinalCheckPrompt,
  buildRagSystemPrompt
} from "./prompts/answer-prompt.js";
import { buildRetrievalQuery, isLikelyFollowUpUtterance } from "./follow-up-context.js";
import { generateAssistantContent, callUpstreamOpenAi } from "./openai-client.js";
import { decideNeedRag } from "./rag-router.js";
import { flushSpeechSegment, pullCompletedSpeechSegments } from "./streaming-speech.js";
import { buildPromptUserMessage, normalizeMedicalTranscript } from "./transcript-normalizer.js";
import { retrieveGuidelineChunks } from "./retrievers/guideline-retriever.js";

function buildTranscriptLogFields(userText, ruleBasedTranscript, transcript) {
  return {
    userText,
    ruleBasedNormalizedUserText: ruleBasedTranscript.normalizedText,
    normalizedUserText: transcript.normalizedText,
    transcriptRepairs: transcript.repairs,
    llmTranscriptNormalization: transcript.llmNormalization
  };
}

function createChatCompletionBody(userText, sessionId) {
  return {
    messages: [{ role: "user", content: userText }],
    metadata: sessionId ? { sessionId } : {}
  };
}

function getAssistantProfile() {
  return {
    assistantName: env.liveAvatarAssistantName,
    assistantPersona: env.liveAvatarAssistantPersona
  };
}

function mergeHistoryMessages(
  messages,
  historyMessages,
  { historyLimit = historyMessages.length, followUpText = "" } = {}
) {
  if (historyMessages.length === 0 || messages.length > 2) {
    return messages;
  }

  if (followUpText && !isLikelyFollowUpUtterance(followUpText)) {
    return messages;
  }

  return [...historyMessages.slice(-historyLimit), ...messages];
}

function applyTranscriptToMessages(messages, transcript) {
  return replaceLastUserMessage(messages, buildPromptUserMessage(transcript));
}

function withSkippedLlmNormalization(transcript) {
  return {
    ...transcript,
    llmNormalization: {
      attempted: false,
      changed: false,
      model: env.ragLlmTranscriptNormalizationModel
    }
  };
}

async function maybeNormalizeTranscriptWithLlm(transcript, { historyMessages = [], signal } = {}) {
  if (!env.ragLlmTranscriptNormalizationEnabled || !env.openAiApiKey) {
    return withSkippedLlmNormalization(transcript);
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
        model: env.ragLlmTranscriptNormalizationModel
      }
    );

    const normalizedText = parseMedicalTranscriptNormalizationResponse(
      content,
      transcript.normalizedText
    );

    return applyLlmTranscriptNormalization(
      transcript,
      normalizedText,
      env.ragLlmTranscriptNormalizationModel
    );
  } catch (error) {
    console.warn(
      "[rag] transcript_normalization_llm_error",
      JSON.stringify({
        message: error.message,
        details: error.details || null
      })
    );

    return {
      ...transcript,
      llmNormalization: {
        attempted: true,
        changed: false,
        model: env.ragLlmTranscriptNormalizationModel,
        error: error.message
      }
    };
  }
}

function shouldAttemptLlmTranscriptNormalization(transcript, route, historyMessages = []) {
  if (!transcript?.normalizedText) {
    return false;
  }

  if (transcript.changed || route?.needsRag) {
    return true;
  }

  return historyMessages.length > 0 && isLikelyFollowUpUtterance(transcript.normalizedText);
}

function maybeLoadConversation(sessionId) {
  if (!sessionId || sessionId === "unbound-session") {
    return [];
  }

  initializeConversationSession(sessionId, {
    openingGreeting: env.liveAvatarOpeningGreeting
  });

  return getConversationMessages(sessionId);
}

function persistConversation(sessionId, userText, assistantText) {
  if (!sessionId || sessionId === "unbound-session") {
    return;
  }

  appendConversationTurn(sessionId, [
    { role: "user", content: userText },
    { role: "assistant", content: assistantText }
  ]);
}

function appendResultLog(sessionId, entry, startedAt, answerPreview) {
  appendRagLog({
    sessionId,
    ...entry,
    latencyMs: Date.now() - startedAt,
    answerPreview: answerPreview.slice(0, 160)
  });
}

function persistAndReturnResponse(sessionId, userText, response, content = response.content) {
  persistConversation(sessionId, userText, response.content);
  return {
    content,
    speechContent: response.speechContent
  };
}

function buildRetrievalLogFields(retrieval, retrievalQuery) {
  return {
    retrievalQuery,
    queryIntent: retrieval.diagnostics.queryIntent,
    retrievalStage: retrieval.diagnostics.retrievalStage,
    matchedTerms: retrieval.diagnostics.matchedTerms,
    sourceIds: retrieval.diagnostics.sourceIds
  };
}

function completeResult({
  sessionId,
  userText,
  response,
  startedAt,
  logEntry,
  content = response.content
}) {
  appendResultLog(sessionId, logEntry, startedAt, content);
  return persistAndReturnResponse(sessionId, userText, response, content);
}

async function buildConversationOnlyResult({
  messages,
  historyMessages,
  transcript,
  assistantProfile,
  transcriptLogFields,
  route,
  sessionId,
  startedAt,
  signal,
  onContentDelta
}) {
  const promptMessages = applyTranscriptToMessages(
    mergeHistoryMessages(messages, historyMessages),
    transcript
  );
  const response = finalizeAssistantTexts(
    await generateAssistantContent(
      [
        {
          role: "system",
          content: buildConversationSystemPrompt(assistantProfile)
        },
        ...promptMessages
      ],
      { signal, onContentDelta }
    )
  );

  return completeResult({
    sessionId,
    userText: transcript.normalizedText,
    response,
    startedAt,
    logEntry: {
      kind: "no_rag",
      ...transcriptLogFields,
      needsRag: false,
      routeReason: route.reason,
      model: env.openAiModel
    },
    content: response.content
  });
}

async function buildNoEvidenceResult({
  messages,
  historyMessages,
  transcript,
  assistantProfile,
  transcriptLogFields,
  route,
  retrieval,
  retrievalQuery,
  sessionId,
  startedAt,
  signal,
  onContentDelta
}) {
  const response = finalizeAssistantTexts(
    await generateAssistantContent(
      [
        {
          role: "system",
          content: buildNoEvidenceFallbackPrompt(assistantProfile)
        },
        ...applyTranscriptToMessages(mergeHistoryMessages(messages, historyMessages), transcript)
      ],
      { signal, onContentDelta }
    ),
    { fallbackText: buildNoEvidenceResponse() }
  );
  const finalContent = `${response.content}\n\n出典:\nなし`;

  return completeResult({
    sessionId,
    userText: transcript.normalizedText,
    response,
    startedAt,
    logEntry: {
      kind: "rag_miss",
      ...transcriptLogFields,
      needsRag: true,
      routeReason: route.reason,
      ...buildRetrievalLogFields(retrieval, retrievalQuery),
      topHits: [],
      model: env.openAiModel,
      fallbackMode: "general_llm"
    },
    content: finalContent
  });
}

function buildRagPromptMessages(messages, historyMessages, transcript) {
  return applyTranscriptToMessages(
    mergeHistoryMessages(messages, historyMessages, {
      historyLimit: 4,
      followUpText: transcript.normalizedText
    }),
    transcript
  );
}

function toLoggedTopHits(topHits) {
  return topHits.map((item) => ({
    cq: item.cq || null,
    docType: item.docType || "cq",
    chapter: item.chapter || null,
    section: item.section || null,
    heading: item.heading || null,
    subheading: item.subheading || null,
    title: item.title || null,
    recommendation: item.recommendation || null,
    explanation: item.explanation || null,
    updatedAt: item.updatedAt || null,
    url: item.url || null,
    score: item.score,
    matchedTerms: item.matchedTerms || [],
    similarity: item.similarity || null,
    relatedCqs: item.relatedCqs || []
  }));
}

async function buildRetrievedAnswerResult({
  messages,
  historyMessages,
  transcript,
  assistantProfile,
  transcriptLogFields,
  route,
  retrieval,
  retrievalQuery,
  sessionId,
  startedAt,
  signal,
  onContentDelta
}) {
  const topHits = retrieval.hits;
  const systemPrompt = buildRagSystemPrompt({
    audience: "patient",
    ...assistantProfile
  });
  const context = buildRagContext(topHits);
  const response = finalizeAssistantTexts(
    await generateAssistantContent(
      [
        {
          role: "system",
          content: `${systemPrompt}\n\n以下のガイドライン断片だけを根拠に回答してください。\n番号の若い断片ほど関連度が高く、recommendation と explanation を優先して使ってください。\n\n${context}`
        },
        ...buildRagPromptMessages(messages, historyMessages, transcript),
        {
          role: "system",
          content: buildRagFinalCheckPrompt()
        }
      ],
      { temperature: 0, signal, onContentDelta }
    )
  );
  const finalContent = `${response.content}\n\n${formatSources(topHits)}`;

  return completeResult({
    sessionId,
    userText: transcript.normalizedText,
    response,
    startedAt,
    logEntry: {
      kind: "rag_hit",
      ...transcriptLogFields,
      needsRag: true,
      routeReason: route.reason,
      ...buildRetrievalLogFields(retrieval, retrievalQuery),
      topHits: toLoggedTopHits(topHits),
      model: env.openAiModel
    },
    content: finalContent
  });
}

async function buildAnswerResult(body = {}, { signal, onContentDelta } = {}) {
  const startedAt = Date.now();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userText = getLastUserMessage(messages);
  const sessionId = body?.metadata?.sessionId || getLatestBoundSessionId() || "unbound-session";
  const assistantProfile = getAssistantProfile();
  const historyMessages = maybeLoadConversation(sessionId);
  const ruleBasedTranscript = normalizeMedicalTranscript(userText, { historyMessages });
  const initialRoute = decideNeedRag(ruleBasedTranscript.normalizedText, { historyMessages });
  const transcript = shouldAttemptLlmTranscriptNormalization(
    ruleBasedTranscript,
    initialRoute,
    historyMessages
  )
    ? await maybeNormalizeTranscriptWithLlm(ruleBasedTranscript, {
        historyMessages,
        signal
      })
    : withSkippedLlmNormalization(ruleBasedTranscript);
  const transcriptLogFields = buildTranscriptLogFields(userText, ruleBasedTranscript, transcript);
  const route = decideNeedRag(transcript.normalizedText, { historyMessages });

  if (!env.ragEnabled) {
    const response = finalizeAssistantTexts(
      "現在はガイドライン参照機能が無効です。必要なら症状や経過を伺いながら、一般的な範囲でお話しします。"
    );
    const finalContent = `${response.content}\n\n出典:\nなし`;

    return completeResult({
      sessionId,
      userText: transcript.normalizedText,
      response,
      startedAt,
      logEntry: {
        kind: "rag_disabled",
        ...transcriptLogFields,
        needsRag: false,
        routeReason: "env_disabled"
      },
      content: finalContent
    });
  }

  if (!route.needsRag) {
    return buildConversationOnlyResult({
      messages,
      historyMessages,
      transcript,
      assistantProfile,
      transcriptLogFields,
      route,
      sessionId,
      startedAt,
      signal,
      onContentDelta
    });
  }

  const retrievalQuery = buildRetrievalQuery(transcript.normalizedText, historyMessages);
  const retrieval = await retrieveGuidelineChunks(retrievalQuery, env.ragTopK);
  const topHits = retrieval.hits;

  if (topHits.length === 0) {
    return buildNoEvidenceResult({
      messages,
      historyMessages,
      transcript,
      assistantProfile,
      transcriptLogFields,
      route,
      retrieval,
      retrievalQuery,
      sessionId,
      startedAt,
      signal,
      onContentDelta
    });
  }

  return buildRetrievedAnswerResult({
    messages,
    historyMessages,
    transcript,
    assistantProfile,
    transcriptLogFields,
    route,
    retrieval,
    retrievalQuery,
    sessionId,
    startedAt,
    signal,
    onContentDelta
  });
}

export async function answerUserText(userText, sessionId) {
  return buildAnswerResult(createChatCompletionBody(userText, sessionId));
}

export async function handleChatCompletion(body = {}) {
  return buildAnswerResult(body);
}

export async function streamChatCompletion(body = {}, { signal, onSpeechSegment = () => {} } = {}) {
  let pendingSpeechBuffer = "";
  let hasEmittedSpeechSegment = false;

  const result = await buildAnswerResult(body, {
    signal,
    onContentDelta: async (delta) => {
      pendingSpeechBuffer += delta;

      const { segments, remaining } = pullCompletedSpeechSegments(pendingSpeechBuffer);
      pendingSpeechBuffer = remaining;

      for (const segment of segments) {
        hasEmittedSpeechSegment = true;
        await onSpeechSegment(segment);
      }
    }
  });

  const trailingSegment = flushSpeechSegment(pendingSpeechBuffer);

  if (trailingSegment) {
    hasEmittedSpeechSegment = true;
    await onSpeechSegment(trailingSegment);
  }

  if (!hasEmittedSpeechSegment && result.speechContent) {
    await onSpeechSegment({
      speechText: result.speechContent,
      subtitleText: toSubtitleContent(result.content)
    });
  }

  return result;
}

export { toSpeechContent };
