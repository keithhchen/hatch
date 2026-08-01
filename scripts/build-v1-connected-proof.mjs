#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { projectCreatorDashboard } from "../packages/commerce/src/index.js";

const execFileAsync = promisify(execFile);

const [factoryRootValue, ledgerValue, workflowValue, productStateValue, registryRecordValue, outputValue] = process.argv.slice(2);
if (![factoryRootValue, ledgerValue, workflowValue, productStateValue, registryRecordValue, outputValue].every(Boolean)) {
  throw new Error("Usage: build-v1-connected-proof <factory-root> <ledger.jsonl> <workflow.json> <product-state.json> <registry-publish.json> <output.json>");
}

const factoryRoot = path.resolve(factoryRootValue);
const ledgerPath = path.resolve(ledgerValue);
const workflowPath = path.resolve(workflowValue);
const productStatePath = path.resolve(productStateValue);
const registryRecordPath = path.resolve(registryRecordValue);
const outputPath = path.resolve(outputValue);

const releases = await discoverReleases(path.join(factoryRoot, "release"));
if (releases.length !== 1) throw new Error(`Expected one primary Release, found ${releases.length}`);
const release = releases[0];
const releaseDirectory = path.join(factoryRoot, "release", release.release_id, release.digest);
const [ledgerText, workflow, productState, registryRecord, comparison, runtimeResults, verification, liveVerification] = await Promise.all([
  readFile(ledgerPath, "utf8"),
  readJson(workflowPath),
  readJson(productStatePath),
  readJson(registryRecordPath),
  readJson(path.join(factoryRoot, "review/comparison-results.json")),
  readJson(path.join(factoryRoot, "review/runtime-results.json")),
  readJson(path.join(factoryRoot, "work/reports/release-verification.json")),
  verifyReleaseNow(releaseDirectory)
]);
const events = ledgerText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
assertConnectedWorkflow(workflow);
const releaseOrder = events.find((event) => (
  event.event_type === "order.placed"
  && event.release_id === release.release_id
  && event.release_digest === release.digest
));
if (!releaseOrder) throw new Error("No order is pinned to the exact Factory Release.");
const relevant = events.filter((event) => event.order_id === releaseOrder.order_id);
const byType = new Map(relevant.map((event) => [event.event_type, event]));
const requiredTypes = ["order.placed", "entitlement.granted", "task.started", "artifact.created", "delivery.completed", "revenue.recognized"];
for (const type of requiredTypes) if (!byType.has(type)) throw new Error(`Missing connected commerce event: ${type}`);

const order = byType.get("order.placed");
const entitlement = byType.get("entitlement.granted");
const task = byType.get("task.started");
const artifact = byType.get("artifact.created");
const delivery = byType.get("delivery.completed");
const revenue = byType.get("revenue.recognized");
const expectedGross = release.product.price.amount_minor;
const expectedCreatorShare = Math.floor(expectedGross * 0.9);
const expectedHatchShare = expectedGross - expectedCreatorShare;
const published = Object.values(productState.releases ?? {}).find((state) => (
  state.release_id === release.release_id && state.release_digest === release.digest && state.status === "published"
));
if (!published) throw new Error("The exact Release was not published through the Creator Dashboard.");
const registryPublished = registryRecord.status === "published"
  && registryRecord.creator_id === release.creator_id
  && registryRecord.product_id === release.product_id
  && registryRecord.release_id === release.release_id
  && registryRecord.release_digest === release.digest;
if (!registryPublished) throw new Error("Registry publish record is absent, not published, or bound to another Creator Release.");

const identities = {
  creator_id: release.creator_id,
  product_id: release.product_id,
  release_id: release.release_id,
  release_digest: release.digest,
  order_id: order.order_id,
  entitlement_id: entitlement.entitlement_id,
  task_id: task.task_id,
  artifact_id: artifact.artifact_id,
  artifact_digest: artifact.artifact_digest,
  delivery_id: delivery.delivery_id,
  recognition_id: revenue.recognition_id
};

