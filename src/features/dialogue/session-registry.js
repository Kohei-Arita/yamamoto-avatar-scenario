// このサーバーが発行したLiveAvatarセッションIDの登録簿。
// 対話API(bind/respond)は、登録済みセッションIDのみ受け付けることで、
// 公開URLへの野良リクエストで台本が進行してしまう事故を防ぐ。
// 未指定ID・未登録IDは、起動直後も拒否する。認証は別の共通ミドルウェアで行う。

const MAX_KNOWN_SESSIONS = 50;

const knownSessionIds = new Set();

export function isRegisteredSessionId(sessionId) {
  return Boolean(sessionId) && knownSessionIds.has(sessionId);
}

export function registerKnownSessionId(sessionId) {
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId)) {
    return;
  }

  knownSessionIds.add(sessionId);

  while (knownSessionIds.size > MAX_KNOWN_SESSIONS) {
    const oldest = knownSessionIds.values().next().value;
    knownSessionIds.delete(oldest);
  }
}

export function isAllowedDialogueSession(sessionId) {
  return isRegisteredSessionId(sessionId);
}
