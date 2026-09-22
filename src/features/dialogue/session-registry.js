// このサーバーが発行したLiveAvatarセッションIDの登録簿。
// 対話API(bind/respond)は、登録済みセッションIDのみ受け付けることで、
// 公開URLへの野良リクエストで台本が進行してしまう事故を防ぐ。
// 一度もセッションを発行していない状態(ローカル開発・テスト)では制限しない。

const MAX_KNOWN_SESSIONS = 50;

const knownSessionIds = new Set();

export function isRegisteredSessionId(sessionId) {
  return Boolean(sessionId) && knownSessionIds.has(sessionId);
}

export function registerKnownSessionId(sessionId) {
  if (!sessionId) {
    return;
  }

  knownSessionIds.add(sessionId);

  while (knownSessionIds.size > MAX_KNOWN_SESSIONS) {
    const oldest = knownSessionIds.values().next().value;
    knownSessionIds.delete(oldest);
  }
}

export function isAllowedDialogueSession(sessionId) {
  // sessionId未指定はサーバー側で直近のbind済みセッションへフォールバックされる
  // 正常系のため拒否しない。拒否するのは「明示的に指定された未知のID」のみ。
  if (!sessionId) {
    return true;
  }

  if (knownSessionIds.size === 0) {
    return true;
  }

  return knownSessionIds.has(sessionId);
}
