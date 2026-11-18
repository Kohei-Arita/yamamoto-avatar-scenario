import { Router } from "express";
import {
  getDialogueEventsController,
  getDialogueLogsController,
  postBindDialogueSession,
  postInputTimeout,
  postPlaybackState,
  postRespondWithDialogue,
  postRespondWithDialogueStream
} from "./dialogue.controller.js";

const router = Router();

router.get("/api/dialogue/logs", getDialogueLogsController);
router.get("/api/dialogue/events", getDialogueEventsController);
router.post("/api/dialogue/session", postBindDialogueSession);
router.post("/api/dialogue/input-timeout", postInputTimeout);
router.post("/api/dialogue/playback", postPlaybackState);
router.post("/api/dialogue/respond", postRespondWithDialogue);
router.post("/api/dialogue/respond/stream", postRespondWithDialogueStream);

export default router;
