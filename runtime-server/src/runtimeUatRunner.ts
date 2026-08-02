import "dotenv/config";

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { FileEntitlementResolver, isReleaseEntitlement } from "./entitlements.js";
import { createRuntimeServer } from "./index.js";
import { kimiModelRuntimeRecord, requireKimiProviderConfig } from "./kimiProvider.js";
import { LocalHarnessSession } from "./localHarness.js";
import type { ClientToolName } from "./protocol.js";
import { CreatorReleasePublicSchema, CreatorReleaseResolver, deliveryWorkflowForRelease } from "./release.js";
import { materializeCreatorRelease } from "./releaseMaterialization.js";

const HeldOutInputSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1).optional(),
  input: z.string().min(1)
}).strict();

type Options = {
  releaseDirectory: string;
  inputsFile: string;
  outputFile: string;
  preflight: boolean;
  entitlementFile?: string;
  entitlementId?: string;
  licenseToken?: string;
  workspaceInput?: string;
  scenarioWorkspaces?: string;
  profileInput?: string;
  rustRunnerBin?: string;
  modelProfile: "kimi-k2.6";
};

const options = parseArguments(process.argv.slice(2));
const publicRelease = CreatorReleasePublicSchema.parse(
  JSON.parse(await readFile(path.join(options.releaseDirectory, "public.json"), "utf8"))
);
if (path.basename(options.releaseDirectory) !== publicRelease.digest
  || path.basename(path.dirname(options.releaseDirectory)) !== publicRelease.release_id) {
  throw new Error("--release must be the exact release/<release-id>/<sha256:digest> directory declared by public.json");
}
const releasesRoot = path.dirname(path.dirname(options.releaseDirectory));
const releaseResolver = new CreatorReleaseResolver(releasesRoot);
const resolvedRelease = await releaseResolver.resolve(publicRelease.release_id, publicRelease.digest);
const heldOutInputs = z.array(HeldOutInputSchema).min(1).parse(
  JSON.parse(await readFile(options.inputsFile, "utf8"))
);
const heldOutInputsSha256 = sha256(await readFile(options.inputsFile, "utf8"));
if (new Set(heldOutInputs.map((item) => item.id)).size !== heldOutInputs.length) {
  throw new Error("Held-out input ids must be unique");
}
await validateOptionalInput(options.workspaceInput, "workspace input");
await validateOptionalInput(options.scenarioWorkspaces, "scenario workspaces");
await validateOptionalInput(options.profileInput, "profile input");
await validateOptionalInput(options.rustRunnerBin, "Rust runner binary");
if (options.scenarioWorkspaces) {
  for (const item of heldOutInputs) {
    await validateScenarioWorkspace(options.scenarioWorkspaces, item.id);
  }
}

const releaseQualityWorkflow = deliveryWorkflowForRelease(resolvedRelease);
const materialized = await materializeCreatorRelease(resolvedRelease, heldOutInputs[0]!.input, []);
if (!materialized.systemPrompt.trim()) throw new Error("Exact Creator Release materialized no private execution context");
const privateSkillMaterialized = materialized.systemPrompt.includes("<creator_skills>");
if (!privateSkillMaterialized) throw new Error("Exact Creator Release materialized no protected Skill instructions");
const runtimeDeliveryAudit = materialized.deliveryWorkflow?.mode ?? "not-enforced";
const localTools = releaseLocalTools(publicRelease.product.supported_local_capabilities);
if (options.entitlementFile) {
  await validateExactEntitlement(
    options.entitlementFile,
    options.licenseToken!,
    options.entitlementId!,
    publicRelease
  );
}

