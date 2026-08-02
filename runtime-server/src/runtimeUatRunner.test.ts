import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import { computeCreatorReleaseDigest, type CreatorReleasePrivate, type CreatorReleasePublic } from "./release.js";

const execFileAsync = promisify(execFile);
const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtimeUatRunner.js");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("Runtime UAT preflight validates exact Release, entitlement, workspace, profile, and Kimi-only model without network", async () => {
  const fixture = await createFixture();
  const { stdout } = await execFileAsync(process.execPath, [runner,
    "--preflight",
    "--release", fixture.releaseDirectory,
    "--inputs", fixture.inputsFile,
    "--output", fixture.outputFile,
    "--entitlements", fixture.entitlementFile,
    "--license-token", "license-fixture",
    "--entitlement-id", "entitlement-fixture",
    "--workspace-input", fixture.workspaceInput,
    "--profile-input", fixture.profileInput,
    "--model-profile", "kimi-k2.6"
  ], { env: withoutModelSecrets(process.env) });

  const report = JSON.parse(stdout);
  assert.equal(report.mode, "preflight");
  assert.equal(report.ready, true);
  assert.equal(report.release_id, "signal-review@1.0.0");
  assert.equal(report.release_digest, fixture.digest);
  assert.equal(report.model_profile, "kimi-k2.6");
  assert.deepEqual(report.local_tools, ["fs.read", "fs.write"]);
  assert.equal(report.entitlement_input, "provided");
  assert.deepEqual(report.workspace_files, ["profile/profile.md", "resume.md"]);
});

test("Runtime UAT preflight rejects alternate models and a differently pinned entitlement", async () => {
  const fixture = await createFixture();
  await assert.rejects(
    execFileAsync(process.execPath, [runner,
      "--preflight", "--release", fixture.releaseDirectory, "--inputs", fixture.inputsFile,
      "--output", fixture.outputFile, "--model-profile", "deepseek-chat"
    ], { env: withoutModelSecrets(process.env) }),
    /model profile must be exactly kimi-k2\.6/
  );

  const mismatched = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(fixture.entitlementFile, "utf8")));
  mismatched[0].release_digest = `sha256:${"f".repeat(64)}`;
  await writeFile(fixture.entitlementFile, JSON.stringify(mismatched), "utf8");
  await assert.rejects(
    execFileAsync(process.execPath, [runner,
      "--preflight", "--release", fixture.releaseDirectory, "--inputs", fixture.inputsFile,
      "--output", fixture.outputFile, "--entitlements", fixture.entitlementFile,
      "--license-token", "license-fixture", "--entitlement-id", "entitlement-fixture"
    ], { env: withoutModelSecrets(process.env) }),
    /not server-pinned to the exact Creator Release/
  );
});

test("Runtime UAT preflight binds each held-out run to its isolated workspace", async () => {
  const fixture = await createFixture();
  const { stdout } = await execFileAsync(process.execPath, [runner,
    "--preflight",
    "--release", fixture.releaseDirectory,
    "--inputs", fixture.inputsFile,
    "--output", fixture.outputFile,
    "--scenario-workspaces", fixture.scenarioWorkspaces,
    "--model-profile", "kimi-k2.6"
  ], { env: withoutModelSecrets(process.env) });

  const report = JSON.parse(stdout);
  assert.equal(report.workspace_input, null);
  assert.equal(report.scenario_workspaces, fixture.scenarioWorkspaces);
  assert.deepEqual(report.workspace_files, ["scenario-resume.md"]);
});

test("Runtime UAT execution has no OPENAI_API_KEY fallback", async () => {
  const fixture = await createFixture();
  const env = withoutModelSecrets(process.env);
  env.OPENAI_API_KEY = "must-not-be-used";
  await assert.rejects(
    execFileAsync(process.execPath, [runner,
      "--release", fixture.releaseDirectory,
      "--inputs", fixture.inputsFile,
      "--output", fixture.outputFile
    ], { env }),
    /Missing LLM_API_KEY for the Kimi-only runtime/
  );
});

