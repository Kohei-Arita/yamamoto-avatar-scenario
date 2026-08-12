import process from "node:process";
import dotenv from "dotenv";
import {
  createLiveAvatarLlmConfiguration,
  createLiveAvatarSecret
} from "../src/features/liveavatar/liveavatar-llm.service.js";

dotenv.config();

function readArg(name) {
  const prefix = `--${name}=`;
  const entry = process.argv.find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : "";
}

const baseUrl = readArg("base-url") || process.env.LIVEAVATAR_PUBLIC_BASE_URL || "";
const secretName = readArg("secret-name") || "yamamotoavator-demo-rag-endpoint";
const displayName = readArg("display-name") || "yamamotoavator-demo-rag";
const modelName = readArg("model-name") || process.env.OPENAI_MODEL || "gpt-4.1-mini";
const secretValue = process.env.RAG_ENDPOINT_API_KEY || "";

if (!process.env.LIVEAVATAR_API_KEY) {
  console.error("LIVEAVATAR_API_KEY is required.");
  process.exit(1);
}

if (!baseUrl) {
  console.error("Provide --base-url=<https://...> or set LIVEAVATAR_PUBLIC_BASE_URL.");
  process.exit(1);
}

if (!secretValue) {
  console.error(
    "RAG_ENDPOINT_API_KEY is required so LiveAvatar can authenticate to /v1/chat/completions."
  );
  process.exit(1);
}

const secret = await createLiveAvatarSecret({
  secretName,
  secretValue
});
const llmConfig = await createLiveAvatarLlmConfiguration({
  baseUrl,
  displayName,
  modelName,
  secretId: secret.id
});

console.log(
  JSON.stringify(
    {
      secretId: secret.id,
      llmConfigurationId: llmConfig.id,
      baseUrl,
      env: {
        LIVEAVATAR_PUBLIC_BASE_URL: baseUrl,
        LIVEAVATAR_LLM_CONFIGURATION_ID: llmConfig.id,
        RAG_ENDPOINT_API_KEY: secretValue
      }
    },
    null,
    2
  )
);
