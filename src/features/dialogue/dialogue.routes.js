import { Router } from "express";
import {
  getDialogueEventsController,
  getDialogueLogsController,
  postBindDialogueSession,
  postChatCompletions,
  postRespondWithDialogue,
  postRespondWithDialogueStream
} from "./dialogue.controller.js";

const router = Router();

const loggedDeprecations = new Set();

function withDeprecationLog(oldPath, newPath, handler) {
  return (req, res, next) => {
    if (!loggedDeprecations.has(oldPath)) {
      loggedDeprecations.add(oldPath);
      console.warn("[dialogue] deprecated_route", JSON.stringify({ oldPath, use: newPath }));
    }

    return handler(req, res, next);
  };
}

router.get("/api/dialogue/logs", getDialogueLogsController);
router.get("/api/dialogue/events", getDialogueEventsController);
router.post("/api/dialogue/session", postBindDialogueSession);
router.post("/api/dialogue/respond", postRespondWithDialogue);
router.post("/api/dialogue/respond/stream", postRespondWithDialogueStream);

// 旧 /api/rag/* 互換alias(ブラウザ改修最小化のため維持)
router.get(
  "/api/rag/logs",
  withDeprecationLog("/api/rag/logs", "/api/dialogue/logs", getDialogueLogsController)
);
router.post(
  "/api/rag/session",
  withDeprecationLog("/api/rag/session", "/api/dialogue/session", postBindDialogueSession)
);
router.post(
  "/api/rag/respond",
  withDeprecationLog("/api/rag/respond", "/api/dialogue/respond", postRespondWithDialogue)
);
router.post(
  "/api/rag/respond/stream",
  withDeprecationLog(
    "/api/rag/respond/stream",
    "/api/dialogue/respond/stream",
    postRespondWithDialogueStream
  )
);

router.post("/v1/chat/completions", postChatCompletions);

export default router;
