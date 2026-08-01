#!/usr/bin/env node
/**
 * Turn a real Runtime UAT report into scoreable held-out evidence.
 *
 * This is deliberately mechanical: it neither generates an answer nor judges
 * one. It preserves the Consumer-visible completion and any actual files the
 * Runtime wrote so the blind judge scores the product delivery, not a replay.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function argsFrom(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${name ?? "end"}`);
    args.set(name.slice(2), value);
  }
  for (const required of ["runtime-results", "inputs", "output"]) {
    if (!args.get(required)) throw new Error(`Missing --${required}`);
  }
  return args;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function renderedDelivery(run) {
  const written = (run.workspace_artifacts ?? [])
    .filter((artifact) => artifact.path !== "audit.jsonl")
    .map((artifact) => `Saved file: ${artifact.path}\n${artifact.content}`);
  return [run.output, ...written].join("\n\n").trim();
}

async function atomicWrite(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

const args = argsFrom(process.argv.slice(2));
const runtimeResultsPath = path.resolve(args.get("runtime-results"));
const inputsPath = path.resolve(args.get("inputs"));
const outputPath = path.resolve(args.get("output"));
const [runtimeResultsBytes, inputsBytes] = await Promise.all([readFile(runtimeResultsPath), readFile(inputsPath)]);
const runtime = JSON.parse(runtimeResultsBytes.toString("utf8"));
const inputs = JSON.parse(inputsBytes.toString("utf8"));

if (runtime.kind !== "hatch-live-kimi-runtime-uat-v1" || runtime.passed !== true) {
  throw new Error("Runtime UAT is not a successful live Kimi Runtime report");
}
if (runtime.observations?.scenario_workspaces_supplied !== true
  || runtime.observations?.local_tool_executor !== "rust-sidecar") {
  throw new Error("Runtime UAT did not use isolated scenario workspaces with the Rust sidecar");
}
if (runtime.model_runtime?.provider !== "moonshot"
  || runtime.model_runtime?.creator_model !== "kimi-k2.6"
  || runtime.model_runtime?.reviewer_model !== "kimi-k2.6"
  || runtime.model_runtime?.compaction_model !== "kimi-k2.6") {
  throw new Error("Runtime UAT is not Kimi 2.6-only");
}
const inputById = new Map(inputs.map((item) => [item.id, item]));
const runById = new Map(runtime.runs.map((run) => [run.id, run]));
if (inputById.size !== inputs.length || runById.size !== runtime.runs.length || inputById.size !== runById.size) {
  throw new Error("Runtime UAT and held-out inputs do not have the same unique ids");
}
for (const [id, input] of inputById) {
  const run = runById.get(id);
  if (!run || run.input !== input.input || run.exact_release_bound !== true || run.terminal_completed !== true) {
    throw new Error(`Runtime UAT run is not exactly bound and completed for ${id}`);
  }
}

await atomicWrite(outputPath, {
  kind: "live_runtime_candidate_run",
  release_id: runtime.release_id,
  release_digest: runtime.release_digest,
  model: "kimi-k2.6",
  model_runtime: runtime.model_runtime,
  inputs_sha256: sha256(inputsBytes),
  runtime_results_sha256: sha256(runtimeResultsBytes),
  execution_surface: runtime.execution_surface,
  semantic_source: "Consumer-visible Runtime completions plus actual saved workspace artifacts",
  outputs: inputs.map((input) => ({
    id: input.id,
    response: renderedDelivery(runById.get(input.id))
  })),
  passed: true
});
