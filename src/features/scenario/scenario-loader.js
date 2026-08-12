import fs from "node:fs";
import path from "node:path";
import env from "../../config/env.js";
import { validateScenario } from "./scenario-schema.js";

let cachedScenario = null;

export function loadScenarioFromFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const scenario = JSON.parse(raw);
  const { valid, errors } = validateScenario(scenario);

  if (!valid) {
    throw new Error(`シナリオ定義が不正です (${filePath}):\n- ${errors.join("\n- ")}`);
  }

  return scenario;
}

export function getScenario({ reload = false } = {}) {
  if (cachedScenario && !reload) {
    return cachedScenario;
  }

  const filePath = path.resolve(env.scenarioDir, `${env.scenarioId}.json`);
  cachedScenario = loadScenarioFromFile(filePath);

  console.log(
    "[scenario] loaded",
    JSON.stringify({
      id: cachedScenario.id,
      nodeCount: cachedScenario.nodes.length,
      entryNode: cachedScenario.entryNode
    })
  );

  return cachedScenario;
}

export function getScenarioOpeningGreeting() {
  const scenario = getScenario();
  const entryNode = scenario.nodes.find((node) => node.id === scenario.entryNode);
  return (entryNode?.doctorLines || []).join("");
}
