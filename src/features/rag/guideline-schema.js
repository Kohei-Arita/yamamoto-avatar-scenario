const REQUIRED_STRING_FIELDS = [
  "id",
  "version",
  "part",
  "chapter",
  "section",
  "title",
  "explanation",
  "url",
  "updatedAt",
  "sourceType"
];

const OPTIONAL_STRING_FIELDS = [
  "cq",
  "question",
  "recommendation",
  "recommendationStrength",
  "evidenceGrade",
  "heading",
  "subheading"
];

const VALID_DOC_TYPES = new Set(["cq", "souron", "meta"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateGuidelineChunk(chunk) {
  const errors = [];
  const docType = typeof chunk?.docType === "string" && chunk.docType ? chunk.docType : "cq";

  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
    return ["Chunk must be an object."];
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(chunk[field])) {
      errors.push(`${field} must be a non-empty string.`);
    }
  }

  if (!VALID_DOC_TYPES.has(docType)) {
    errors.push(`docType must be one of: ${[...VALID_DOC_TYPES].join(", ")}.`);
  }

  for (const field of OPTIONAL_STRING_FIELDS) {
    if (chunk[field] !== undefined && chunk[field] !== null && typeof chunk[field] !== "string") {
      errors.push(`${field} must be a string when provided.`);
    }
  }

  if (docType === "cq") {
    for (const field of [
      "cq",
      "question",
      "recommendation",
      "recommendationStrength",
      "evidenceGrade"
    ]) {
      if (!isNonEmptyString(chunk[field])) {
        errors.push(`${field} must be a non-empty string for CQ chunks.`);
      }
    }
  }

  if (!Array.isArray(chunk.tags)) {
    errors.push("tags must be an array.");
  } else if (chunk.tags.some((tag) => !isNonEmptyString(tag))) {
    errors.push("tags must contain only non-empty strings.");
  }

  if (chunk.relatedCqs !== undefined) {
    if (!Array.isArray(chunk.relatedCqs)) {
      errors.push("relatedCqs must be an array when provided.");
    } else if (chunk.relatedCqs.some((cq) => !isNonEmptyString(cq))) {
      errors.push("relatedCqs must contain only non-empty strings.");
    }
  }

  if (chunk.priority !== undefined && !Number.isFinite(chunk.priority)) {
    errors.push("priority must be a finite number when provided.");
  }

  if (typeof chunk.hasTable !== "boolean") {
    errors.push("hasTable must be a boolean.");
  }

  if (typeof chunk.hasFigure !== "boolean") {
    errors.push("hasFigure must be a boolean.");
  }

  return errors;
}