if (options.preflight) {
  const preflightScratch = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-uat-preflight-"));
  let workspaceInputs: string[] = [];
  try {
    const scenarioWorkspace = options.scenarioWorkspaces
      ? path.join(options.scenarioWorkspaces, safeSegment(heldOutInputs[0]!.id))
      : options.workspaceInput;
    workspaceInputs = await seedWorkspace(preflightScratch, scenarioWorkspace, options.profileInput);
  } finally {
    await rm(preflightScratch, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({
    mode: "preflight",
    ready: true,
    release_id: publicRelease.release_id,
    release_digest: publicRelease.digest,
    held_out_inputs: heldOutInputs.length,
    model_profile: options.modelProfile,
    release_quality_workflow: releaseQualityWorkflow?.mode ?? "none",
    runtime_delivery_audit: runtimeDeliveryAudit,
    local_tools: localTools,
    entitlement_input: options.entitlementFile ? "provided" : "generated-at-execution",
    workspace_input: options.workspaceInput ?? null,
    scenario_workspaces: options.scenarioWorkspaces ?? null,
    profile_input: options.profileInput ?? null,
    workspace_files: workspaceInputs
  }, null, 2)}\n`);
  process.exit(0);
}

const provider = requireKimiProviderConfig();
if (provider.model !== options.modelProfile) throw new Error("Resolved Kimi provider does not match --model-profile");

const scratch = await mkdtemp(path.join(os.tmpdir(), "hatch-live-runtime-uat-"));
const entitlementId = options.entitlementId ?? `ent_runtime_uat_${shortHash(publicRelease.digest)}`;
const licenseToken = options.licenseToken ?? `license_runtime_uat_${shortHash(publicRelease.release_id)}`;
const entitlementFile = options.entitlementFile ?? path.join(scratch, "entitlements.json");
const runtimeData = path.join(scratch, "runtime-data");
if (!options.entitlementFile) {
  await writeFile(entitlementFile, `${JSON.stringify([{
    license_token: licenseToken,
    entitlement_id: entitlementId,
    order_id: `order_runtime_uat_${shortHash(publicRelease.digest)}`,
    tenant_id: "tenant_runtime_uat",
    user_id: "user_runtime_uat",
    creator_id: publicRelease.creator_id,
    product_id: publicRelease.product_id,
    release_id: publicRelease.release_id,
    release_digest: publicRelease.digest,
    status: "active"
  }], null, 2)}\n`, "utf8");
} else {
  await validateExactEntitlement(entitlementFile, licenseToken, entitlementId, publicRelease);
}
process.env.HATCH_RUNTIME_DATA_DIR = runtimeData;

const runtime = createRuntimeServer({
  releaseResolver,
  entitlementResolver: new FileEntitlementResolver(entitlementFile)
});

try {
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("Runtime UAT server did not bind a TCP port");
  const httpBase = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/runtime`;
  const libraryResponse = await fetch(`${httpBase}/v1/me/creator-agents`, {
    headers: { authorization: `Bearer ${licenseToken}` }
  });
  if (!libraryResponse.ok) throw new Error(`Runtime library lookup failed with HTTP ${libraryResponse.status}`);
  const library = await libraryResponse.json() as Record<string, any>;
  const pinned = Array.isArray(library.creator_agents)
    ? library.creator_agents.find((item: Record<string, any>) => item.entitlement_id === entitlementId)
    : undefined;
  if (!pinned) throw new Error("Runtime library did not return the purchased Creator Agent entitlement");

  const runs: Array<Record<string, unknown>> = [];
  for (const item of heldOutInputs) {
    const workspace = path.join(scratch, "workspaces", safeSegment(item.id));
    await mkdir(workspace, { recursive: true });
    const scenarioWorkspace = options.scenarioWorkspaces
      ? path.join(options.scenarioWorkspaces, safeSegment(item.id))
      : options.workspaceInput;
    const workspaceFiles = await seedWorkspace(workspace, scenarioWorkspace, options.profileInput);
    const workspaceBefore = await snapshotWorkspace(workspace);
    const session = new LocalHarnessSession({
      serverUrl: wsUrl,
      workspace,
      conversationId: `runtime_uat_${safeSegment(item.id)}`,
      installationId: `runtime-uat-${shortHash(options.profileInput ?? "default-profile")}`,
      licenseToken,
      entitlementId,
      localTools,
      ...(options.rustRunnerBin ? { rustRunnerBin: options.rustRunnerBin } : {}),
      allowShell: false,
      // A release verification turn may use local tools, generate a full
      // deliverable, and pass it through the automated delivery audit. This is
      // deliberately longer than the interactive harness default; it is set
      // explicitly here so normal Desktop turns remain bounded.
      runTimeoutMs: runtimeUatTurnTimeoutMs(),
      runIdFactory: () => `run_runtime_uat_${safeSegment(item.id)}`
    });
    await session.connect();
    try {
      const ready = session.getSessionReady();
      if (!ready || ready.release_id !== publicRelease.release_id || ready.release_digest !== publicRelease.digest) {
        throw new Error(`Runtime session ${item.id} did not bind the server-pinned exact Release`);
      }
      const result = await session.run(item.input);
      const terminalCompleted = result.events.some((event) => event.type === "turn.state" && event.status === "completed");
      if (!terminalCompleted || !result.finalText.trim()) {
        throw new Error(`Runtime UAT ${item.id} did not complete with a Consumer-visible delivery`);
      }
      const workspaceAfter = await snapshotWorkspace(workspace);
      const workspaceArtifacts = changedWorkspaceArtifacts(workspaceBefore, workspaceAfter);
      runs.push({
        id: item.id,
        ...(item.category ? { category: item.category } : {}),
        input: item.input,
        output: result.finalText,
        exact_release_bound: true,
        release_quality_workflow: releaseQualityWorkflow?.mode ?? "none",
        runtime_delivery_audit: runtimeDeliveryAudit,
        terminal_completed: terminalCompleted,
        workspace_inputs: workspaceFiles,
        workspace_artifacts: workspaceArtifacts,
        local_tool_requests: result.events
          .filter((event) => event.type === "tool_call.request")
          .map((event) => event.name),
        local_tool_results: result.events
          .flatMap((event) => event.type === "tool_call.delta" && event.locality === "client" && event.status === "completed"
            ? [event.name]
            : []),
        workspace_diffs: result.events.filter((event) => event.type === "workspace.diff").length,
        delivery_receipts: result.events.filter((event) => event.type === "delivery.ready").length,
        event_types: [...new Set(result.events.map((event) => event.type))]
      });
    } finally {
      session.close();
    }
  }

  const report = {
    // This is the actual Consumer Runtime output, shaped as a candidate run so
    // the blind comparator never substitutes a separate simulated Agent.
    kind: "live_runtime_candidate_run",
    release_id: publicRelease.release_id,
    release_digest: publicRelease.digest,
    inputs_sha256: heldOutInputsSha256,
    model: provider.model,
    execution_surface: "real Hatch Runtime with live Moonshot Kimi 2.6 and Rust-local tool execution",
    semantic_source: options.scenarioWorkspaces
      ? "held-outs run against isolated, case-specific local workspaces; captured artifacts are the Consumer deliveries"
      : "input-only held-outs; this Runtime run does not reuse semantic_uat candidate outputs",
    model_runtime: kimiModelRuntimeRecord(),
    observations: {
      exact_release_resolved: true,
      server_pinned_entitlement: true,
      private_release_materialized: true,
      private_materialization_sha256: sha256(materialized.systemPrompt),
      worker_received_private_skill: privateSkillMaterialized,
      release_quality_workflow: releaseQualityWorkflow?.mode ?? "none",
      runtime_delivery_audit: runtimeDeliveryAudit,
      delivery_audit_enforced: runtimeDeliveryAudit !== "not-enforced",
      external_tools_permitted: materialized.externalTools,
      local_tools_advertised_for_holdouts: localTools,
      local_tool_executor: options.rustRunnerBin ? "rust-sidecar" : "node-harness",
      workspace_input_supplied: Boolean(options.workspaceInput),
      scenario_workspaces_supplied: Boolean(options.scenarioWorkspaces),
      profile_input_supplied: Boolean(options.profileInput),
      entitlement_input_supplied: Boolean(options.entitlementFile)
    },
    runs,
    outputs: runs.map((run) => ({ id: String(run.id), response: String(run.output) })),
    // A Release carries its auditable delivery contract, but ordinary Creator
    // products do not force a second hidden reviewer loop on every Consumer
    // turn. This UAT therefore proves the normal fulfillment path by default;
    // deployments that explicitly opt into `HATCH_RUNTIME_DELIVERY_AUDIT=enforce`
    // additionally prove that the exact Release contract was activated.
    passed: runs.length === heldOutInputs.length
      && runs.every((run) => run.exact_release_bound === true && run.terminal_completed === true)
      && (runtimeDeliveryAudit === "not-enforced" || runtimeDeliveryAudit === releaseQualityWorkflow?.mode)
  };
  await atomicWriteJson(options.outputFile, report);
  process.stdout.write(`${JSON.stringify({
    passed: report.passed,
    release_id: report.release_id,
    release_digest: report.release_digest,
    runs: report.runs.length,
    model_runtime: report.model_runtime
  }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 2;
} finally {
  await runtime.close();
  await rm(scratch, { recursive: true, force: true });
}

function runtimeUatTurnTimeoutMs(): number {
  const configured = Number(process.env.HATCH_RUNTIME_UAT_TURN_TIMEOUT_MS ?? 900_000);
  if (!Number.isFinite(configured) || configured < 180_000) {
    throw new Error("HATCH_RUNTIME_UAT_TURN_TIMEOUT_MS must be at least 180000 milliseconds");
  }
  return configured;
}

function parseArguments(values: string[]): Options {
  const args = new Map<string, string>();
  let preflight = false;
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (name === "--preflight") {
      preflight = true;
      continue;
    }
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid argument near ${name ?? "end"}`);
    args.set(name.slice(2), value);
    index += 1;
  }
  const releaseDirectory = args.get("release");
  const inputsFile = args.get("inputs");
  const outputFile = args.get("output");
  if (!releaseDirectory || !inputsFile || !outputFile) {
    throw new Error("Usage: runtimeUatRunner --release <release/<id>/<digest>> --inputs <held-out-inputs.json> --output <runtime-results.json> [--preflight] [--entitlements <server projection> --license-token <token> --entitlement-id <id>] [--workspace-input <path> | --scenario-workspaces <directory>] [--profile-input <path>] [--rust-runner-bin <binary>] [--model-profile kimi-k2.6]");
  }
  const entitlementFile = args.get("entitlements");
  const entitlementId = args.get("entitlement-id");
  const licenseToken = args.get("license-token");
  if ([entitlementFile, entitlementId, licenseToken].some(Boolean)
    && ![entitlementFile, entitlementId, licenseToken].every(Boolean)) {
    throw new Error("--entitlements, --license-token, and --entitlement-id must be provided together");
  }
  const modelProfile = args.get("model-profile") ?? "kimi-k2.6";
  if (modelProfile !== "kimi-k2.6") throw new Error("Runtime UAT model profile must be exactly kimi-k2.6");
  return {
    releaseDirectory: path.resolve(releaseDirectory),
    inputsFile: path.resolve(inputsFile),
    outputFile: path.resolve(outputFile),
    preflight,
    modelProfile,
    ...(entitlementFile ? { entitlementFile: path.resolve(entitlementFile), entitlementId, licenseToken } : {}),
    ...(args.get("workspace-input") ? { workspaceInput: path.resolve(args.get("workspace-input")!) } : {}),
    ...(args.get("scenario-workspaces") ? { scenarioWorkspaces: path.resolve(args.get("scenario-workspaces")!) } : {}),
    ...(args.get("profile-input") ? { profileInput: path.resolve(args.get("profile-input")!) } : {}),
    ...(args.get("rust-runner-bin") ? { rustRunnerBin: path.resolve(args.get("rust-runner-bin")!) } : {})
  };
}

