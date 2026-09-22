import { Router } from "express";
import {
  getOperatorState,
  postOperatorBranch,
  postOperatorJump,
  postOperatorNext,
  postOperatorReset,
  postOperatorSay,
  postOperatorInput,
  requireOperatorToken
} from "./operator.controller.js";

const router = Router();

router.use("/api/operator", requireOperatorToken);

router.get("/api/operator/state", getOperatorState);
router.post("/api/operator/branch", postOperatorBranch);
router.post("/api/operator/next", postOperatorNext);
router.post("/api/operator/jump", postOperatorJump);
router.post("/api/operator/reset", postOperatorReset);
router.post("/api/operator/say", postOperatorSay);
router.post("/api/operator/input", postOperatorInput);

export default router;
