import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { traceGeneration, usageOf } from "./langfuse.js";
import { readBoundedJsonObject } from "./boundedResponse.js";
import { requireUuidV4, UUID_V4_RE } from "./identity.js";
import { normalizeBriefSpec, type BriefSpec } from "./brief.js";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const IdentifierSchema = z.string().min(1).max(128).regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/);
const AuthorityIdSchema = z.string().regex(UUID_V4_RE);
const ToolIdentifierSchema = z.string().min(1).max(256).regex(/^(?:hatch|creator)\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const NameSchema = z.string().min(1).max(256);
const DescriptionSchema = z.string().min(1).max(4_096);
const PathSchema = z.string().min(1).max(1_024);
const BoundedJsonObjectSchema = z.record(z.string().min(1).max(128), z.unknown()).superRefine((value, context) => {
  const failure = embeddedJsonLimitFailure(value);
  if (failure) context.addIssue({ code: "custom", message: failure });
});
const BriefSpecSchema = z.unknown().transform((value, context): BriefSpec | typeof z.NEVER => {
  try {
    return normalizeBriefSpec(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "BriefSpec is invalid" });
    return z.NEVER;
  }
});
const IMMUTABLE_CORPORA_DIRECTORY = ".immutable-corpora";
const CURRENT_CORPORA_DIRECTORY = ".current-corpora";

export const AGENT_CORPUS_MANIFEST_MAX_BYTES = 1024 * 1024;
export const AGENT_CORPUS_ASSET_MAX_BYTES = 4 * 1024 * 1024;
export const AGENT_CORPUS_TOTAL_ASSET_MAX_BYTES = 16 * 1024 * 1024;

const AssetSchema = z.object({
  id: IdentifierSchema,
  path: PathSchema,
  sha256: DigestSchema,
  description: DescriptionSchema.optional()
}).strict();

const ToolSchema = z.object({
  id: ToolIdentifierSchema,
  kind: z.string().min(1).max(64),
  capability: z.string().min(1).max(64).optional(),
  connection_ref: IdentifierSchema.optional(),
  operation: z.string().min(1).max(256).optional(),
  tool_name: z.string().min(1).max(256).optional(),
  description: DescriptionSchema.optional(),
  input_schema: BoundedJsonObjectSchema.optional()
}).strict();

export const AgentCorpusSchema = z.object({
  contract_version: z.literal("1"),
  creator: z.object({ id: AuthorityIdSchema, name: NameSchema }).strict(),
  release: z.object({ backward_compatible_with: DigestSchema }).strict().optional(),
  product: z.object({
    id: AuthorityIdSchema,
    name: NameSchema,
    description: DescriptionSchema.optional(),
    promise: DescriptionSchema.optional(),
    boundaries: z.array(z.string().min(1).max(512)).max(32).default([]),
    brief_spec: BriefSpecSchema.optional(),
    presentation: BoundedJsonObjectSchema.default({})
  }).strict(),
  instructions: z.object({ system: AssetSchema }).strict(),
  skills: z.array(z.object({
    id: IdentifierSchema,
    name: NameSchema,
    when_to_use: DescriptionSchema,
    instruction: AssetSchema,
    references: z.array(z.object({ asset: AssetSchema, kind: z.enum(["method", "style", "example", "few_shots"]) }).strict()).max(64).default([]),
    allowed_tool_ids: z.array(ToolIdentifierSchema).max(64).default([])
  }).strict()).max(32).default([]),
  tools: z.array(ToolSchema).min(1).max(64),
  evaluations: z.object({
    synthetic_qa: z.array(AssetSchema).max(128).default([]),
    held_out: z.array(AssetSchema).max(128).default([])
  }).strict().default({ synthetic_qa: [], held_out: [] })
}).strict().transform((value) => ({ ...value, agent_id: value.product.id }));

export type AgentCorpus = z.infer<typeof AgentCorpusSchema>;

export type CreatorCorpusTool = {
  id: string;
  kind: "http_function" | "mcp_tool";
  connection_ref: string;
  operation: string;
  tool_name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
};

export type ResolvedAgentCorpus = {
  root: string;
  corpus: AgentCorpus;
  digest: string;
  /** Digest of the installed Runtime representation; source digest remains `digest`. */
  runtimeDigest?: string;
};

