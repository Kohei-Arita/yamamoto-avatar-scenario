import process from "node:process";
import dotenv from "dotenv";
import { getLiveAvatarLlmConfiguration } from "../src/features/liveavatar/liveavatar-llm.service.js";

dotenv.config();

function readArg(name) {
  const prefix = `--${name}=`;
  const entry = process.argv.find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : "";
}

const configId = readArg("config-id") || process.env.LIVEAVATAR_LLM_CONFIGURATION_ID || "";

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

const config = await getLiveAvatarLlmConfiguration(configId);

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
