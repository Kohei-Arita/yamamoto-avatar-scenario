import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import healthRoutes from "./features/health/health.routes.js";
import liveAvatarRoutes from "./features/liveavatar/liveavatar.routes.js";
import dialogueRoutes from "./features/dialogue/dialogue.routes.js";
import operatorRoutes from "./features/operator/operator.routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const app = express();

app.use(cors());
app.use(express.json());
app.use(
  express.static(path.join(projectRoot, "public"), {
    index: false
  })
);
app.use(
  "/vendor/livekit-client",
  express.static(path.join(projectRoot, "node_modules", "livekit-client", "dist"))
);

app.use("/api", healthRoutes);
app.use("/api", liveAvatarRoutes);
app.use(dialogueRoutes);
app.use(operatorRoutes);

app.get("/xgate", (req, res) => {
  res.sendFile(path.join(projectRoot, "public", "xgate.html"));
});

app.get("/operator", (req, res) => {
  res.sendFile(path.join(projectRoot, "public", "operator.html"));
});

app.get("*", (req, res) => {
  res.redirect("/xgate");
});

app.use((err, req, res, next) => {
  console.error(
    "[server] unhandled_error",
    JSON.stringify({
      method: req.method,
      path: req.path,
      message: err.message
    })
  );

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({ ok: false, error: "Internal server error" });
});

export default app;
