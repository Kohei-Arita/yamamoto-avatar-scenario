import { writeSseEvent } from "../../shared/http/sse.js";

const subscribersBySession = new Map();
const HEARTBEAT_INTERVAL_MS = 25_000;

export function subscribeDialogueEvents(sessionId, res, state, openingSegments = []) {
  const key = sessionId || "unbound-session";

  if (!subscribersBySession.has(key)) {
    subscribersBySession.set(key, new Set());
  }

  const subscribers = subscribersBySession.get(key);
  subscribers.add(res);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, HEARTBEAT_INTERVAL_MS);

  res.on("close", () => {
    clearInterval(heartbeat);
    subscribers.delete(res);

    if (subscribers.size === 0) {
      subscribersBySession.delete(key);
    }
  });

  writeSseEvent(res, "connected", { ok: true, sessionId: key, state, openingSegments });
}

export function broadcastSpeechSegments(sessionId, segments = [], state) {
  const key = sessionId || "unbound-session";
  const subscribers = subscribersBySession.get(key);

  if (!subscribers || subscribers.size === 0) {
    return 0;
  }

  for (const res of subscribers) {
    for (const [index, segment] of segments.entries()) {
      writeSseEvent(res, "speech_segment", {
        speechId: segment.speechId,
        segmentIndex: segment.segmentIndex,
        segmentCount: segment.segmentCount,
        state,
        replace: index === 0,
        text: segment.speechText || "",
        speechText: segment.speechText || "",
        subtitleText: segment.subtitleText || segment.speechText || ""
      });
    }
  }

  return subscribers.size;
}

export function broadcastScenarioState(sessionId, state) {
  const subscribers = subscribersBySession.get(sessionId || "unbound-session");
  for (const res of subscribers || []) {
    writeSseEvent(res, "scenario_state", { state });
  }
  return subscribers?.size || 0;
}

export function countDialogueEventSubscribers(sessionId) {
  return subscribersBySession.get(sessionId || "unbound-session")?.size || 0;
}
