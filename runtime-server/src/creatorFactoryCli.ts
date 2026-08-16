import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHatchCliCandidateExecutor } from "./creatorLearning/cliCandidateExecutor.js";
import { CreatorFactory } from "./creatorLearning/engine.js";
import { FactoryFileStore } from "./creatorLearning/fileStore.js";
import { parseCreatorAnswerQuestionBatchId } from "./creatorLearning/markdown.js";
import { factoryModelForEnvironment, runFactoryPromptWithPi } from "./creatorLearning/piGateway.js";
import { requireQuestionBatchId } from "./creatorLearning/questionBatch.js";
import {
  resolveCreatorSourceScope,
  type CreatorSourceScopeInput
} from "./creatorLearning/sourceScope.js";
import type { FactoryExecutionTiming, FactoryStartInput } from "./creatorLearning/types.js";

type InputManifest = {
  runId?: string;
  creator: { id: string; name: string };
  agentId?: string;
  product?: FactoryStartInput["product"];
  tools?: FactoryStartInput["tools"];
  productName: string;
  productPromise?: string;
  productPromisePath?: string;
  sources?: Array<{
    id: string;
    authority: FactoryStartInput["sources"][number]["authority"];
    title: string;
    path?: string;
    content?: string;
  }>;
  source_scope?: CreatorSourceScopeInput;
  config?: FactoryStartInput["config"];
};

export async function runCreatorFactoryCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      input: { type: "string" },
      "run-id": { type: "string" },
      answers: { type: "string" },
      json: { type: "boolean" }
    }
  });
  const command = parsed.positionals[0];
  const root = path.resolve(parsed.values.root ?? ".hatch/creator-factory-runs");
  const factory = new CreatorFactory(root, runFactoryPromptWithPi, createHatchCliCandidateExecutor(), { model: factoryModelForEnvironment() });

  if (command === "start") {
    if (!parsed.values.input) throw usage("start requires --input <factory-input.json>");
    const input = await loadInputManifest(path.resolve(parsed.values.input));
    await withMutationSignal(async (signal) => {
      printState(await factory.start(input, { signal }), root);
    });
    return;
  }
  if (command === "resume") {
    const runId = requiredRunId(parsed.values["run-id"]);
    await withMutationSignal(async (signal) => {
      await recoverAbandonedCliExecutions(root, runId);
      let state;
      if (parsed.values.answers) {
        const answers = await readFile(path.resolve(parsed.values.answers), "utf8");
        state = await factory.submitCreatorAnswers(
          runId,
          answers,
          parseCreatorAnswerQuestionBatchId(answers),
          { signal }
        );
      } else {
        state = await factory.resume(runId, { signal });
      }
      printState(state, root);
    });
    return;
  }
  if (command === "status") {
    printState(await factory.status(requiredRunId(parsed.values["run-id"])), root);
    return;
  }
  if (command === "retry") {
    const runId = requiredRunId(parsed.values["run-id"]);
    await withMutationSignal(async (signal) => {
      await recoverAbandonedCliExecutions(root, runId);
      printState(await factory.retry(runId, { signal }), root);
    });
    return;
  }
  if (command === "timings") {
    const runId = requiredRunId(parsed.values["run-id"]);
    const store = new FactoryFileStore(root, runId);
    await store.loadState();
    const report = timingReport(runId, store.directory, await store.listExecutionTimings());
    process.stdout.write(parsed.values.json ? `${JSON.stringify(report, null, 2)}\n` : renderTimingReport(report));
    return;
  }
  throw usage("expected start, resume, retry, status, or timings");
}

