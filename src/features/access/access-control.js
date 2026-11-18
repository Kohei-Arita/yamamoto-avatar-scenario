import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import env from "../../config/env.js";

const COOKIE_NAME = "stage_access";
const LIFETIME_MS = 12 * 60 * 60 * 1000;
const failures = new Map();

function equalSecret(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hasOperatorToken(req) {
  return (
    Boolean(env.operatorToken) &&
    equalSecret(req.headers.authorization, `Bearer ${env.operatorToken}`)
  );
}

function signature(value) {
  return createHmac("sha256", env.operatorToken)
    .update(`stage-access:${value}`)
    .digest("base64url");
}

export function hasApplicationAccess(req) {
  if (!env.operatorToken) return false;
  if (hasOperatorToken(req)) return true;
  const cookie = String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  const [expires, mac, extra] = (cookie || "").split(".");
  const expiresAt = Number(expires);
  return (
    !extra &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() &&
    expiresAt <= Date.now() + LIFETIME_MS &&
    equalSecret(mac, signature(expires))
  );
}

function isSameOrigin(req) {
  if (req.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.get("origin");
  if (!origin) return true; // CLIはBearerで認証。ブラウザのCookieはSameSite=Strict。
  try {
    return new URL(origin).host === req.get("host");
  } catch {
    return false;
  }
}

export function requireApplicationAccess(req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  if (!env.operatorToken)
    return res
      .status(503)
      .json({ ok: false, error: "OPERATOR_TOKEN is not configured on the server" });
  if (!isSameOrigin(req))
    return res.status(403).json({ ok: false, error: "Cross-origin access is not allowed" });
  if (!hasApplicationAccess(req))
    return res
      .status(401)
      .json({ ok: false, error: "会場画面の認証が必要です。/access から接続してください。" });
  return next();
}

export function requireStageAccess(req, res, next) {
  if (hasApplicationAccess(req)) return next();
  const target = new URL(req.originalUrl, "http://local.invalid");
  if (target.searchParams.has("optoken")) target.searchParams.set("shortcuts", "1");
  target.searchParams.delete("optoken");
  return res.redirect(`/access?next=${encodeURIComponent(target.pathname + target.search)}`);
}

const router = Router();
router.post("/api/access", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!env.operatorToken)
    return res.status(503).json({ ok: false, error: "OPERATOR_TOKENを設定してください。" });
  if (!isSameOrigin(req))
    return res.status(403).json({ ok: false, error: "Cross-origin access is not allowed" });
  const now = Date.now();
  for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
  const key = req.ip;
  const recent = failures.get(key) || { count: 0, until: now + 60_000 };
  if (recent.count >= 10) {
    res.setHeader("Retry-After", String(Math.ceil((recent.until - now) / 1000)));
    return res
      .status(429)
      .json({ ok: false, error: "認証を繰り返し失敗しました。1分後にお試しください。" });
  }
  if (!equalSecret(req.body?.token, env.operatorToken)) {
    recent.count += 1;
    failures.set(key, recent);
    if (failures.size > 1000) failures.delete(failures.keys().next().value);
    return res.status(401).json({ ok: false, error: "トークンが正しくありません。" });
  }
  failures.delete(key);
  const expires = String(now + LIFETIME_MS);
  res.cookie(COOKIE_NAME, `${expires}.${signature(expires)}`, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: LIFETIME_MS,
    secure: req.secure || req.get("x-forwarded-proto") === "https"
  });
  return res.json({ ok: true });
});

export default router;
