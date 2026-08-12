import test from "node:test";
import assert from "node:assert/strict";
import { generateAssistantContent } from "./openai-client.js";

const encoder = new TextEncoder();

function createJsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return payload;
    }
  };
}

test("falls back to non-stream completion when streaming fails before any delta", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount += 1;

    if (callCount === 1) {
      return {
        ok: true,
        body: {
          getReader() {
            return {
              async read() {
                throw new Error("stream failed before content");
              }
            };
          }
        }
      };
    }

    return createJsonResponse({
      choices: [
        {
          message: {
            content: "フォールバック応答"
          }
        }
      ]
    });
  };

  try {
    const content = await generateAssistantContent([{ role: "user", content: "テスト" }], {
      onContentDelta: async () => {}
    });

    assert.equal(content, "フォールバック応答");
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not fall back to non-stream completion after a delta was already delivered", async () => {
  const originalFetch = globalThis.fetch;
  const receivedDeltas = [];
  let readCount = 0;
  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;

    return {
      ok: true,
      body: {
        getReader() {
          return {
            async read() {
              readCount += 1;

              if (readCount === 1) {
                return {
                  done: false,
                  value: encoder.encode('data: {"choices":[{"delta":{"content":"途中"}}]}\n\n')
                };
              }

              throw new Error("stream interrupted");
            }
          };
        }
      }
    };
  };

  try {
    await assert.rejects(
      generateAssistantContent([{ role: "user", content: "テスト" }], {
        onContentDelta: async (delta) => {
          receivedDeltas.push(delta);
        }
      }),
      /stream interrupted/u
    );

    assert.deepEqual(receivedDeltas, ["途中"]);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
