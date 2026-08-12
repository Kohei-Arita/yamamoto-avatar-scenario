const ADVANCE_TYPES = new Set(["patient_any", "patient_intent", "operator", "auto"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateAdvanceEntry(entry, nodeId, index, errors) {
  const label = `nodes[${nodeId}].advance[${index}]`;

  if (!entry || typeof entry !== "object") {
    errors.push(`${label} はオブジェクトである必要があります`);
    return;
  }

  if (!ADVANCE_TYPES.has(entry.type)) {
    errors.push(`${label}.type が不正です: ${entry.type}`);
    return;
  }

  if (!isNonEmptyString(entry.next)) {
    errors.push(`${label}.next は必須です`);
  }

  if (entry.type === "patient_intent") {
    if (!isNonEmptyString(entry.intent)) {
      errors.push(`${label}.intent は必須です`);
    }

    if (!Array.isArray(entry.keywords) || entry.keywords.some((k) => !isNonEmptyString(k))) {
      errors.push(`${label}.keywords は文字列の配列である必要があります`);
    }
  }

  if (entry.type === "operator" && !isNonEmptyString(entry.branch)) {
    errors.push(`${label}.branch は必須です`);
  }
}

function validateNode(node, index, errors) {
  const label = `nodes[${index}]`;

  if (!node || typeof node !== "object") {
    errors.push(`${label} はオブジェクトである必要があります`);
    return;
  }

  if (!isNonEmptyString(node.id)) {
    errors.push(`${label}.id は必須です`);
  }

  if (!Number.isInteger(node.scene)) {
    errors.push(`${label}.scene は整数である必要があります`);
  }

  if (
    !Array.isArray(node.doctorLines) ||
    node.doctorLines.length === 0 ||
    node.doctorLines.some((line) => !isNonEmptyString(line))
  ) {
    errors.push(`${label}.doctorLines は空でない文字列の配列である必要があります`);
  }

  if (!Array.isArray(node.advance)) {
    errors.push(`${label}.advance は配列である必要があります`);
    return;
  }

  node.advance.forEach((entry, advanceIndex) =>
    validateAdvanceEntry(entry, node.id || index, advanceIndex, errors)
  );
}

export function validateScenario(scenario) {
  const errors = [];

  if (!scenario || typeof scenario !== "object") {
    return { valid: false, errors: ["シナリオはオブジェクトである必要があります"] };
  }

  if (!isNonEmptyString(scenario.id)) {
    errors.push("id は必須です");
  }

  if (!isNonEmptyString(scenario.title)) {
    errors.push("title は必須です");
  }

  if (!Array.isArray(scenario.nodes) || scenario.nodes.length === 0) {
    errors.push("nodes は空でない配列である必要があります");
    return { valid: false, errors };
  }

  scenario.nodes.forEach((node, index) => validateNode(node, index, errors));

  const nodeIds = new Set();

  for (const node of scenario.nodes) {
    if (node?.id) {
      if (nodeIds.has(node.id)) {
        errors.push(`ノードIDが重複しています: ${node.id}`);
      }

      nodeIds.add(node.id);
    }
  }

  for (const node of scenario.nodes) {
    for (const entry of Array.isArray(node?.advance) ? node.advance : []) {
      if (isNonEmptyString(entry?.next) && !nodeIds.has(entry.next)) {
        errors.push(
          `nodes[${node.id}].advance の next が未定義のノードを参照しています: ${entry.next}`
        );
      }
    }
  }

  if (!isNonEmptyString(scenario.entryNode)) {
    errors.push("entryNode は必須です");
  } else if (!nodeIds.has(scenario.entryNode)) {
    errors.push(`entryNode が未定義のノードを参照しています: ${scenario.entryNode}`);
  }

  if (
    scenario.globalDeviationReplies !== undefined &&
    (typeof scenario.globalDeviationReplies !== "object" ||
      scenario.globalDeviationReplies === null ||
      Object.values(scenario.globalDeviationReplies).some((value) => !isNonEmptyString(value)))
  ) {
    errors.push("globalDeviationReplies は文字列値のオブジェクトである必要があります");
  }

  return { valid: errors.length === 0, errors };
}
