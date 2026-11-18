import { Router } from "express";
import {
  getLiveAvatarConfig,
  postSessionToken,
  postStartSession,
  postStopSession,
  postKeepAlive
} from "./liveavatar.controller.js";

const router = Router();

router.get("/liveavatar/config", getLiveAvatarConfig);
router.post("/liveavatar/session-token", postSessionToken);
router.post("/liveavatar/start-session", postStartSession);
router.post("/liveavatar/stop-session", postStopSession);
router.post("/liveavatar/keep-alive", postKeepAlive);

export default router;