export async function loadInputManifest(manifestPath: string): Promise<FactoryStartInput> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as InputManifest;
  const base = path.dirname(manifestPath);
  if (!manifest.creator) throw usage("input manifest needs creator");
  const hasSources = Object.prototype.hasOwnProperty.call(manifest, "sources");
  const hasSourceScope = Object.prototype.hasOwnProperty.call(manifest, "source_scope");
  if (hasSources === hasSourceScope) {
    throw usage("input manifest requires exactly one of legacy sources or source_scope; they are mutually exclusive");
  }
  const productPromise = manifest.productPromise
    ?? (manifest.productPromisePath ? await readFile(path.resolve(base, manifest.productPromisePath), "utf8") : "");
  let sources: FactoryStartInput["sources"];
  let sourceManifest: FactoryStartInput["sourceManifest"];
  if (hasSourceScope) {
    const resolved = await resolveCreatorSourceScope(manifest.source_scope, base);
    sources = resolved.sources;
    sourceManifest = resolved.sourceManifest;
  } else {
    if (!Array.isArray(manifest.sources)) throw usage("legacy sources must be an array");
    sources = await Promise.all(manifest.sources.map(async (source) => {
      if (!source || typeof source !== "object") throw usage("every legacy source must be an object");
      if (source.content === undefined && !source.path) {
        throw usage(`legacy source ${source.id || "<unknown>"} needs path or content`);
      }
      return {
        id: source.id,
        authority: source.authority,
        title: source.title,
        content: source.content
          ?? (source.path ? await readFile(path.resolve(base, source.path), "utf8") : "")
      };
    }));
  }
  return {
    ...(manifest.runId ? { runId: manifest.runId } : {}),
    creator: manifest.creator,
    ...(manifest.agentId ? { agentId: manifest.agentId } : {}),
    ...(manifest.product ? { product: manifest.product } : {}),
    ...(manifest.tools ? { tools: manifest.tools } : {}),
    productName: manifest.productName,
    productPromise,
    sources,
    ...(sourceManifest ? { sourceManifest } : {}),
    ...(manifest.config ? { config: manifest.config } : {})
  };
}

function printState(state: Awaited<ReturnType<CreatorFactory["status"]>>, root: string): void {
  const runDirectory = path.join(root, state.runId);
  const candidate = state.artifacts.corpusCandidates.at(-1);
  // A materialized bundle exists during evaluation so Hatch can execute it,
  // but it is provisional and carries only the host-owned empty held-out
  // placeholder. Do not present its path or digest as an operator release.
  const readyAgentCorpus = state.stage === "ready" ? candidate?.agentCorpus : undefined;
  process.stdout.write(`${JSON.stringify({
    runId: state.runId,
    stage: state.stage,
    runDirectory,
    sourceManifest: state.artifacts.sourceManifest
      ? path.join(runDirectory, ...state.artifacts.sourceManifest.path.split("/"))
      : undefined,
    answerTemplate: state.stage === "awaiting_creator_answers" && state.artifacts.creatorAnswerTemplate
      ? path.join(runDirectory, state.artifacts.creatorAnswerTemplate.path)
      : undefined,
    questionBatchId: state.stage === "awaiting_creator_answers"
      ? requireQuestionBatchId(state.runId, state.artifacts.currentQuestionBatch)
      : undefined,
    corpusVersion: candidate?.version,
    systemDigest: candidate?.systemInstructions.sha256,
    corpusDigest: readyAgentCorpus?.digest,
    agentCorpusRoot: readyAgentCorpus
      ? path.join(runDirectory, ...readyAgentCorpus.rootPath.split("/"))
      : undefined,
    lastError: state.lastError
  }, null, 2)}\n`);
}

function requiredRunId(value: string | undefined): string {
  if (!value) throw usage("--run-id is required");
  return value;
}

function usage(message: string): Error {
  return new Error(`${message}\nUsage:\n  creatorFactoryCli start --input <json> [--root <dir>]\n  creatorFactoryCli resume --run-id <id> [--answers <md>] [--root <dir>]\n  creatorFactoryCli retry --run-id <id> [--root <dir>]\n  creatorFactoryCli status --run-id <id> [--root <dir>]\n  creatorFactoryCli timings --run-id <id> [--root <dir>] [--json]`);
}

