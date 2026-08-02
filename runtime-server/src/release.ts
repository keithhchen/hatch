import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const RELEASE_CONTRACT_VERSION = "1";
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const IdentifierSchema = z.string().min(1).max(200);

export const DeliveryWorkflowSchema = z.object({
  version: z.literal("1"),
  mode: z.literal("draft_claim_audit_revise"),
  audit: z.object({
    unit: z.literal("atomic_claim"),
    verdicts: z.tuple([
      z.literal("entailed"),
      z.literal("unsupported"),
      z.literal("conflicting"),
      z.literal("confidential"),
      z.literal("out_of_scope")
    ]),
    require_evidence_entailment: z.literal(true),
    check_product_boundaries: z.literal(true),
    coverage: z.object({
      unitization: z.literal("markdown_claim_clauses_v1"),
      require_all_units: z.literal(true),
      max_units: z.number().int().min(1).max(500)
    }).strict(),
    evidence_authority: z.object({
      user_fact_sources: z.tuple([
        z.literal("user_input"),
        z.literal("approved_tool_evidence")
      ]),
      creator_method_sources: z.tuple([z.literal("protected_knowledge")]),
      protected_knowledge_cannot_support_user_specific_claims: z.literal(true)
    }).strict()
  }).strict(),
  audit_instruction: z.string().min(1),
  revision_instruction: z.string().min(1),
  audit_result_format: z.record(z.string(), z.unknown()),
  max_revision_passes: z.number().int().min(1).max(3),
  on_unresolved: z.literal("return_boundary_safe_partial"),
  expose_intermediate: z.literal(false)
}).strict();
export type DeliveryWorkflow = z.infer<typeof DeliveryWorkflowSchema>;

const AssetSchema = z.object({
  id: IdentifierSchema,
  path: z.string().min(1),
  sha256: DigestSchema,
  provenance: z.string().min(1).optional()
}).strict();

export const CreatorReleasePublicSchema = z.object({
  contract_version: z.literal(RELEASE_CONTRACT_VERSION),
  release_id: IdentifierSchema,
  product_id: IdentifierSchema,
  creator_id: IdentifierSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  digest: DigestSchema,
  creator: z.object({ id: IdentifierSchema, name: z.string().min(1) }).strict(),
  product: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    promise: z.string().min(1),
    boundaries: z.array(z.string().min(1)),
    price: z.object({
      model: z.enum(["per_delivery", "subscription"]).optional(),
      amount_minor: z.number().int().nonnegative(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      unit: z.string().min(1).optional()
    }).strict(),
    supported_local_capabilities: z.array(z.string().min(1))
  }).strict(),
  presentation: z.record(z.string(), z.unknown())
}).strict();

export const CreatorReleasePrivateSchema = z.object({
  contract_version: z.literal(RELEASE_CONTRACT_VERSION),
  release_id: IdentifierSchema,
  product_id: IdentifierSchema,
  creator_id: IdentifierSchema,
  version: z.string().min(1),
  digest: DigestSchema,
  system_prompt: z.string().min(1),
  protected_skills: z.object({ root: z.string().min(1), assets: z.array(AssetSchema) }).strict(),
  rag: z.object({ root: z.string().min(1), documents: z.array(AssetSchema) }).strict(),
  agent_corpus: z.object({ root: z.string().min(1), manifest: z.string().min(1), assets: z.array(AssetSchema) }).strict().optional(),
  few_shots: z.array(z.record(z.string(), z.unknown())),
  runtime_policy: z.record(z.string(), z.unknown())
}).strict();

export type CreatorReleasePublic = z.infer<typeof CreatorReleasePublicSchema>;
export type CreatorReleasePrivate = z.infer<typeof CreatorReleasePrivateSchema>;
export type ResolvedCreatorRelease = {
  public: CreatorReleasePublic;
  private: CreatorReleasePrivate;
  releaseDirectory: string;
  protectedSkillsRoot: string;
  ragRoot: string;
  agentCorpusRoot?: string;
};

export function deliveryWorkflowForRelease(release: ResolvedCreatorRelease): DeliveryWorkflow | undefined {
  const workflow = release.private.runtime_policy.delivery_workflow;
  return workflow === undefined ? undefined : DeliveryWorkflowSchema.parse(workflow);
}

export function computeCreatorReleaseDigest(
  publicRelease: Omit<CreatorReleasePublic, "digest"> | CreatorReleasePublic,
  privateRelease: Omit<CreatorReleasePrivate, "digest"> | CreatorReleasePrivate
): string {
  return sha256(canonicalJson({
    public: withoutDigest(publicRelease),
    private: withoutDigest(privateRelease)
  }));
}

export class CreatorReleaseResolver {
  constructor(private readonly releasesRoot: string) {}

