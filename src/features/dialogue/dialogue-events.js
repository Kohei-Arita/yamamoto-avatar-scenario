const subscribersBySession = new Map();
const HEARTBEAT_INTERVAL_MS = 25_000;

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function subscribeDialogueEvents(sessionId, res) {
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

  writeSseEvent(res, "connected", { ok: true, sessionId: key });
}

export function broadcastSpeechSegments(sessionId, segments = []) {
  const key = sessionId || "unbound-session";
  const subscribers = subscribersBySession.get(key);

  if (!subscribers || subscribers.size === 0) {
    return 0;
  }

  for (const res of subscribers) {
    for (const segment of segments) {
      writeSseEvent(res, "speech_segment", {
        text: segment.speechText || "",
        speechText: segment.speechText || "",
        subtitleText: segment.subtitleText || segment.speechText || ""
      });
    }
  }

  return subscribers.size;
}

export function countDialogueEventSubscribers(sessionId) {
  return subscribersBySession.get(sessionId || "unbound-session")?.size || 0;
}