type TimingNodeSummary = {
  node: FactoryExecutionTiming["metadata"]["purpose"];
  attempts: number;
  running: number;
  completed: number;
  failed: number;
  aborted: number;
  abandoned: number;
  settledElapsedMs: number;
  averageSettledElapsedMs?: number;
};

type TimingReport = {
  runId: string;
  runDirectory: string;
  summary: {
    attempts: number;
    running: number;
    completed: number;
    failed: number;
    aborted: number;
    abandoned: number;
    settledElapsedMs: number;
    byNode: TimingNodeSummary[];
  };
  executions: FactoryExecutionTiming[];
};

export function timingReport(runId: string, runDirectory: string, executions: FactoryExecutionTiming[]): TimingReport {
  const counts = { running: 0, completed: 0, failed: 0, aborted: 0, abandoned: 0 };
  const byNode = new Map<TimingNodeSummary["node"], TimingNodeSummary>();
  let settledElapsedMs = 0;
  for (const execution of executions) {
    counts[execution.status] += 1;
    const node = execution.metadata.purpose;
    const summary = byNode.get(node) ?? {
      node,
      attempts: 0,
      running: 0,
      completed: 0,
      failed: 0,
      aborted: 0,
      abandoned: 0,
      settledElapsedMs: 0
    };
    summary.attempts += 1;
    summary[execution.status] += 1;
    if (execution.elapsedMs !== undefined) {
      settledElapsedMs += execution.elapsedMs;
      summary.settledElapsedMs += execution.elapsedMs;
    }
    byNode.set(node, summary);
  }
  const rows = [...byNode.values()].sort((left, right) => left.node.localeCompare(right.node));
  for (const row of rows) {
    const settled = row.completed + row.failed + row.aborted;
    if (settled > 0) row.averageSettledElapsedMs = row.settledElapsedMs / settled;
  }
  return {
    runId,
    runDirectory,
    summary: {
      attempts: executions.length,
      ...counts,
      settledElapsedMs,
      byNode: rows
    },
    executions
  };
}

function renderTimingReport(report: TimingReport): string {
  const lines = [
    `Creator Factory timings — ${report.runId}`,
    `Run directory: ${report.runDirectory}`,
    `Attempts: ${report.summary.attempts} (completed ${report.summary.completed}, failed ${report.summary.failed}, aborted ${report.summary.aborted}, abandoned ${report.summary.abandoned}, running ${report.summary.running})`,
    `Settled elapsed: ${formatElapsed(report.summary.settledElapsedMs)}`,
    "",
    "By node:"
  ];
  for (const row of report.summary.byNode) {
    lines.push(`- ${row.node}: ${row.attempts} attempt(s), ${formatElapsed(row.settledElapsedMs)} settled${row.averageSettledElapsedMs === undefined ? "" : `, avg ${formatElapsed(row.averageSettledElapsedMs)}`}`);
  }
  lines.push("", "Executions:");
  for (const execution of report.executions) {
    lines.push([
      "-",
      execution.executionId,
      execution.metadata.purpose,
      execution.status,
      execution.elapsedMs === undefined ? "elapsed —" : `elapsed ${formatElapsed(execution.elapsedMs)}`,
      execution.sealed ? "sealed" : "unsealed",
      execution.startedAt,
      execution.completedAt ?? "still running"
    ].join(" | "));
  }
  return `${lines.join("\n")}\n`;
}

async function recoverAbandonedCliExecutions(root: string, runId: string): Promise<void> {
  const store = new FactoryFileStore(root, runId);
  await store.loadState();
  await store.abandonRunningExecutions(new Date().toISOString());
}

async function withMutationSignal<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("Creator Factory CLI interrupted by operator"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    return await operation(controller.signal);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds.toFixed(1)}ms`;
  return `${(milliseconds / 1_000).toFixed(2)}s`;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  runCreatorFactoryCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