  async resolve(releaseId: string, expectedDigest: string): Promise<ResolvedCreatorRelease> {
    DigestSchema.parse(expectedDigest);
    const releaseDirectory = await containedRealpath(this.releasesRoot, path.join(releaseId, expectedDigest));
    const publicRelease = CreatorReleasePublicSchema.parse(JSON.parse(await readFile(path.join(releaseDirectory, "public.json"), "utf8")));
    const privateRelease = CreatorReleasePrivateSchema.parse(JSON.parse(await readFile(path.join(releaseDirectory, "private.json"), "utf8")));

    for (const release of [publicRelease, privateRelease]) {
      if (release.release_id !== releaseId || release.digest !== expectedDigest) {
        throw new Error(`Creator Release identity mismatch for ${releaseId}@${expectedDigest}`);
      }
    }
    if (publicRelease.product_id !== privateRelease.product_id
      || publicRelease.creator_id !== privateRelease.creator_id
      || publicRelease.version !== privateRelease.version) {
      throw new Error("Creator Release public/private metadata mismatch");
    }
    await verifyVersionOneShape(releaseDirectory, publicRelease, privateRelease);
    const actualDigest = computeCreatorReleaseDigest(publicRelease, privateRelease);
    if (actualDigest !== expectedDigest) {
      throw new Error(`Creator Release digest mismatch: expected ${expectedDigest}, computed ${actualDigest}`);
    }

    const protectedSkillsRoot = await containedRealpath(releaseDirectory, privateRelease.protected_skills.root);
    const ragRoot = await containedRealpath(releaseDirectory, privateRelease.rag.root);
    await verifyAssets(protectedSkillsRoot, privateRelease.protected_skills.assets);
    await verifyAssets(ragRoot, privateRelease.rag.documents);
    const agentCorpusRoot = privateRelease.agent_corpus
      ? await containedRealpath(releaseDirectory, privateRelease.agent_corpus.root)
      : undefined;
    if (agentCorpusRoot && privateRelease.agent_corpus) {
      await verifyAssets(agentCorpusRoot, privateRelease.agent_corpus.assets);
      await containedRealpath(agentCorpusRoot, privateRelease.agent_corpus.manifest);
    }
    return { public: publicRelease, private: privateRelease, releaseDirectory, protectedSkillsRoot, ragRoot, ...(agentCorpusRoot ? { agentCorpusRoot } : {}) };
  }
}

async function verifyVersionOneShape(
  releaseDirectory: string,
  publicRelease: CreatorReleasePublic,
  privateRelease: CreatorReleasePrivate
): Promise<void> {
  const expectedReleaseId = `${publicRelease.product_id}@${publicRelease.version}`;
  if (publicRelease.release_id !== expectedReleaseId) {
    throw new Error(`Creator Release v1 release_id must be ${expectedReleaseId}`);
  }
  if (privateRelease.protected_skills.root !== "skills" || privateRelease.rag.root !== "rag") {
    throw new Error("Creator Release v1 requires skills and rag roots");
  }

  const expectedSkillPath = `${publicRelease.product_id}/SKILL.md`;
  const skillPaths = privateRelease.protected_skills.assets.map((asset) => normalizeReleasePath(asset.path));
  if (skillPaths.length !== 1 || skillPaths[0] !== expectedSkillPath) {
    throw new Error(`Creator Release v1 requires exactly one Skill at skills/${expectedSkillPath}`);
  }

  const ragPaths = privateRelease.rag.documents.map((asset) => normalizeReleasePath(asset.path)).sort();
  if (ragPaths.length !== 2 || ragPaths[0] !== "chunks.json" || ragPaths[1] !== "documents.json") {
    throw new Error("Creator Release v1 requires exactly rag/documents.json and rag/chunks.json");
  }

  const expectedFiles = new Set([
    "public.json",
    "private.json",
    `skills/${expectedSkillPath}`,
    "rag/documents.json",
    "rag/chunks.json"
  ]);
  const agentCorpus = privateRelease.agent_corpus;
  if (agentCorpus) {
    for (const asset of agentCorpus.assets) {
      expectedFiles.add(`${normalizeReleasePath(agentCorpus.root)}/${normalizeReleasePath(asset.path)}`);
    }
  }
  const actualFiles = new Set(await listReleaseFiles(releaseDirectory));
  const unexpected = [...actualFiles].filter((file) => !expectedFiles.has(file)).sort();
  const missing = [...expectedFiles].filter((file) => !actualFiles.has(file)).sort();
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`Creator Release v1 file shape mismatch; unexpected=${JSON.stringify(unexpected)} missing=${JSON.stringify(missing)}`);
  }
}

async function listReleaseFiles(root: string, relative = ""): Promise<string[]> {
  const directory = relative ? path.join(root, relative) : root;
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Creator Release must not contain symlinks: ${child}`);
    if (entry.isDirectory()) {
      files.push(...await listReleaseFiles(root, child));
    } else if (entry.isFile()) {
      files.push(child);
    } else {
      throw new Error(`Creator Release contains unsupported entry: ${child}`);
    }
  }
  return files;
}

function normalizeReleasePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

async function verifyAssets(root: string, assets: z.infer<typeof AssetSchema>[]): Promise<void> {
  for (const asset of assets) {
    const assetPath = await containedRealpath(root, asset.path);
    const actual = sha256(await readFile(assetPath));
    if (actual !== asset.sha256) {
      throw new Error(`Private asset digest mismatch for ${asset.id}: expected ${asset.sha256}, computed ${actual}`);
    }
  }
}

async function containedRealpath(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative)) throw new Error(`Release path must be relative: ${relative}`);
  const realRoot = await realpath(root);
  const resolved = await realpath(path.resolve(realRoot, relative));
  if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Release path escapes its root: ${relative}`);
  }
  return resolved;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function withoutDigest<T extends object>(value: T): Omit<T, "digest"> {
  const { digest: _digest, ...rest } = value as T & { digest?: unknown };
  return rest;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