/**
 * Runtime only depends on this small resolver boundary.  The filesystem
 * resolver below is retained for explicit local development, while the
 * production implementation reads the Registry live release and materializes
 * a verified cache from OSS.
 */
export interface AgentCorpusResolverLike {
  resolve(
    creatorId: string,
    agentId: string,
    digestOrSignal?: string | AbortSignal,
    explicitSignal?: AbortSignal
  ): Promise<ResolvedAgentCorpus>;
  /** Resolves a Product's live release; its owner comes from the server, never the client. */
  resolveByProduct(productId: string, signal?: AbortSignal): Promise<ResolvedAgentCorpus>;
  /** An account's own published Products. */
  list(creatorId: string, signal?: AbortSignal): Promise<ResolvedAgentCorpus[]>;
}

/**
 * Resolves the one current Corpus installed by Registry. The Runtime only
 * needs a creator/agent lookup; it does not know how the Corpus was produced.
 */
export class AgentCorpusResolver implements AgentCorpusResolverLike {
  constructor(private readonly root: string) {}

  async resolve(
    creatorId: string,
    agentId: string,
    digestOrSignal?: string | AbortSignal,
    explicitSignal?: AbortSignal
  ): Promise<ResolvedAgentCorpus> {
    requireUuidV4(creatorId, "creator_id");
    requireUuidV4(agentId, "product_id");
    const selectedDigest = typeof digestOrSignal === "string" ? digestOrSignal : undefined;
    const signal = typeof digestOrSignal === "string" ? explicitSignal : digestOrSignal;
    signal?.throwIfAborted();
    const currentDigest = selectedDigest ?? await this.readCurrentDigest(creatorId, agentId);
    let corpusRoot = currentDigest
      ? await containedPath(this.root, path.join(
        IMMUTABLE_CORPORA_DIRECTORY,
        creatorId,
        agentId,
        `sha256-${currentDigest.slice("sha256:".length)}`
      ))
      : await containedPath(this.root, path.join(creatorId, agentId));
    let corpus: AgentCorpus;
    try {
      corpus = await loadAgentCorpus(corpusRoot, signal);
    } catch (error) {
      if (!currentDigest || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Migration fixtures may still hold a digest-exact release in the
      // legacy current directory. The digest check below prevents fallback to
      // a different release.
      corpusRoot = await containedPath(this.root, path.join(creatorId, agentId));
      corpus = await loadAgentCorpus(corpusRoot, signal);
    }
    if (corpus.creator.id !== creatorId || corpus.agent_id !== agentId) {
      throw new Error("Agent Corpus binding does not match the requested creator and agent");
    }
    const digest = await agentCorpusDigest(corpusRoot, corpus, signal);
    if (currentDigest && digest !== currentDigest) {
      throw new Error(`Agent Corpus release digest mismatch: expected ${currentDigest}, received ${digest}`);
    }
    signal?.throwIfAborted();
    return { root: corpusRoot, corpus, digest };
  }

  async resolveByProduct(productId: string, signal?: AbortSignal): Promise<ResolvedAgentCorpus> {
    requireUuidV4(productId, "product_id");
    const creatorIds = new Set<string>();
    for (const directory of [this.root, path.join(this.root, CURRENT_CORPORA_DIRECTORY)]) {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && UUID_V4_RE.test(entry.name)) creatorIds.add(entry.name);
      }
    }
    for (const creatorId of [...creatorIds].sort()) {
      signal?.throwIfAborted();
      const resolved = await this.resolve(creatorId, productId, signal).catch(() => undefined);
      if (resolved) return resolved;
    }
    throw new Error(`No current Agent Corpus exists for Product ${productId}`);
  }

  async list(creatorId: string, signal?: AbortSignal): Promise<ResolvedAgentCorpus[]> {
    requireUuidV4(creatorId, "creator_id");
    signal?.throwIfAborted();
    const creatorRoot = await containedPath(this.root, creatorId);
    const legacyEntries = await (async () => {
      try {
        return await (await import("node:fs/promises")).readdir(creatorRoot, { withFileTypes: true });
      } catch {
        return [];
      }
    })();
    const pointerRoot = await containedPath(this.root, path.join(CURRENT_CORPORA_DIRECTORY, creatorId));
    const pointerEntries = await readdir(pointerRoot, { withFileTypes: true }).catch(() => []);
    const agentIds = new Set<string>();
    for (const entry of legacyEntries) if (entry.isDirectory()) agentIds.add(entry.name);
    for (const entry of pointerEntries) {
      if (entry.isFile() && entry.name.endsWith(".json")) agentIds.add(entry.name.slice(0, -5));
    }
    const agents: ResolvedAgentCorpus[] = [];
    for (const agentId of [...agentIds].sort()) {
      signal?.throwIfAborted();
      try {
        agents.push(await this.resolve(creatorId, agentId, signal));
      } catch {
        signal?.throwIfAborted();
        // A single incomplete staging directory must not hide other agents.
      }
    }
    return agents;
  }

  private async readCurrentDigest(creatorId: string, agentId: string): Promise<string | undefined> {
    const pointerPath = await containedPath(this.root, path.join(CURRENT_CORPORA_DIRECTORY, creatorId, `${agentId}.json`));
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(pointerPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = z.object({
      schema_version: z.literal(1),
      creator_id: z.literal(creatorId),
      agent_id: z.literal(agentId),
      corpus_digest: DigestSchema,
      activated_at: z.string().datetime()
    }).strict().safeParse(raw);
    if (!parsed.success) throw new Error(`Agent Corpus current pointer is invalid: ${creatorId}/${agentId}`);
    return parsed.data.corpus_digest;
  }
}

