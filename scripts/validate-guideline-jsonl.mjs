import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { validateGuidelineChunk } from "../src/features/rag/guideline-schema.js";

const inputPath = process.argv[2];

if (!inputPath) {
  console.error("Usage: node scripts/validate-guideline-jsonl.mjs <jsonl-path>");
  process.exit(1);
}

const absolutePath = path.resolve(inputPath);
const raw = await fs.readFile(absolutePath, "utf-8");
const lines = raw
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const errors = [];

lines.forEach((line, index) => {
  let parsed;

  try {
    parsed = JSON.parse(line);
  } catch (error) {
    errors.push(`Line ${index + 1}: invalid JSON (${error.message})`);
    return;
  }

  for (const issue of validateGuidelineChunk(parsed)) {
    errors.push(`Line ${index + 1}: ${issue}`);
  }
});

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Validated ${lines.length} guideline chunks: ${absolutePath}`);
