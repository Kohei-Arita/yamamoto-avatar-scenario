function ensureOk(response, data, message) {
  if (!response.ok || data?.ok === false) {
    throw new Error(`${message}: ${JSON.stringify(data)}`);
  }
}

function buildJsonRequestOptions(method, body, options = {}) {
  const requestOptions = {
    method,
    ...options
  };

  if (body === undefined) {
    return requestOptions;
  }

  return {
    ...requestOptions,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: JSON.stringify(body)
  };
}

function parseSseEventBlock(block) {
  const lines = String(block || "").split("\n");
  const dataLines = [];
  let event = "message";

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: dataLines.join("\n")
  };
}

async function fetchJson(url, options = {}) {
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch(url, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function requestJson(url, { errorMessage, ...options } = {}) {
  const { response, data } = await fetchJson(url, options);
  ensureOk(response, data, errorMessage);
  return data;
}

async function postJson(url, body, errorMessage, options = {}) {
  return requestJson(url, {
    ...buildJsonRequestOptions("POST", body, options),
    errorMessage
  });
}

export async function ensureMicrophoneAccess({
  unsupportedMessage = "This browser does not support microphone access."
} = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    const hostname = window.location.hostname;
    const origin = window.location.origin;
    const isLocalhostHost = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

    if (!window.isSecureContext) {
      if (hostname === "0.0.0.0") {
        throw new Error(
          `このページは ${origin} で開かれているため、ブラウザがマイク取得 API を無効化しています。Docker で起動していても、ブラウザでは \`http://localhost:${window.location.port || "3000"}\` を開いてください。`
        );
      }

      if (window.location.protocol !== "https:" && !isLocalhostHost) {
        throw new Error(
          `このページは ${origin} で開かれており secure context ではありません。マイク取得 API は HTTPS または localhost/127.0.0.1 でのみ使えます。`
        );
      }
    }

    throw new Error(unsupportedMessage);
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
}

export async function fetchLiveAvatarConfig(options = {}) {
  const data = await requestJson("/api/liveavatar/config", {
    ...options,
    errorMessage: "config fetch failed"
  });
  return data.config || null;
}

export async function respondWithDialogueStream(
  sessionId,
  text,
  { signal, revision = false, expectedVersion, expectedEpoch, onEvent = () => {} } = {}
) {
  const response = await fetch("/api/dialogue/respond/stream", {
    method: "POST",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(25_000)])
      : AbortSignal.timeout(25_000),
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ sessionId, text, revision, expectedVersion, expectedEpoch })
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    ensureOk(response, data, "dialogue stream failed");
  }

  if (!response.body) {
    throw new Error("dialogue stream body missing");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult = null;
  let streamError = null;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r/g, "");

    while (true) {
      const boundary = buffer.indexOf("\n\n");

      if (boundary < 0) {
        break;
      }

      const parsedEvent = parseSseEventBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);

      if (!parsedEvent) {
        continue;
      }

      const data = (() => {
        try {
          return JSON.parse(parsedEvent.data);
        } catch {
          return { raw: parsedEvent.data };
        }
      })();

      await onEvent({ type: parsedEvent.event, data });

      if (parsedEvent.event === "done") {
        finalResult = data;
      }

      if (parsedEvent.event === "error") {
        streamError = new Error(data.error || "dialogue stream failed");
      }
    }

    if (done) {
      break;
    }
  }

  if (streamError) {
    throw streamError;
  }

  if (!finalResult) {
    throw new Error("dialogue stream ended without a final result");
  }

  return finalResult;
}

export async function bindDialogueSession(sessionId, options = {}) {
  if (!sessionId) {
    return null;
  }

  return postJson("/api/dialogue/session", { sessionId }, "dialogue session bind failed", options);
}

export function pauseDialogueInput(sessionId, expectedVersion, { expectedEpoch, ...options } = {}) {
  return postJson(
    "/api/dialogue/input-timeout",
    { sessionId, expectedVersion, expectedEpoch },
    "音声入力の停止状態を同期できませんでした。操作係の再発話または入力停止・再開で復帰してください",
    options
  );
}

