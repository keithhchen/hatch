import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const AssetSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  sha256: DigestSchema,
  description: z.string().min(1).optional()
}).strict();

const ToolSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  capability: z.string().min(1).optional(),
  connection_ref: z.string().min(1).optional(),
  operation: z.string().min(1).optional(),
  tool_name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  input_schema: z.record(z.string(), z.unknown()).optional()
}).strict();

export const AgentCorpusSchema = z.object({
  contract_version: z.literal("1"),
  agent_id: z.string().min(1),
  creator: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
  product: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    promise: z.string().min(1).optional(),
    boundaries: z.array(z.string().min(1)).default([]),
    offer: z.object({
      model: z.enum(["per_delivery", "subscription"]).optional(),
      amount_minor: z.number().int().nonnegative(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      unit: z.string().min(1).optional()
    }).strict().optional(),
    presentation: z.record(z.string(), z.unknown()).default({})
  }).strict(),
  instructions: z.object({ system: AssetSchema }).strict(),
  skills: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    when_to_use: z.string().min(1),
    instruction: AssetSchema,
    references: z.array(z.object({ asset: AssetSchema, kind: z.string().min(1) }).strict()).default([]),
    allowed_tool_ids: z.array(z.string().min(1)).default([])
  }).strict()).default([]),
  knowledge: z.object({
    documents: z.array(AssetSchema.extend({
      retrieval_only: z.literal(true),
      source_summary: z.string().min(1)
    }).strict()).default([])
  }).strict().default({ documents: [] }),
  tools: z.array(ToolSchema).min(1),
  evaluations: z.object({
    synthetic_qa: z.array(AssetSchema).min(1),
    held_out: z.array(AssetSchema).min(1)
  }).strict()
}).strict();

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
};

/**
 * Resolves the one current Corpus installed by Registry. The Runtime only
 * needs a creator/agent lookup; it does not know how the Corpus was produced
 * or how its retrieval index was populated.
 */
export class AgentCorpusResolver {
  constructor(private readonly root: string) {}

  async resolve(creatorId: string, agentId: string): Promise<ResolvedAgentCorpus> {
    const corpusRoot = await containedPath(this.root, path.join(creatorId, agentId));
    const corpus = await loadAgentCorpus(corpusRoot);
    if (corpus.creator.id !== creatorId || corpus.agent_id !== agentId) {
      throw new Error("Agent Corpus binding does not match the requested creator and agent");
    }
    return { root: corpusRoot, corpus, digest: await agentCorpusDigest(corpusRoot, corpus) };
  }

  async list(creatorId: string): Promise<ResolvedAgentCorpus[]> {
    const creatorRoot = await containedPath(this.root, creatorId);
    const entries = await (async () => {
      try {
        return await (await import("node:fs/promises")).readdir(creatorRoot, { withFileTypes: true });
      } catch {
        return [];
      }
    })();
    const agents: ResolvedAgentCorpus[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        agents.push(await this.resolve(creatorId, entry.name));
      } catch {
        // A single incomplete staging directory must not hide other agents.
      }
    }
    return agents;
  }
}

