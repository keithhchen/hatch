import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAgentRuntime } from "./agentRuntime.js";
import { FileEntitlementResolver } from "./entitlements.js";
import { createRuntimeServer, type RuntimeServer } from "./index.js";
import { LocalHarnessSession } from "./localHarness.js";
import type { DeliveryReady, OutboundMessage } from "./protocol.js";
import { CreatorReleaseResolver, type CreatorReleasePublic } from "./release.js";
import { requirePublishedRelease, type RegistryPublication } from "./registryPublication.js";
import { kimiModelRuntimeRecord, requireKimiProviderConfig, type KimiModelRuntimeRecord } from "./kimiProvider.js";

type JsonObject = Record<string, any>;
const execFileAsync = promisify(execFile);
const defaultFactoryVerifier = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../creator-agent-factory/scripts/factory.py"
);

const options = parseArguments(process.argv.slice(2));
const preflight = await inspectFactory(options.factoryRoot);

if (!options.execute) {
  process.stdout.write(`${JSON.stringify({ mode: "preflight", ...preflight }, null, 2)}\n`);
  if (!preflight.ready) process.exitCode = 2;
} else {
  if (!preflight.ready) {
    throw new Error(`Connected proof is blocked before any writes: ${preflight.blockers.join("; ")}`);
  }
  if (!options.outputRoot || !options.workspaceInput || !options.prompt || !options.rustRunnerBin) {
    throw new Error("--execute requires --output-root, --workspace-input, --prompt, and --rust-runner-bin");
  }
  if (!options.registryUrl) {
    throw new Error("--execute requires --registry-url so purchase cannot precede publication");
  }
  requireKimiProviderConfig();
  await validateExecutionInputs(options.workspaceInput, options.rustRunnerBin, options.outputFile);
  const registryPublication = await requirePublishedRelease(options.registryUrl, preflight.release);
  await requireEmptyDirectory(options.outputRoot);
  const result = await executeConnectedProof({
    preflight,
    registryPublication,
    outputRoot: options.outputRoot,
    workspaceInput: options.workspaceInput,
    prompt: options.prompt,
    outputFile: options.outputFile,
    rustRunnerBin: options.rustRunnerBin,
    modelRuntime: kimiModelRuntimeRecord()
  });
  process.stdout.write(`${JSON.stringify({ mode: "execute", passed: result.passed, output_root: options.outputRoot, identities: result.identities }, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

type RunnerOptions = {
  factoryRoot: string;
  execute: boolean;
  outputRoot?: string;
  workspaceInput?: string;
  prompt?: string;
  outputFile: string;
  rustRunnerBin?: string;
  registryUrl?: string;
};

function parseArguments(values: string[]): RunnerOptions {
  const args = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--execute") {
      execute = true;
      continue;
    }
    if (!value?.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
    args.set(value, next);
    index += 1;
  }
  const factoryRoot = args.get("--factory-root");
  if (!factoryRoot) {
    throw new Error("Usage: connectedProofRunner --factory-root <Factory proof root> [--execute --registry-url <published Registry> --output-root <empty dir> --workspace-input <file-or-directory> --prompt <natural request> --rust-runner-bin <binary>]");
  }
  return {
    factoryRoot: path.resolve(factoryRoot),
    execute,
    ...(args.get("--output-root") ? { outputRoot: path.resolve(args.get("--output-root")!) } : {}),
    ...(args.get("--workspace-input") ? { workspaceInput: path.resolve(args.get("--workspace-input")!) } : {}),
    ...(args.get("--prompt") ? { prompt: args.get("--prompt")! } : {}),
    outputFile: args.get("--output-file") ?? "agent-output.md",
    ...(args.get("--rust-runner-bin") ? { rustRunnerBin: path.resolve(args.get("--rust-runner-bin")!) } : {}),
    ...(args.get("--registry-url") ? { registryUrl: args.get("--registry-url")! } : {})
  };
}

type FactoryPreflight = {
  ready: boolean;
  blockers: string[];
  factory_root: string;
  releases_root: string;
  release_directory: string;
  release: CreatorReleasePublic;
  semantic: {
    gates_passed: boolean;
    package_verified: boolean;
    package_reverified: boolean;
    comparison_passed: boolean;
    runtime_passed: boolean;
  };
};

async function inspectFactory(factoryRoot: string): Promise<FactoryPreflight> {
  const releasesRoot = path.join(factoryRoot, "release");
  const releaseDirectories = await discoverReleaseDirectories(releasesRoot);
  if (releaseDirectories.length !== 1) {
    throw new Error(`Expected exactly one candidate Release under ${releasesRoot}; found ${releaseDirectories.length}`);
  }
  const releaseDirectory = releaseDirectories[0]!;
  const release = JSON.parse(await readFile(path.join(releaseDirectory, "public.json"), "utf8")) as CreatorReleasePublic;
  const gates = await optionalJson(path.join(factoryRoot, "work/reports/gates.json"));
  const verification = await optionalJson(path.join(factoryRoot, "work/reports/release-verification.json"));
  const liveVerification = await verifyReleaseNow(releaseDirectory);
  // Prefer the evidence produced by a live Kimi Runtime against isolated
  // Consumer workspaces. Older replay-style proof files remain readable only
  // for historical Factory outputs that do not yet have the stronger proof.
  const comparison = await firstOptionalJson(factoryRoot, [
    "review/runtime-blind-comparison.json",
    "review/comparison-results.json"
  ]);
  const runtime = await firstOptionalJson(factoryRoot, [
    "review/runtime-results-scenario.json",
    "review/runtime-results.json"
  ]);
  const sameRelease = (value: JsonObject | undefined) => Boolean(
    value
    && value.release_id === release.release_id
    && value.release_digest === release.digest
  );
  const semantic = {
    gates_passed: gates?.passed === true,
    package_verified: verification?.passed === true && sameRelease(verification) && liveVerification.passed === true,
    package_reverified: liveVerification.passed === true,
    comparison_passed: comparison?.passed === true && sameRelease(comparison),
    runtime_passed: runtime?.passed === true && sameRelease(runtime)
  };
  const blockers: string[] = [];
  if (!semantic.gates_passed) blockers.push("Factory gates.json is absent or not passed");
  if (!semantic.package_verified) blockers.push("release-verification.json is absent, failed, bound to another digest, or fails the current Factory verifier");
  if (!semantic.comparison_passed) blockers.push("same-digest blind comparison is absent, failed, or bound to another digest");
  if (!semantic.runtime_passed) blockers.push("same-digest live Runtime evidence is absent, failed, or bound to another digest");
  return {
    ready: blockers.length === 0,
    blockers,
    factory_root: factoryRoot,
    releases_root: releasesRoot,
    release_directory: releaseDirectory,
    release,
    semantic
  };
}

async function verifyReleaseNow(releaseDirectory: string): Promise<JsonObject> {
  const { stdout } = await execFileAsync("python3", [defaultFactoryVerifier, "verify", "--release", releaseDirectory], {
    maxBuffer: 2 * 1024 * 1024
  });
  const value = JSON.parse(stdout.trim());
  if (typeof value?.passed !== "boolean") throw new Error("Factory verifier returned an invalid result");
  return value;
}

async function executeConnectedProof(input: {
  preflight: FactoryPreflight;
  registryPublication: RegistryPublication;
  outputRoot: string;
  workspaceInput: string;
  prompt: string;
  outputFile: string;
  rustRunnerBin: string;
  modelRuntime: KimiModelRuntimeRecord;
}): Promise<JsonObject> {
  const { preflight, outputRoot } = input;
  const publicRelease = preflight.release;
  const price = publicRelease.product.price;
  if (!Number.isInteger(price.amount_minor) || price.amount_minor <= 0) throw new Error("Release price.amount_minor must be a positive integer");
  const proofNonce = createHash("sha256").update(`${publicRelease.digest}\u0000${input.prompt}`).digest("hex").slice(0, 16);
  const ids = {
    buyer: `buyer_jordan_lee_${proofNonce}`,
    order: `order_connected_${proofNonce}`,
    entitlement: `entitlement_connected_${proofNonce}`,
    conversation: `conversation_connected_${proofNonce}`,
    run: `run_connected_${proofNonce}`,
    license: `lic_connected_${proofNonce}`,
    tenant: `tenant_connected_${proofNonce}`
  };
  const workspace = path.join(outputRoot, "workspace");
  const runtimeData = path.join(outputRoot, "runtime-data");
  const ledgerFile = path.join(outputRoot, "commerce-ledger.jsonl");
  const entitlementsFile = path.join(outputRoot, "entitlements.json");
  await mkdir(workspace, { recursive: true });
  await mkdir(runtimeData, { recursive: true });
  const inputFiles = await copyWorkspaceInput(input.workspaceInput, workspace);
  const entitlement = {
    license_token: ids.license,
    entitlement_id: ids.entitlement,
    order_id: ids.order,
    tenant_id: ids.tenant,
    user_id: ids.buyer,
    creator_id: publicRelease.creator_id,
    product_id: publicRelease.product_id,
    release_id: publicRelease.release_id,
    release_digest: publicRelease.digest,
    status: "active"
  };
  await writeFile(entitlementsFile, `${JSON.stringify([entitlement], null, 2)}\n`, "utf8");
  process.env.HATCH_RUNTIME_DATA_DIR = runtimeData;

  const commerce = await import(new URL("../../packages/commerce/src/index.js", import.meta.url).href) as any;
  let ledger = await commerce.CommerceLedger.open({ filePath: ledgerFile });
  await ledger.append("order.placed", {
    order_id: ids.order,
    buyer_id: ids.buyer,
    creator_id: publicRelease.creator_id,
    product_id: publicRelease.product_id,
    release_id: publicRelease.release_id,
    release_digest: publicRelease.digest,
    buyer_display_name: "Jordan Lee",
    product_name: publicRelease.product.name,
    gross_minor: price.amount_minor,
    currency: price.currency
  }, { idempotencyKey: `order:${ids.order}` });
  await ledger.append("entitlement.granted", {
    entitlement_id: ids.entitlement,
    order_id: ids.order,
    buyer_id: ids.buyer,
    creator_id: publicRelease.creator_id,
    product_id: publicRelease.product_id,
    release_id: publicRelease.release_id,
    release_digest: publicRelease.digest
  }, { idempotencyKey: `entitlement:${ids.entitlement}` });

  const makeServer = async (): Promise<{ runtime: RuntimeServer; url: string }> => {
    ledger = await commerce.CommerceLedger.open({ filePath: ledgerFile });
    const recognizedSink = new commerce.LedgerCommerceSink(ledger);
    const runtime = createRuntimeServer({
      createRuntime: () => createAgentRuntime(),
      releaseResolver: new CreatorReleaseResolver(preflight.releases_root),
      entitlementResolver: new FileEntitlementResolver(entitlementsFile),
      commerceEventSink: {
        append: (type, payload, options) => recognizedSink.ingest(type, payload, options),
        findByIdempotencyKey: (key) => ledger.findByIdempotencyKey(key)
      }
    });
    await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("Runtime did not bind a TCP port");
    return { runtime, url: `ws://127.0.0.1:${address.port}/runtime` };
  };

  const naturalPrompt = ensureOutputInstruction(input.prompt, input.outputFile);
  const firstServer = await makeServer();
  const first = await runHarness(firstServer.url, naturalPrompt, workspace, input.rustRunnerBin, ids);
  await firstServer.runtime.close();
  const receipt = requiredReceipt(first.events);
  const artifactPath = receipt.artifact_path ?? input.outputFile;
  const artifactAbsolutePath = path.join(workspace, artifactPath);
  const beforeRetry = await readFile(artifactAbsolutePath);
  const beforeHash = sha256(beforeRetry);

  const secondServer = await makeServer();
  const retry = await runHarness(secondServer.url, naturalPrompt, workspace, input.rustRunnerBin, ids);
  await secondServer.runtime.close();
  const retryReceipt = requiredReceipt(retry.events);
  const afterRetry = await readFile(artifactAbsolutePath);
  const afterHash = sha256(afterRetry);
  const events = ledger.listEvents();
  const deliveryEvents = events.filter((event: JsonObject) => event.event_type === "delivery.completed");
  const revenueEvents = events.filter((event: JsonObject) => event.event_type === "revenue.recognized");
  const revenue = revenueEvents[0];
  const artifactEvent = events.find((event: JsonObject) => event.event_type === "artifact.created");
  const toolRequests = first.events.filter(isToolRequest).map((event) => event.name);
  const retryToolRequests = retry.events.filter(isToolRequest);
  const creatorShare = Math.floor(price.amount_minor * 0.9);
  const hatchShare = price.amount_minor - creatorShare;
  const checks = {
    registry_published_before_purchase: input.registryPublication.status === "published"
      && Date.parse(input.registryPublication.published_at) <= Date.parse(events[0]?.occurred_at),
    exact_release: events.every((event: JsonObject) => !event.release_digest || event.release_digest === publicRelease.digest),
    event_sequence: events.map((event: JsonObject) => event.event_type).join(",") === "order.placed,entitlement.granted,task.started,artifact.created,delivery.completed,revenue.recognized",
    local_tools_executed: ["fs.read", "fs.write"].every((name) => toolRequests.includes(name))
      && ["fs.list", "fs.search"].some((name) => toolRequests.includes(name)),
    artifact_digest_matches_bytes: receipt.artifact_digest === beforeHash && artifactEvent?.artifact_digest === beforeHash,
    one_delivery: deliveryEvents.length === 1,
    one_recognition: revenueEvents.length === 1,
    split_is_90_10: revenue?.gross_minor === price.amount_minor && revenue?.creator_share_minor === creatorShare && revenue?.hatch_share_minor === hatchShare,
    restart_short_circuits_tools: retryToolRequests.length === 0,
    restart_preserves_file: beforeRetry.equals(afterRetry) && beforeHash === afterHash,
    restart_returns_same_receipt: JSON.stringify(receipt) === JSON.stringify(retryReceipt)
  };
  const report = {
    kind: "hatch-v1-connected-consumer-run",
    model_runtime: input.modelRuntime,
    release: { release_id: publicRelease.release_id, release_digest: publicRelease.digest },
    registry: {
      status: input.registryPublication.status,
      published_at: input.registryPublication.published_at,
      release_id: input.registryPublication.release_id,
      release_digest: input.registryPublication.release_digest
    },
    identities: {
      order_id: ids.order,
      entitlement_id: ids.entitlement,
      task_id: receipt.task_id,
      artifact_id: receipt.artifact_id,
      artifact_digest: receipt.artifact_digest,
      delivery_id: receipt.delivery_id,
      recognition_id: revenue?.recognition_id
    },
    workspace: { inputs: inputFiles, artifact: artifactPath, bytes: beforeRetry.length, sha256: beforeHash },
    first_run: { prompt: naturalPrompt, local_tool_requests: toolRequests },
    retry: { local_tool_requests: retryToolRequests.map((event) => event.name) },
    commerce: {
      event_order: events.map((event: JsonObject) => event.event_type),
      gross_minor: price.amount_minor,
      creator_share_minor: creatorShare,
      hatch_share_minor: hatchShare,
      currency: price.currency,
      dashboard: commerce.projectCreatorDashboard(events, publicRelease.creator_id)
    },
    checks,
    passed: Object.values(checks).every(Boolean)
  };
  await writeFile(path.join(outputRoot, "workflow-result.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function runHarness(serverUrl: string, prompt: string, workspace: string, rustRunnerBin: string, ids: Record<string, string>) {
  const session = new LocalHarnessSession({
    serverUrl,
    workspace,
    conversationId: ids.conversation,
    installationId: "connected-proof-installation",
    licenseToken: ids.license,
    entitlementId: ids.entitlement,
    localTools: ["fs.list", "fs.read", "fs.write"],
    rustRunnerBin,
    allowShell: false,
    approveTool: () => true,
    // This proof intentionally exercises an optional delivery audit that can
    // require several Kimi reviewer batches after the normal agent turn. Keep
    // the interactive Desktop timeout unchanged; only the non-interactive
    // connected-proof harness gets the explicit verification deadline.
    runTimeoutMs: connectedProofTurnTimeoutMs(),
    runIdFactory: () => ids.run
  });
  await session.connect();
  try {
    return await session.run(prompt);
  } finally {
    session.close();
  }
}

function ensureOutputInstruction(prompt: string, outputFile: string): string {
  if (/(?:save|write|create)\b[^\n]*?\b(?:to|as|at)\s+/i.test(prompt)) return prompt;
  return `${prompt.trim()} Save the completed work as ${outputFile}.`;
}

function connectedProofTurnTimeoutMs(): number {
  const raw = Number(process.env.HATCH_CONNECTED_PROOF_TURN_TIMEOUT_MS ?? 900_000);
  if (!Number.isFinite(raw) || raw < 30_000 || raw > 1_800_000) {
    throw new Error("HATCH_CONNECTED_PROOF_TURN_TIMEOUT_MS must be between 30000 and 1800000");
  }
  return raw;
}

function requiredReceipt(events: OutboundMessage[]): DeliveryReady {
  const receipt = events.find((event): event is DeliveryReady => event.type === "delivery.ready");
  if (!receipt) throw new Error("Runtime completed without a delivery.ready receipt");
  return receipt;
}

function isToolRequest(event: OutboundMessage): event is Extract<OutboundMessage, { type: "tool_call.request" }> {
  return event.type === "tool_call.request";
}

async function discoverReleaseDirectories(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const releaseEntry of await readdir(root, { withFileTypes: true })) {
    if (!releaseEntry.isDirectory()) continue;
    const releaseRoot = path.join(root, releaseEntry.name);
    for (const digestEntry of await readdir(releaseRoot, { withFileTypes: true })) {
      if (digestEntry.isDirectory() && /^sha256:[a-f0-9]{64}$/.test(digestEntry.name)) {
        found.push(path.join(releaseRoot, digestEntry.name));
      }
    }
  }
  return found;
}

async function optionalJson(filePath: string): Promise<JsonObject | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function firstOptionalJson(root: string, relativePaths: string[]): Promise<JsonObject | undefined> {
  for (const relativePath of relativePaths) {
    const value = await optionalJson(path.join(root, relativePath));
    if (value) return value;
  }
  return undefined;
}

async function requireEmptyDirectory(directory: string): Promise<void> {
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) throw new Error(`Output path exists and is not a directory: ${directory}`);
    const entries = await readdir(directory);
    if (entries.length > 0) throw new Error(`Output directory must be empty: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true });
  }
}

async function validateExecutionInputs(workspaceInput: string, rustRunnerBin: string, outputFile: string): Promise<void> {
  const workspaceInfo = await stat(workspaceInput).catch(() => undefined);
  if (!workspaceInfo || (!workspaceInfo.isFile() && !workspaceInfo.isDirectory())) {
    throw new Error(`--workspace-input must be an existing file or directory: ${workspaceInput}`);
  }
  const runnerInfo = await stat(rustRunnerBin).catch(() => undefined);
  if (!runnerInfo?.isFile() || (runnerInfo.mode & 0o111) === 0) {
    throw new Error(`--rust-runner-bin must be an executable file: ${rustRunnerBin}`);
  }
  if (!outputFile || path.isAbsolute(outputFile) || outputFile.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new Error("--output-file must be a relative path inside the granted workspace");
  }
}

async function copyWorkspaceInput(source: string, workspace: string): Promise<string[]> {
  const sourceInfo = await stat(source);
  if (sourceInfo.isFile()) {
    const target = path.join(workspace, path.basename(source));
    await copyFile(source, target);
    return [path.basename(source)];
  }
  if (!sourceInfo.isDirectory()) throw new Error(`Workspace input must be a file or directory: ${source}`);
  await copyDirectoryContents(source, workspace);
  return listWorkspaceFiles(workspace);
}

async function copyDirectoryContents(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      await copyDirectoryContents(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(`Workspace input contains an unsupported entry: ${sourcePath}`);
    }
  }
}

async function listWorkspaceFiles(root: string, current: string = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listWorkspaceFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files.sort();
}

function sha256(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
