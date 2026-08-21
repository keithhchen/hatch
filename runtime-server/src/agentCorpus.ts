import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
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
  knowledge: z.object({
    documents: z.array(AssetSchema.extend({
      retrieval_only: z.literal(true),
      source_summary: DescriptionSchema
    }).strict()).max(256).default([])
  }).strict().default({ documents: [] }),
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
  list(creatorId: string, signal?: AbortSignal): Promise<ResolvedAgentCorpus[]>;
}

/**
 * Resolves the one current Corpus installed by Registry. The Runtime only
 * needs a creator/agent lookup; it does not know how the Corpus was produced
 * or how its retrieval index was populated.
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

export type KnowledgeSearchRequest = {
  creatorId: string;
  agentId: string;
  corpusDigest: string;
  query: string;
  limit: number;
  signal?: AbortSignal;
};

export type KnowledgeHit = {
  id: string;
  text: string;
  score: number;
  document_id?: string;
  source_path?: string;
  heading?: string;
  source?: string;
};

/**
 * Stable seam for the self-hosted Qdrant index.
 * Corpus and Runtime do not know which backend is used.
 */
export interface KnowledgeProvider {
  search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]>;
}

export class KnowledgeProviderUnavailable extends Error {
  constructor() {
    super("Creator knowledge retrieval is not configured (set HATCH_QDRANT_URL and DASHSCOPE_API_KEY)");
    this.name = "KnowledgeProviderUnavailable";
  }
}

class UnconfiguredKnowledgeProvider implements KnowledgeProvider {
  async search(_request: KnowledgeSearchRequest): Promise<KnowledgeHit[]> {
    throw new KnowledgeProviderUnavailable();
  }
}

/** Legacy HTTP seam retained for local gateways and contract tests. */
export class HttpKnowledgeProvider implements KnowledgeProvider {
  constructor(
    private readonly endpoint: string,
    private readonly headers: Record<string, string> = {},
    private readonly timeoutMs = 120_000
  ) {}

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...this.headers },
      body: JSON.stringify({
        creator_id: request.creatorId,
        agent_id: request.agentId,
        corpus_digest: request.corpusDigest,
        query: request.query,
        top_k: request.limit
      }),
      signal: boundedKnowledgeSignal(request.signal, this.timeoutMs)
    });
    if (!response.ok) throw new Error(`Knowledge provider failed with HTTP ${response.status}`);
    const payload = await readBoundedJsonObject(response) as { hits?: unknown };
    if (!Array.isArray(payload.hits)) return [];
    return payload.hits.flatMap((item): KnowledgeHit[] => {
      if (!item || typeof item !== "object") return [];
      const hit = item as Record<string, unknown>;
      if (typeof hit.id !== "string" || typeof hit.text !== "string") return [];
      return [{
        id: hit.id,
        text: hit.text,
        score: typeof hit.score === "number" ? hit.score : 0,
        ...(typeof hit.document_id === "string" ? { document_id: hit.document_id } : {}),
        ...(typeof hit.source_path === "string" ? { source_path: hit.source_path } : {}),
        ...(typeof hit.heading === "string" ? { heading: hit.heading } : {}),
        ...(typeof hit.source === "string" ? { source: hit.source } : {})
      }];
    });
  }
}