async function validateOptionalInput(value: string | undefined, label: string): Promise<void> {
  if (!value) return;
  try {
    await stat(value);
  } catch {
    throw new Error(`${label} does not exist: ${value}`);
  }
}

async function validateScenarioWorkspace(root: string, heldOutId: string): Promise<void> {
  const scenario = path.join(root, safeSegment(heldOutId));
  let scenarioStat;
  try {
    scenarioStat = await stat(scenario);
  } catch {
    throw new Error(`Scenario workspace for ${heldOutId} does not exist: ${scenario}`);
  }
  if (!scenarioStat.isDirectory()) {
    throw new Error(`Scenario workspace for ${heldOutId} must be a directory: ${scenario}`);
  }
}

async function validateExactEntitlement(
  entitlementFile: string,
  licenseToken: string,
  entitlementId: string,
  release: z.infer<typeof CreatorReleasePublicSchema>
): Promise<void> {
  const bound = await new FileEntitlementResolver(entitlementFile).resolve({
    licenseToken,
    entitlementId,
    installationId: "runtime-uat-input-validation"
  });
  if (!isReleaseEntitlement(bound)) {
    throw new Error("Provided entitlement points to a current Agent Corpus, not the legacy Creator Release UAT path");
  }
  if (bound.release_id !== release.release_id || bound.release_digest !== release.digest
    || bound.product_id !== release.product_id || bound.creator_id !== release.creator_id) {
    throw new Error("Provided entitlement is not server-pinned to the exact Creator Release");
  }
}

