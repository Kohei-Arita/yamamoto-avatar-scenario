import app from "./app.js";
import env, { assertRuntimeConfig } from "./config/env.js";
import { getScenario } from "./features/scenario/scenario-loader.js";

assertRuntimeConfig();
getScenario();

const SHUTDOWN_TIMEOUT_MS = 10_000;

const server = app.listen(env.port, env.host, () => {
  const browserUrl =
    env.host === "0.0.0.0" ? `http://localhost:${env.port}` : `http://${env.host}:${env.port}`;

  console.log(`Server listening on http://${env.host}:${env.port}`);

  if (browserUrl !== `http://${env.host}:${env.port}`) {
    console.log(`Open ${browserUrl} in your browser`);
  }
});

function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forceful shutdown after timeout.");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled_rejection", reason);
});