export function reportPlaybackState(sessionId, status, options = {}) {
  return postJson(
    "/api/dialogue/playback",
    { sessionId, ...status },
    "会場音声の状態を同期できませんでした",
    options
  );
}

// オペレーター操作(分岐選択・強制送り・再発話)で確定した医師セリフを
// サーバーからpush受信するためのSSEチャンネル。
export function subscribeDialogueEvents(
  sessionId,
  { epoch, onSpeechSegment = () => {}, onState = () => {}, onConnectionChange = () => {} } = {}
) {
  const source = new EventSource(
    `/api/dialogue/events?sessionId=${encodeURIComponent(sessionId || "")}&epoch=${encodeURIComponent(epoch || "")}`
  );

  source.addEventListener("connected", (event) => {
    const data = JSON.parse(event.data);
    onConnectionChange(true, data);
  });
  source.addEventListener("scenario_state", (event) => onState(JSON.parse(event.data).state));
  source.addEventListener("error", () => onConnectionChange(false));

  source.addEventListener("speech_segment", (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data?.speechText || data?.text) {
      onSpeechSegment({
        speechId: data.speechId,
        segmentIndex: data.segmentIndex,
        segmentCount: data.segmentCount,
        state: data.state,
        replace: data.replace,
        speechText: data.speechText || data.text || "",
        subtitleText: data.subtitleText || data.speechText || data.text || ""
      });
    }
  });

  return source;
}

export async function createLiveAvatarSessionToken(options = {}) {
  return postJson(
    "/api/liveavatar/session-token",
    undefined,
    "session token creation failed",
    options
  );
}

export async function startLiveAvatarSession(sessionToken, options = {}) {
  const data = await postJson(
    "/api/liveavatar/start-session",
    { sessionToken },
    "session start failed",
    options
  );

  if (!data.livekit_url || !data.livekit_token) {
    throw new Error(`Missing LiveKit connection info: ${JSON.stringify(data.raw || data)}`);
  }

  return data;
}

export function keepLiveAvatarSessionAlive(sessionId, options = {}) {
  return postJson(
    "/api/liveavatar/keep-alive",
    { sessionId },
    "session keep-alive failed",
    options
  );
}

export async function stopLiveAvatarSession(sessionToken) {
  if (!sessionToken) {
    return null;
  }

  return postJson("/api/liveavatar/stop-session", { sessionToken }, "session stop failed");
}

function attachExistingTracks(room, attachTrack) {
  room.remoteParticipants.forEach((participant) => {
    participant.trackPublications.forEach((publication) => {
      if (publication.isSubscribed && publication.track) {
        attachTrack(publication.track, publication, participant);
      }
    });
  });
}

export async function connectLiveKitRoom({
  Room,
  RoomEvent,
  livekitUrl,
  livekitToken,
  attachTrack,
  onConnected = () => {},
  onDisconnected = () => {},
  onTrackSubscribed = () => {},
  onTrackUnsubscribed = () => {},
  onDataReceived = () => {},
  onParticipantConnected = () => {},
  onParticipantDisconnected = () => {},
  onRoomCreated = () => {},
  audioCaptureDefaults = {},
  signal
}) {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      channelCount: 1,
      ...audioCaptureDefaults
    }
  });
  onRoomCreated(room);

  room.on(RoomEvent.Connected, () => {
    onConnected(room);
  });

  room.on(RoomEvent.Disconnected, (reason) => {
    onDisconnected(reason, room);
  });

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    onTrackSubscribed(track, publication, participant);
    attachTrack(track, publication, participant);
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    onTrackUnsubscribed(track, publication, participant);
  });

  room.on(RoomEvent.DataReceived, onDataReceived);
  room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
  room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);

  try {
    signal?.throwIfAborted();
    await room.connect(livekitUrl, livekitToken);
    signal?.throwIfAborted();
    attachExistingTracks(room, attachTrack);
    // マイクは台本・発話・進行チャンネルの準備が整ってから会話コントローラーが開く。
    return room;
  } catch (error) {
    await room.disconnect();
    throw error;
  }
}