export class QdrantKnowledgeProvider implements KnowledgeProvider {
  private readonly collection: string;
  private readonly embeddingBaseUrl: string;
  private readonly rerankBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly qdrantUrl: string,
    private readonly qdrantApiKey: string | undefined,
    private readonly dashscopeApiKey: string,
    options: { collection?: string; embeddingBaseUrl?: string; rerankBaseUrl?: string; timeoutMs?: number } = {}
  ) {
    this.collection = options.collection?.trim() || "hatch_knowledge_text_v4_1024";
    this.embeddingBaseUrl = (options.embeddingBaseUrl?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
    this.rerankBaseUrl = (options.rerankBaseUrl?.trim() || "https://dashscope.aliyuncs.com/compatible-api/v1").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]> {
    request.signal?.throwIfAborted();
    const queryVector = await this.embed(request.query, request.signal);
    const response = await this.qdrantRequest(`/collections/${encodeURIComponent(this.collection)}/points/query`, {
      query: queryVector,
      // Fixed candidate window keeps retrieval quality predictable. The
      // reranker, not Qdrant, decides the final six evidence chunks.
      limit: 30,
      with_payload: true,
      filter: {
        must: [
          { key: "creator_id", match: { value: request.creatorId } },
          { key: "agent_id", match: { value: request.agentId } },
          { key: "corpus_digest", match: { value: request.corpusDigest } }
        ]
      }
    }, request.signal);
    const result = response.result;
    const points = result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>).points
      : result;
    const candidates = Array.isArray(points)
      ? points.flatMap((item): Array<{ id: string; text: string; document_id?: string; source_path?: string; heading?: string; source?: string; rawScore: number }> => {
        if (!item || typeof item !== "object") return [];
        const point = item as Record<string, unknown>;
        const payload = point.payload && typeof point.payload === "object" && !Array.isArray(point.payload)
          ? point.payload as Record<string, unknown>
          : {};
        if (typeof point.id !== "string" || typeof payload.text !== "string") return [];
        return [{
          id: point.id,
          text: payload.text,
          rawScore: typeof point.score === "number" ? point.score : 0,
          ...(typeof payload.document_id === "string" ? { document_id: payload.document_id } : {}),
          ...(typeof payload.source_path === "string" ? { source_path: payload.source_path } : {}),
          ...(typeof payload.heading === "string" ? { heading: payload.heading } : {}),
          source: [payload.source_path, payload.heading].filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ") || undefined
        }];
      })
      : [];
    if (candidates.length === 0) return [];
    const finalLimit = Math.max(1, Math.min(request.limit, 6));
    const reranked = await this.rerank(request.query, candidates.map((item) => item.text), finalLimit, request.signal);
    return reranked
      .map((item) => {
        const candidate = candidates[item.index];
        return candidate ? {
          id: candidate.id,
          text: candidate.text,
          score: item.score,
          ...(candidate.document_id ? { document_id: candidate.document_id } : {}),
          ...(candidate.source_path ? { source_path: candidate.source_path } : {}),
          ...(candidate.heading ? { heading: candidate.heading } : {}),
          ...(candidate.source ? { source: candidate.source } : {})
        } : undefined;
      })
      .filter((item): item is KnowledgeHit => Boolean(item))
      .slice(0, finalLimit);
  }

  private async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const response = await this.dashscopeRequest("/embeddings", {
      model: "text-embedding-v4",
      input: [text],
      dimensions: 1024
    }, this.embeddingBaseUrl, signal);
    const rows = response.data;
    const embedding = Array.isArray(rows) && rows[0] && typeof rows[0] === "object"
      ? (rows[0] as Record<string, unknown>).embedding
      : undefined;
    if (!Array.isArray(embedding) || embedding.length !== 1024 || !embedding.every((item) => typeof item === "number")) {
      throw new Error("DashScope embedding response is invalid");
    }
    return embedding;
  }

  private async rerank(
    query: string,
    documents: string[],
    limit: number,
    signal?: AbortSignal
  ): Promise<Array<{ index: number; score: number }>> {
    const response = await this.dashscopeRequest("/reranks", {
      model: "qwen3-rerank",
      query,
      documents,
      top_n: Math.min(limit, documents.length)
    }, this.rerankBaseUrl, signal);
    const results = response.results ?? (response.output && typeof response.output === "object" ? (response.output as Record<string, unknown>).results : undefined);
    if (!Array.isArray(results)) throw new Error("DashScope rerank response is invalid");
    return results.flatMap((item): Array<{ index: number; score: number }> => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const index = typeof row.index === "number" ? row.index : -1;
      const score = typeof row.relevance_score === "number" ? row.relevance_score : typeof row.score === "number" ? row.score : 0;
      return index >= 0 && index < documents.length ? [{ index, score }] : [];
    });
  }

  private async qdrantRequest(
    pathname: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.httpJson(
      `${this.qdrantUrl.replace(/\/$/, "")}${pathname}`,
      body,
      this.qdrantApiKey ? { "api-key": this.qdrantApiKey } : {},
      signal
    );
  }

  private async dashscopeRequest(
    pathname: string,
    body: Record<string, unknown>,
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.httpJson(
      `${baseUrl.replace(/\/$/, "")}${pathname}`,
      body,
      { authorization: `Bearer ${this.dashscopeApiKey}` },
      signal
    );
  }

  private async httpJson(
    url: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...extraHeaders },
      body: JSON.stringify(body),
      signal: boundedKnowledgeSignal(signal, this.timeoutMs)
    });
    let payload: unknown = {};
    try {
      payload = await readBoundedJsonObject(response);
    } catch (error) {
      if (response.ok) throw error;
    }
    if (!response.ok) throw new Error(`Knowledge provider failed with HTTP ${response.status}`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Knowledge provider returned an invalid response");
    return payload as Record<string, unknown>;
  }
}

function boundedKnowledgeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function knowledgeProviderConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    (environment.HATCH_QDRANT_URL?.trim() && environment.DASHSCOPE_API_KEY?.trim())
    || environment.HATCH_KNOWLEDGE_MODE === "corpus-test"
  );
}

export function createKnowledgeProvider(
  root: string,
  corpus: AgentCorpus,
  corpusDigest: string,
  environment: NodeJS.ProcessEnv = process.env
): KnowledgeProvider {
  const qdrantUrl = environment.HATCH_QDRANT_URL?.trim();
  const dashscopeApiKey = environment.DASHSCOPE_API_KEY?.trim();
  if (qdrantUrl && dashscopeApiKey) {
    return new QdrantKnowledgeProvider(
      qdrantUrl,
      environment.HATCH_QDRANT_API_KEY?.trim() || undefined,
      dashscopeApiKey,
      {
        collection: environment.HATCH_QDRANT_COLLECTION,
        embeddingBaseUrl: environment.DASHSCOPE_EMBEDDING_BASE_URL,
        rerankBaseUrl: environment.DASHSCOPE_RERANK_BASE_URL
      }
    );
  }
  // The corpus-backed adapter exists only for explicit local contract tests,
  // never as an implicit production substitute.
  if (environment.HATCH_KNOWLEDGE_MODE === "corpus-test") {
    return new CorpusKnowledgeProvider(root, corpus, corpusDigest);
  }
  return new UnconfiguredKnowledgeProvider();
}

