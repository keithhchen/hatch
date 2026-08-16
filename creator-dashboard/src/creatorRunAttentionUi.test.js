import assert from "node:assert/strict";
import test from "node:test";
import {
  runAttentionAction,
  runAttentionError,
  runNeedsAttention
} from "./creatorRunAttentionUi.js";

test("needs-attention UI preserves the server failure and retry capability", () => {
  const run = {
    status: "needs_attention",
    stage: "needs_attention",
    retryable: true,
    last_error: "Corpus completeness audit failed"
  };
  assert.equal(runNeedsAttention(run), true);
  assert.equal(runAttentionError(run), "Corpus completeness audit failed");
  assert.equal(runAttentionAction(run), "retry");
});

test("stage-only attention state cannot fall through to an empty About You or Review state", () => {
  const run = { status: "ready", stage: "needs_attention", retryable: false, last_error: "Source material is incomplete" };
  assert.equal(runNeedsAttention(run), true);
  assert.equal(runAttentionAction(run), "add_sources");
  assert.equal(runAttentionError(run), "Source material is incomplete");
  assert.equal(runNeedsAttention({ status: "queued", stage: "extracting_evidence" }), false);
});

test("a retry in progress is not rendered as the previous attention state", () => {
  const run = {
    status: "running",
    stage: "needs_attention",
    retryable: false,
    last_error: "The previous attempt failed"
  };
  assert.equal(runNeedsAttention(run), false);
  assert.equal(runAttentionAction(run), null);
});