export type KnowledgeSearchRequest = {
  creatorId: string;
  agentId: string;
  query: string;
  limit: number;
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
    private readonly headers: Record<string, string> = {}
  ) {}

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...this.headers },
      body: JSON.stringify({
        creator_id: request.creatorId,
        agent_id: request.agentId,
        query: request.query,
        top_k: request.limit
      })
    });
    if (!response.ok) throw new Error(`Knowledge provider failed with HTTP ${response.status}`);
    const payload = await response.json() as { hits?: unknown };
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

  constructor(
    private readonly qdrantUrl: string,
    private readonly qdrantApiKey: string | undefined,
    private readonly dashscopeApiKey: string,
    options: { collection?: string; embeddingBaseUrl?: string; rerankBaseUrl?: string } = {}
  ) {
    this.collection = options.collection?.trim() || "hatch_knowledge_text_v4_1024";
    this.embeddingBaseUrl = (options.embeddingBaseUrl?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
    this.rerankBaseUrl = (options.rerankBaseUrl?.trim() || "https://dashscope.aliyuncs.com/compatible-api/v1").replace(/\/$/, "");
  }

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]> {
    const queryVector = await this.embed(request.query);
    const response = await this.qdrantRequest(`/collections/${encodeURIComponent(this.collection)}/points/query`, {
      query: queryVector,
      // Fixed candidate window keeps retrieval quality predictable. The
      // reranker, not Qdrant, decides the final six evidence chunks.
      limit: 30,
      with_payload: true,
      filter: {
        must: [
          { key: "creator_id", match: { value: request.creatorId } },
          { key: "agent_id", match: { value: request.agentId } }
        ]
      }
    });
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
    const reranked = await this.rerank(request.query, candidates.map((item) => item.text), finalLimit);
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

  private async embed(text: string): Promise<number[]> {
    const response = await this.dashscopeRequest("/embeddings", {
      model: "text-embedding-v4",
      input: [text],
      dimensions: 1024
    }, this.embeddingBaseUrl);
    const rows = response.data;
    const embedding = Array.isArray(rows) && rows[0] && typeof rows[0] === "object"
      ? (rows[0] as Record<string, unknown>).embedding
      : undefined;
    if (!Array.isArray(embedding) || embedding.length !== 1024 || !embedding.every((item) => typeof item === "number")) {
      throw new Error("DashScope embedding response is invalid");
    }
    return embedding;
  }

  private async rerank(query: string, documents: string[], limit: number): Promise<Array<{ index: number; score: number }>> {
    const response = await this.dashscopeRequest("/reranks", {
      model: "qwen3-rerank",
      query,
      documents,
      top_n: Math.min(limit, documents.length)
    }, this.rerankBaseUrl);
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

  private async qdrantRequest(pathname: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.httpJson(`${this.qdrantUrl.replace(/\/$/, "")}${pathname}`, body, this.qdrantApiKey ? { "api-key": this.qdrantApiKey } : {});
  }

  private async dashscopeRequest(pathname: string, body: Record<string, unknown>, baseUrl: string): Promise<Record<string, unknown>> {
    return this.httpJson(`${baseUrl.replace(/\/$/, "")}${pathname}`, body, { authorization: `Bearer ${this.dashscopeApiKey}` });
  }

  private async httpJson(url: string, body: Record<string, unknown>, extraHeaders: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...extraHeaders },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) throw new Error(`Knowledge provider failed with HTTP ${response.status}`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Knowledge provider returned an invalid response");
    return payload as Record<string, unknown>;
  }
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
    return new CorpusKnowledgeProvider(root, corpus);
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
    private readonly corpus: AgentCorpus
  ) {}

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]> {
    if (request.creatorId !== this.corpus.creator.id || request.agentId !== this.corpus.agent_id) {
      throw new Error("Knowledge query is outside the Agent Corpus creator scope");
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

export async function loadAgentCorpus(root: string): Promise<AgentCorpus> {
  const manifestPath = await containedPath(root, "agent.json");
  const corpus = AgentCorpusSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
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
  for (const asset of assets) {
    const absolute = await containedPath(root, asset.path);
    const digest = `sha256:${createHash("sha256").update(await readFile(absolute)).digest("hex")}`;
    if (digest !== asset.sha256) throw new Error(`Agent Corpus asset digest mismatch: ${asset.path}`);
  }
  return corpus;
}

/** Computes the same installed-Corpus digest that Registry records at publish time. */
export async function agentCorpusDigest(root: string, corpus: AgentCorpus): Promise<string> {
  const manifestPath = await containedPath(root, "agent.json");
  const manifestDigest = `sha256:${createHash("sha256").update(await readFile(manifestPath)).digest("hex")}`;
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

export async function readCorpusAsset(root: string, asset: { path: string; sha256: string }): Promise<string> {
  const absolute = await containedPath(root, asset.path);
  const content = await readFile(absolute, "utf8");
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