async function createFixture(): Promise<{
  releaseDirectory: string;
  inputsFile: string;
  outputFile: string;
  entitlementFile: string;
  workspaceInput: string;
  scenarioWorkspaces: string;
  profileInput: string;
  digest: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-uat-test-"));
  temporaryDirectories.push(root);
  const releaseId = "signal-review@1.0.0";
  const skill = "---\nname: signal-review\ndescription: Review a workspace.\n---\nRead the supplied evidence and never invent facts.";
  const documents = JSON.stringify([{ id: "document-1", text: "Use evidence before wording." }]);
  const chunks = JSON.stringify([{ id: "chunk-1", text: "Never invent metrics." }]);
  const publicBase: Omit<CreatorReleasePublic, "digest"> = {
    contract_version: "1",
    release_id: releaseId,
    product_id: "signal-review",
    creator_id: "maya",
    version: "1.0.0",
    creator: { id: "maya", name: "Maya" },
    product: {
      name: "Signal Review",
      description: "Review workspace evidence.",
      promise: "Produce an evidence-grounded review.",
      boundaries: ["No invented facts."],
      price: { model: "per_delivery", amount_minor: 3900, currency: "USD" },
      supported_local_capabilities: ["fs.read", "fs.write"]
    },
    presentation: {}
  };
  const privateBase: Omit<CreatorReleasePrivate, "digest"> = {
    contract_version: "1",
    release_id: releaseId,
    product_id: "signal-review",
    creator_id: "maya",
    version: "1.0.0",
    system_prompt: "Apply Maya's evidence standard.",
    protected_skills: { root: "skills", assets: [
      { id: "signal-review", path: "signal-review/SKILL.md", sha256: digest(skill) }
    ] },
    rag: { root: "rag", documents: [
      { id: "documents", path: "documents.json", sha256: digest(documents) },
      { id: "chunks", path: "chunks.json", sha256: digest(chunks) }
    ] },
    few_shots: [],
    runtime_policy: {
      local_tools: ["fs.read", "fs.write"],
      external_tools: [],
      delivery_workflow: deliveryWorkflow()
    }
  };
  const releaseDigest = computeCreatorReleaseDigest(publicBase, privateBase);
  const releaseDirectory = path.join(root, "release", releaseId, releaseDigest);
  await mkdir(path.join(releaseDirectory, "skills", "signal-review"), { recursive: true });
  await mkdir(path.join(releaseDirectory, "rag"), { recursive: true });
  await writeFile(path.join(releaseDirectory, "public.json"), JSON.stringify({ ...publicBase, digest: releaseDigest }), "utf8");
  await writeFile(path.join(releaseDirectory, "private.json"), JSON.stringify({ ...privateBase, digest: releaseDigest }), "utf8");
  await writeFile(path.join(releaseDirectory, "skills", "signal-review", "SKILL.md"), skill, "utf8");
  await writeFile(path.join(releaseDirectory, "rag", "documents.json"), documents, "utf8");
  await writeFile(path.join(releaseDirectory, "rag", "chunks.json"), chunks, "utf8");

  const inputsFile = path.join(root, "review", "held-out-inputs.json");
  const outputFile = path.join(root, "review", "runtime-results.json");
  await mkdir(path.dirname(inputsFile), { recursive: true });
  await writeFile(inputsFile, JSON.stringify([{ id: "H-001", category: "direct", input: "Review the supplied resume." }]), "utf8");
  const entitlementFile = path.join(root, "entitlements.json");
  await writeFile(entitlementFile, JSON.stringify([{
    license_token: "license-fixture",
    entitlement_id: "entitlement-fixture",
    order_id: "order-fixture",
    tenant_id: "tenant-fixture",
    user_id: "user-fixture",
    creator_id: "maya",
    product_id: "signal-review",
    release_id: releaseId,
    release_digest: releaseDigest,
    status: "active"
  }]), "utf8");
  const workspaceInput = path.join(root, "workspace");
  await mkdir(workspaceInput, { recursive: true });
  await writeFile(path.join(workspaceInput, "resume.md"), "Verified evidence.", "utf8");
  const profileInput = path.join(root, "profile.md");
  await writeFile(profileInput, "Target role: Product Lead", "utf8");
  const scenarioWorkspaces = path.join(root, "scenario-workspaces");
  await mkdir(path.join(scenarioWorkspaces, "H-001"), { recursive: true });
  await writeFile(path.join(scenarioWorkspaces, "H-001", "scenario-resume.md"), "Isolated scenario evidence.", "utf8");
  return { releaseDirectory, inputsFile, outputFile, entitlementFile, workspaceInput, scenarioWorkspaces, profileInput, digest: releaseDigest };
}

function deliveryWorkflow(): Record<string, unknown> {
  return {
    version: "1",
    mode: "draft_claim_audit_revise",
    audit: {
      unit: "atomic_claim",
      verdicts: ["entailed", "unsupported", "conflicting", "confidential", "out_of_scope"],
      require_evidence_entailment: true,
      check_product_boundaries: true,
      coverage: { unitization: "markdown_claim_clauses_v1", require_all_units: true, max_units: 200 },
      evidence_authority: {
        user_fact_sources: ["user_input", "approved_tool_evidence"],
        creator_method_sources: ["protected_knowledge"],
        protected_knowledge_cannot_support_user_specific_claims: true
      }
    },
    audit_instruction: "Audit every claim.",
    revision_instruction: "Remove unsupported claims.",
    audit_result_format: { claims: [] },
    max_revision_passes: 2,
    on_unresolved: "return_boundary_safe_partial",
    expose_intermediate: false
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function withoutModelSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  copy.LLM_API_KEY = "";
  delete copy.OPENAI_API_KEY;
  delete copy.OPENAI_BASE_URL;
  return copy;
}