export async function loadAgentCorpus(root: string, signal?: AbortSignal): Promise<AgentCorpus> {
  const manifestPath = await containedPath(root, "agent.json");
  const manifest = await readFile(manifestPath, signal ? { signal } : undefined);
  if (manifest.byteLength > AGENT_CORPUS_MANIFEST_MAX_BYTES) {
    throw new Error("Agent Corpus manifest is too large");
  }
  const corpus = AgentCorpusSchema.parse(stripRetiredManifestFields(JSON.parse(manifest.toString("utf8"))));
  const forbidden = new Set(["provider", "api_key", "credential", "credentials", "endpoint", "vector_store_id", "raw_material", "factory_trace"]);
  const leaked = findForbiddenKeys(corpus, forbidden);
  if (leaked.length) throw new Error(`Agent Corpus contains runtime or Factory fields: ${leaked.join(", ")}`);
  if (corpus.instructions.system.path !== "instructions/system.md") {
    throw new Error("Agent Corpus system instructions must live at instructions/system.md");
  }
  if (!corpus.tools.some((tool) => tool.id === "hatch.web_search")) {
    throw new Error("Agent Corpus must declare hatch.web_search");
  }
  const assets = [
    corpus.instructions.system,
    ...corpus.skills.flatMap((skill) => [skill.instruction, ...skill.references.map((reference) => reference.asset)]),
    ...corpus.evaluations.synthetic_qa,
    ...corpus.evaluations.held_out
  ];
  let totalAssetBytes = 0;
  for (const asset of assets) {
    const absolute = await containedPath(root, asset.path);
    const metadata = await stat(absolute);
    if (!metadata.isFile() || metadata.size > AGENT_CORPUS_ASSET_MAX_BYTES) {
      throw new Error(`Agent Corpus asset exceeds the ${AGENT_CORPUS_ASSET_MAX_BYTES} byte limit: ${asset.path}`);
    }
    totalAssetBytes += metadata.size;
    if (totalAssetBytes > AGENT_CORPUS_TOTAL_ASSET_MAX_BYTES) {
      throw new Error(`Agent Corpus assets exceed the ${AGENT_CORPUS_TOTAL_ASSET_MAX_BYTES} byte total limit`);
    }
    const digest = await fileSha256(absolute, signal);
    if (digest !== asset.sha256) throw new Error(`Agent Corpus asset digest mismatch: ${asset.path}`);
  }
  return corpus;
}

/**
 * Read boundary for releases published before a capability was retired. Their
 * immutable bytes and digests stay as published; the retired fields are
 * discarded here and never reach Runtime: the storefront `product.offer` and
 * the knowledge retrieval layer (`knowledge` plus the `hatch.file_search` tool).
 */
