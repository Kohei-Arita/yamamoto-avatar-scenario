import process from "node:process";
import dotenv from "dotenv";
import { updateLiveAvatarLlmConfiguration } from "../src/features/liveavatar/liveavatar-llm.service.js";

dotenv.config();

function readArg(name) {
  const prefix = `--${name}=`;
  const entry = process.argv.find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : "";
}

const configId = readArg("config-id") || process.env.LIVEAVATAR_LLM_CONFIGURATION_ID || "";
const url = readArg("url") || process.env.LIVEAVATAR_PUBLIC_BASE_URL || "";
const displayName = readArg("display-name");
const modelName = readArg("model-name");
const secretId = readArg("secret-id");

if (!process.env.LIVEAVATAR_API_KEY) {
  console.error("LIVEAVATAR_API_KEY is required.");
  process.exit(1);
}

if (!configId) {
  console.error(
    "Provide --config-id=<llm_configuration_id> or set LIVEAVATAR_LLM_CONFIGURATION_ID."
  );
  process.exit(1);
}

const updates = {};

if (url) {
  updates.url = url;
}

if (displayName) {
  updates.display_name = displayName;
}

if (modelName) {
  updates.model_name = modelName;
}

if (secretId) {
  updates.secret_id = secretId;
}

if (Object.keys(updates).length === 0) {
  console.error("Provide at least one update. Example: --url=https://<your-public-url>/v1");
  process.exit(1);
}

const config = await updateLiveAvatarLlmConfiguration(configId, updates);

console.log(
  JSON.stringify(
    {
      id: config.id || null,
      url: config.url || config.base_url || null,
      displayName: config.display_name || null,
      modelName: config.model_name || null,
      secretId: config.secret_id || null,
      raw: config
    },
    null,
    2
  )
);