const identityChecks = {
  release_matches_factory_verification: verification.release_id === release.release_id && verification.release_digest === release.digest && verification.passed === true && liveVerification.passed === true,
  runtime_matches_release: runtimeResults.release_id === release.release_id && runtimeResults.release_digest === release.digest && runtimeResults.passed === true,
  comparison_matches_release: comparison.release_id === release.release_id && comparison.release_digest === release.digest && comparison.passed === true,
  workflow_passed: workflow.passed === true,
  workflow_matches_release: workflow.release?.release_id === release.release_id && workflow.release?.release_digest === release.digest,
  workflow_matches_identity_chain: workflow.identities?.order_id === order.order_id
    && workflow.identities?.entitlement_id === entitlement.entitlement_id
    && workflow.identities?.task_id === task.task_id
    && workflow.identities?.artifact_id === artifact.artifact_id
    && workflow.identities?.delivery_id === delivery.delivery_id
    && workflow.identities?.recognition_id === revenue.recognition_id,
  entitlement_links_order: entitlement.order_id === order.order_id,
  task_links_entitlement_and_order: task.entitlement_id === entitlement.entitlement_id && task.order_id === order.order_id,
  artifact_links_task: artifact.task_id === task.task_id,
  delivery_links_artifact_and_task: delivery.artifact_id === artifact.artifact_id && delivery.task_id === task.task_id,
  revenue_links_delivery_and_order: revenue.delivery_id === delivery.delivery_id && revenue.order_id === order.order_id,
  local_artifact_matches_ledger: workflow.workspace?.sha256 === artifact.artifact_digest && workflow.identities?.artifact_digest === artifact.artifact_digest,
  local_execution_is_real: workflow.checks?.local_tools_executed === true && Array.isArray(workflow.first_run?.local_tool_requests) && workflow.first_run.local_tool_requests.includes("fs.read") && workflow.first_run.local_tool_requests.includes("fs.write"),
  retry_is_idempotent: workflow.checks?.restart_short_circuits_tools === true
    && workflow.checks?.restart_preserves_file === true
    && workflow.checks?.restart_returns_same_receipt === true
    && Array.isArray(workflow.retry?.local_tool_requests)
    && workflow.retry.local_tool_requests.length === 0,
  split_is_90_10: revenue.gross_minor === expectedGross && revenue.creator_share_minor === expectedCreatorShare && revenue.hatch_share_minor === expectedHatchShare,
  dashboard_publish_matches_release: published.release_id === release.release_id && published.release_digest === release.digest,
  registry_publish_matches_release: registryPublished,
  dashboard_publish_matches_registry: published.published_at === registryRecord.published_at,
  workflow_registry_matches_publish: workflow.registry?.status === "published"
    && workflow.registry?.release_id === registryRecord.release_id
    && workflow.registry?.release_digest === registryRecord.release_digest
    && workflow.registry?.published_at === registryRecord.published_at,
  registry_publish_precedes_purchase: workflow.checks?.registry_published_before_purchase === true
    && Date.parse(registryRecord.published_at) <= Date.parse(order.occurred_at)
};

const dashboard = projectCreatorDashboard(events, release.creator_id);
const report = {
  kind: "hatch-v1-connected-run",
  identities,
  factory: {
    semantic_candidate_pass_rate: comparison.summary.creator_agent.pass_rate,
    generic_baseline_pass_rate: comparison.summary.generic_baseline.pass_rate,
    strict_delta: comparison.summary.delta,
    runtime_mechanics_passed: runtimeResults.passed
  },
  consumer: {
    artifact_path: workflow.workspace.artifact,
    artifact_bytes: workflow.workspace.bytes,
    local_tool_requests: workflow.first_run.local_tool_requests,
    retry_invariants: {
      local_tool_requests: workflow.retry.local_tool_requests,
      restart_short_circuits_tools: workflow.checks.restart_short_circuits_tools,
      restart_preserves_file: workflow.checks.restart_preserves_file,
      restart_returns_same_receipt: workflow.checks.restart_returns_same_receipt
    }
  },
  commerce: {
    event_order: relevant.map((event) => event.event_type),
    gross_minor: revenue.gross_minor,
    creator_share_minor: revenue.creator_share_minor,
    hatch_share_minor: revenue.hatch_share_minor,
    currency: revenue.currency
  },
  creator_dashboard: {
    published_at: published.published_at,
    metrics: dashboard.metrics,
    orders: dashboard.orders
  },
  registry: {
    status: registryRecord.status,
    published_at: registryRecord.published_at,
    release_id: registryRecord.release_id,
    release_digest: registryRecord.release_digest
  },
  identity_checks: identityChecks,
  passed: Object.values(identityChecks).every(Boolean)
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output: outputPath, passed: report.passed, identities }, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;

async function discoverReleases(releaseRoot) {
  const found = [];
  for (const releaseIdEntry of await readdir(releaseRoot, { withFileTypes: true })) {
    if (!releaseIdEntry.isDirectory()) continue;
    for (const digestEntry of await readdir(path.join(releaseRoot, releaseIdEntry.name), { withFileTypes: true })) {
      if (!digestEntry.isDirectory() || !digestEntry.name.startsWith("sha256:")) continue;
      found.push(await readJson(path.join(releaseRoot, releaseIdEntry.name, digestEntry.name, "public.json")));
    }
  }
  return found;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function verifyReleaseNow(releaseDirectory) {
  const verifier = path.resolve("creator-agent-factory/scripts/factory.py");
  const { stdout } = await execFileAsync("python3", [verifier, "verify", "--release", releaseDirectory], {
    maxBuffer: 2 * 1024 * 1024
  });
  const result = JSON.parse(stdout.trim());
  if (typeof result?.passed !== "boolean") throw new Error("Factory verifier returned an invalid result");
  return result;
}

function assertConnectedWorkflow(workflow) {
  if (
    workflow?.kind !== "hatch-v1-connected-consumer-run"
    || typeof workflow?.release?.release_id !== "string"
    || typeof workflow?.release?.release_digest !== "string"
    || typeof workflow?.workspace?.artifact !== "string"
    || typeof workflow?.workspace?.sha256 !== "string"
    || !workflow?.identities
    || !workflow?.checks
    || !workflow?.first_run
    || !workflow?.retry
  ) {
    throw new Error("workflow.json is not a current connected Consumer proof; regenerate it with runtime-server proof:connected --execute");
  }
}