export function stripRetiredManifestFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const manifest = structuredClone(value) as Record<string, unknown>;
  delete manifest.knowledge;
  if (Array.isArray(manifest.tools)) {
    manifest.tools = manifest.tools.filter((tool) => (tool as { id?: unknown } | null)?.id !== RETIRED_FILE_SEARCH_TOOL_ID);
  }
  if (Array.isArray(manifest.skills)) {
    for (const skill of manifest.skills as Array<Record<string, unknown>>) {
      if (Array.isArray(skill?.allowed_tool_ids)) {
        skill.allowed_tool_ids = skill.allowed_tool_ids.filter((id) => id !== RETIRED_FILE_SEARCH_TOOL_ID);
      }
    }
  }
  if (manifest.product && typeof manifest.product === "object" && !Array.isArray(manifest.product)) {
    delete (manifest.product as Record<string, unknown>).offer;
  }
  return manifest;
}

const RETIRED_FILE_SEARCH_TOOL_ID = "hatch.file_search";

function embeddedJsonLimitFailure(value: Record<string, unknown>): string | undefined {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return "embedded JSON must be serializable";
  }
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) return "embedded JSON must not exceed 16 KiB";

  let nodes = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 1_024) return "embedded JSON must not exceed 1024 values";
    if (current.depth > 8) return "embedded JSON must not exceed 8 levels";
    if (typeof current.value === "string" && current.value.length > 4_096) {
      return "embedded JSON strings must not exceed 4096 characters";
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > 128) return "embedded JSON arrays must not exceed 128 items";
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === "object") {
      const entries = Object.entries(current.value);
      if (entries.length > 128) return "embedded JSON objects must not exceed 128 fields";
      for (const [key, child] of entries) {
        if (key.length > 128) return "embedded JSON keys must not exceed 128 characters";
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return undefined;
}

/** Computes the same installed-Corpus digest that Registry records at publish time. */
export async function agentCorpusDigest(
  root: string,
  corpus: AgentCorpus,
  signal?: AbortSignal
): Promise<string> {
  const sourceDigestPath = await containedPath(root, ".hatch-source-corpus-digest");
  try {
    const sourceDigest = (await readFile(sourceDigestPath, signal ? { encoding: "utf8", signal } : "utf8")).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(sourceDigest)) {
      throw new Error("Runtime Corpus cache source digest is invalid");
    }
    return sourceDigest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const assets = [
    corpus.instructions.system,
    ...corpus.skills.flatMap((skill) => [skill.instruction, ...skill.references.map((reference) => reference.asset)]),
    ...corpus.evaluations.synthetic_qa,
    ...corpus.evaluations.held_out
  ];
  const rows: Array<[string, string]> = assets.map((asset): [string, string] => [asset.path.replaceAll(path.sep, "/"), asset.sha256]);
  try {
    const manifestPath = await containedPath(root, "agent.json");
    rows.push(["agent.json", await fileSha256(manifestPath, signal)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // New Runtime releases are authoritative in runtime/manifest.json and
    // deliberately do not require the legacy agent.json compatibility file.
  }
  rows.sort((left, right) => left[0].localeCompare(right[0]));
  return `sha256:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
}

async function fileSha256(filePath: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, signal ? { signal } : undefined);
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return `sha256:${hash.digest("hex")}`;
}

function findForbiddenKeys(value: unknown, forbidden: Set<string>, found: Set<string> = new Set()): string[] {
  if (Array.isArray(value)) {
    for (const item of value) findForbiddenKeys(item, forbidden, found);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) found.add(key);
      findForbiddenKeys(child, forbidden, found);
    }
  }
  return [...found].sort();
}

export async function readCorpusAsset(
  root: string,
  asset: { path: string; sha256: string },
  signal?: AbortSignal
): Promise<string> {
  const absolute = await containedPath(root, asset.path);
  const metadata = await stat(absolute);
  if (!metadata.isFile() || metadata.size > AGENT_CORPUS_ASSET_MAX_BYTES) {
    throw new Error(`Agent Corpus asset exceeds the ${AGENT_CORPUS_ASSET_MAX_BYTES} byte limit: ${asset.path}`);
  }
  const content = await readFile(absolute, signal ? { encoding: "utf8", signal } : "utf8");
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (digest !== asset.sha256) throw new Error(`Agent Corpus asset digest mismatch: ${asset.path}`);
  return content;
}

async function containedPath(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new Error(`Agent Corpus asset path must stay inside root: ${relative}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Agent Corpus asset path escapes root: ${relative}`);
  }
  return resolved;
}