/**
 * Development adapter used while the remote KB is intentionally skipped.
 * It reads only the published Agent's clean knowledge documents, enforces the
 * creator/agent binding, and exposes the same contract as Bailian/Milvus.
 */
export class CorpusKnowledgeProvider implements KnowledgeProvider {
  constructor(
    private readonly root: string,
    private readonly corpus: AgentCorpus,
    private readonly corpusDigest?: string
  ) {}

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]> {
    if (request.creatorId !== this.corpus.creator.id || request.agentId !== this.corpus.agent_id) {
      throw new Error("Knowledge query is outside the Agent Corpus creator scope");
    }
    if (this.corpusDigest && request.corpusDigest !== this.corpusDigest) {
      throw new Error("Knowledge query is outside the Agent Corpus publish digest");
    }
    const hits: KnowledgeHit[] = [];
    for (const document of this.corpus.knowledge.documents) {
      const absolute = await containedPath(this.root, document.path);
      const raw = await readFile(absolute, "utf8");
      for (const [index, text] of splitKnowledgeText(raw).entries()) {
        const score = lexicalScore(request.query, text);
        if (score > 0) {
          hits.push({
            id: `${document.id}#${index + 1}`,
            text,
            score,
            document_id: document.id,
            source_path: document.path,
            source: typeof document.source_summary === "string" ? document.source_summary : document.id
          });
        }
      }
    }
    return hits
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Math.min(request.limit, 20)));
  }
}

export async function loadAgentCorpus(root: string, signal?: AbortSignal): Promise<AgentCorpus> {
  const manifestPath = await containedPath(root, "agent.json");
  const manifest = await readFile(manifestPath, signal ? { signal } : undefined);
  if (manifest.byteLength > AGENT_CORPUS_MANIFEST_MAX_BYTES) {
    throw new Error("Agent Corpus manifest is too large");
  }
  const corpus = AgentCorpusSchema.parse(stripRemovedProductMetadata(JSON.parse(manifest.toString("utf8"))));
  const forbidden = new Set(["provider", "api_key", "credential", "credentials", "endpoint", "vector_store_id", "raw_material", "factory_trace"]);
  const leaked = findForbiddenKeys(corpus, forbidden);
  if (leaked.length) throw new Error(`Agent Corpus contains runtime or Factory fields: ${leaked.join(", ")}`);
  if (corpus.instructions.system.path !== "instructions/system.md") {
    throw new Error("Agent Corpus system instructions must live at instructions/system.md");
  }
  if (!corpus.tools.some((tool) => tool.id === "hatch.web_search")) {
    throw new Error("Agent Corpus must declare hatch.web_search");
  }
  if (corpus.knowledge.documents.length > 0 && !corpus.tools.some((tool) => tool.id === "hatch.file_search")) {
    throw new Error("Agent Corpus with knowledge documents must declare hatch.file_search");
  }
  if (corpus.knowledge.documents.some((document) => document.retrieval_only !== true)) {
    throw new Error("Agent Corpus knowledge documents must be retrieval-only");
  }
  const assets = [
    corpus.instructions.system,
    ...corpus.skills.flatMap((skill) => [skill.instruction, ...skill.references.map((reference) => reference.asset)]),
    ...corpus.knowledge.documents,
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

function stripRemovedProductMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const manifest = structuredClone(value) as Record<string, unknown>;
  if (!manifest.product || typeof manifest.product !== "object" || Array.isArray(manifest.product)) return manifest;
  // Immutable releases published before the free-Product cutover retain their
  // original bytes and digest. Discard the removed storefront pricing field at
  // the read boundary without exposing it to Runtime or accepting any other
  // unknown Product metadata.
  delete (manifest.product as Record<string, unknown>).offer;
  return manifest;
}

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
  const manifestPath = await containedPath(root, "agent.json");
  const manifestDigest = await fileSha256(manifestPath, signal);
  const assets = [
    corpus.instructions.system,
    ...corpus.skills.flatMap((skill) => [skill.instruction, ...skill.references.map((reference) => reference.asset)]),
    ...corpus.knowledge.documents,
    ...corpus.evaluations.synthetic_qa,
    ...corpus.evaluations.held_out
  ];
  const rows: Array<[string, string]> = [
    ["agent.json", manifestDigest],
    ...assets.map((asset): [string, string] => [asset.path.replaceAll(path.sep, "/"), asset.sha256])
  ];
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

function splitKnowledgeText(raw: string): string[] {
  return raw.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
}

function lexicalScore(query: string, text: string): number {
  const terms = new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
  const haystack = text.toLocaleLowerCase();
  return [...terms].reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
