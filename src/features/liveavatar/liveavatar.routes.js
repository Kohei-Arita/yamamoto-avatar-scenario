import { Router } from "express";
import {
  getLiveAvatarConfig,
  postSessionToken,
  postStartSession,
  postStopSession
} from "./liveavatar.controller.js";

const router = Router();

router.get("/liveavatar/config", getLiveAvatarConfig);
router.post("/liveavatar/session-token", postSessionToken);
router.post("/liveavatar/start-session", postStartSession);
router.post("/liveavatar/stop-session", postStopSession);

export default router;