function releaseLocalTools(capabilities: string[]): ClientToolName[] {
  const supported = new Set<ClientToolName>([
    "fs.list", "fs.read", "fs.search", "fs.write", "fs.patch", "shell.exec", "git.diff"
  ]);
  const tools: ClientToolName[] = [];
  for (const capability of capabilities) {
    if (!supported.has(capability as ClientToolName)) {
      throw new Error(`Creator Release declares unsupported local capability: ${capability}`);
    }
    tools.push(capability as ClientToolName);
  }
  return tools;
}

async function seedWorkspace(workspace: string, workspaceInput?: string, profileInput?: string): Promise<string[]> {
  const copied: string[] = [];
  if (workspaceInput) copied.push(...await copyInput(workspaceInput, workspace));
  if (profileInput) copied.push(...await copyInput(profileInput, path.join(workspace, "profile")));
  return copied.sort();
}

async function copyInput(source: string, destination: string): Promise<string[]> {
  const sourceStat = await stat(source);
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    await cp(source, destination, { recursive: true, force: false });
    return listRelativeFiles(destination);
  }
  if (!sourceStat.isFile()) throw new Error(`Runtime UAT input must be a file or directory: ${source}`);
  await mkdir(destination, { recursive: true });
  const target = path.join(destination, path.basename(source));
  await cp(source, target, { force: false, errorOnExist: true });
  return [path.relative(path.dirname(destination), target).replaceAll("\\", "/")];
}

async function listRelativeFiles(root: string, relative = ""): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Runtime UAT inputs must not contain symlinks: ${child}`);
    if (entry.isDirectory()) files.push(...await listRelativeFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Runtime UAT input contains unsupported entry: ${child}`);
  }
  return files;
}

type WorkspaceSnapshot = Map<string, { sha256: string; content: string }>;

async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const files = await listRelativeFiles(root);
  const snapshot: WorkspaceSnapshot = new Map();
  for (const relativePath of files) {
    const content = await readFile(path.join(root, relativePath), "utf8");
    snapshot.set(relativePath, { sha256: sha256(content), content });
  }
  return snapshot;
}

function changedWorkspaceArtifacts(before: WorkspaceSnapshot, after: WorkspaceSnapshot): Array<Record<string, string>> {
  return [...after.entries()]
    .filter(([relativePath, artifact]) => before.get(relativePath)?.sha256 !== artifact.sha256)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, artifact]) => ({
      path: relativePath,
      sha256: artifact.sha256,
      content: artifact.content
    }));
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, "_");
  if (!normalized) throw new Error(`Cannot derive filesystem-safe id from ${value}`);
  return normalized;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
