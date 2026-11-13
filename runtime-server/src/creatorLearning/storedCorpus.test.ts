import assert from "node:assert/strict";
import test from "node:test";
import { corpusOutputSchema, parseStoredCorpus } from "./corpusNode.js";

const stored = {
  system_instructions: "x".repeat(10),
  skills: [],
  tools: [{ id: "creator.readdir", kind: "mcp_tool", connection_ref: "nas_gateway_1", tool_name: "readdir" }],
  knowledge: { documents: [] }
};

test("a corpus published before the knowledge layer was retired still reads", () => {
  assert.throws(() => corpusOutputSchema.parse(stored));
  const corpus = parseStoredCorpus(stored);
  assert.equal(corpus.tools[0]?.id, "creator.readdir");
  assert.equal("knowledge" in corpus, false);
});

test("stored corpora are still strict about anything else", () => {
  assert.throws(() => parseStoredCorpus({ ...stored, unexpected: true }));
});
