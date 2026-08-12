import { Router } from "express";
import {
  getRagLogsController,
  postBindRagSession,
  postRespondWithRag,
  postRespondWithRagStream,
  postChatCompletions
} from "./rag.controller.js";

const router = Router();

router.get("/api/rag/logs", getRagLogsController);
router.post("/api/rag/session", postBindRagSession);
router.post("/api/rag/respond", postRespondWithRag);
router.post("/api/rag/respond/stream", postRespondWithRagStream);
router.post("/v1/chat/completions", postChatCompletions);

export default router;
