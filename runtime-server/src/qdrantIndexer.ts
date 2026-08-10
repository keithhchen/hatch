import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type AgentCorpus } from "./agentCorpus.js";
import { MAX_RUNTIME_RESPONSE_BODY_BYTES, readBoundedJsonObject } from "./boundedResponse.js";

const COLLECTION = "hatch_knowledge_text_v4_1024";
const DIMENSIONS = 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type KnowledgeDocument = {
  id: string;
  path: string;
  sha256: string;
  retrieval_only: true;
  source_summary: string;
};

type Chunk = {
  documentId: string;
  sourcePath: string;
  heading: string;
  text: string;
  chunkIndex: number;
};

export class KnowledgeIndexUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KnowledgeIndexUnavailable";
  }
}

type IndexOperationOptions = { signal?: AbortSignal };

export type AgentKnowledgeIndexer = {
  stageAgentDocuments(
    creatorId: string,
    agentId: string,
    corpusDigest: string,
    corpusRoot: string,
    documents: KnowledgeDocument[],
    options?: IndexOperationOptions,
  ): Promise<void>;
  deleteAgentDocuments(
    creatorId: string,
    agentId: string,
    corpusDigest: string,
    options?: IndexOperationOptions,
  ): Promise<void>;
};

export class QdrantKnowledgeIndexer {
  private readonly collection: string;
  private readonly embeddingBaseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly qdrantUrl: string,
    private readonly qdrantApiKey: string | undefined,
    private readonly dashscopeApiKey: string,
    options: {
      collection?: string;
      embeddingBaseUrl?: string;
      requestTimeoutMs?: number;
      maxResponseBytes?: number;
    } = {},
  ) {
    this.collection = options.collection?.trim() || COLLECTION;
    this.embeddingBaseUrl = (options.embeddingBaseUrl?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes ?? MAX_RUNTIME_RESPONSE_BODY_BYTES, "maxResponseBytes");
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): QdrantKnowledgeIndexer | undefined {
    const qdrantUrl = environment.HATCH_QDRANT_URL?.trim();
    const key = environment.DASHSCOPE_API_KEY?.trim();
    if (!qdrantUrl && !key) return undefined;
    if (!qdrantUrl || !key) throw new KnowledgeIndexUnavailable("Qdrant ingestion requires HATCH_QDRANT_URL and DASHSCOPE_API_KEY");
    return new QdrantKnowledgeIndexer(qdrantUrl, environment.HATCH_QDRANT_API_KEY?.trim() || undefined, key, {
      collection: environment.HATCH_QDRANT_COLLECTION,
      embeddingBaseUrl: environment.DASHSCOPE_EMBEDDING_BASE_URL,
      requestTimeoutMs: knowledgeIndexRequestTimeoutMs(environment),
      maxResponseBytes: knowledgeIndexMaxResponseBytes(environment),
    });
  }

  async stageAgentDocuments(
    creatorId: string,
    agentId: string,
    corpusDigest: string,
    corpusRoot: string,
    documents: KnowledgeDocument[],
    options: IndexOperationOptions = {},
  ): Promise<void> {
    requireCorpusDigest(corpusDigest);
    throwIfAborted(options.signal);
    await this.ensureCollection(options.signal);
    const chunks: Chunk[] = [];
    for (const document of documents) {
      throwIfAborted(options.signal);
      const raw = await readFile(path.join(corpusRoot, document.path), { encoding: "utf8", signal: options.signal });
      chunks.push(...splitMarkdown(raw, document));
    }
    for (let start = 0; start < chunks.length; start += 16) {
      throwIfAborted(options.signal);
      const batch = chunks.slice(start, start + 16);
      const vectors = await this.embed(batch.map((chunk) => chunk.text), options.signal);
      await this.qdrant("PUT", `/collections/${encodeURIComponent(this.collection)}/points?wait=true`, {
        points: batch.map((chunk, index) => ({
          id: stableUuid(`${creatorId}:${agentId}:${corpusDigest}:${chunk.documentId}:${chunk.chunkIndex}`),
          vector: vectors[index],
          payload: {
            creator_id: creatorId,
            agent_id: agentId,
            corpus_digest: corpusDigest,
            document_id: chunk.documentId,
            source_path: chunk.sourcePath,
            heading: chunk.heading,
            text: chunk.text,
            chunk_index: chunk.chunkIndex,
          },
        }))
      }, options.signal);
    }
  }

  async deleteAgentDocuments(
    creatorId: string,
    agentId: string,
    corpusDigest: string,
    options: IndexOperationOptions = {},
  ): Promise<void> {
    requireCorpusDigest(corpusDigest);
    await this.qdrant("POST", `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`, {
      filter: { must: [
        { key: "creator_id", match: { value: creatorId } },
        { key: "agent_id", match: { value: agentId } },
        { key: "corpus_digest", match: { value: corpusDigest } },
      ] }
    }, options.signal);
  }

  private async ensureCollection(signal?: AbortSignal): Promise<void> {
    let created = false;
    try {
      await this.qdrant("GET", `/collections/${encodeURIComponent(this.collection)}`, undefined, signal);
    } catch (error) {
      if (!(error instanceof KnowledgeIndexUnavailable) || !error.message.includes("HTTP 404")) throw error;
      await this.qdrant("PUT", `/collections/${encodeURIComponent(this.collection)}`, { vectors: { size: DIMENSIONS, distance: "Cosine" } }, signal);
      created = true;
    }
    for (const field of created ? ["creator_id", "agent_id", "corpus_digest"] : ["corpus_digest"]) {
      await this.qdrant("PUT", `/collections/${encodeURIComponent(this.collection)}/index?wait=true`, { field_name: field, field_schema: "keyword" }, signal);
    }
  }

  private async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const payload = await this.dashscope("/embeddings", { model: "text-embedding-v4", input: texts, dimensions: DIMENSIONS }, this.embeddingBaseUrl, signal);
    const rows = payload.data;
    const vectors = Array.isArray(rows) ? rows.map((row) => row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>).embedding : undefined) : [];
    if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector) || vector.length !== DIMENSIONS || vector.some((value) => typeof value !== "number"))) {
      throw new KnowledgeIndexUnavailable("DashScope embedding response is incomplete or has the wrong dimensions");
    }
    return vectors as number[][];
  }

  private async qdrant(method: string, pathname: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.httpJson(`${this.qdrantUrl.replace(/\/$/, "")}${pathname}`, method, body, this.qdrantApiKey ? { "api-key": this.qdrantApiKey } : {}, signal);
  }

  private async dashscope(pathname: string, body: Record<string, unknown>, baseUrl: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.httpJson(`${baseUrl.replace(/\/$/, "")}${pathname}`, "POST", body, { authorization: `Bearer ${this.dashscopeApiKey}` }, signal);
  }

  private async httpJson(
    url: string,
    method: string,
    body: Record<string, unknown> | undefined,
    extraHeaders: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const requestSignal = boundedSignal(signal, this.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...extraHeaders },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: requestSignal,
      });
      let payload: Record<string, unknown> = {};
      try {
        payload = await readBoundedJsonObject(response, this.maxResponseBytes);
      } catch (error) {
        if (response.ok) {
          throw new KnowledgeIndexUnavailable("Knowledge index returned an invalid or oversized response", { cause: error });
        }
      }
      if (!response.ok) throw new KnowledgeIndexUnavailable(`Knowledge index request failed with HTTP ${response.status}`);
      return payload;
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (requestSignal.aborted || isAbortError(error)) {
        throw new KnowledgeIndexUnavailable(`Knowledge index request timed out after ${this.requestTimeoutMs}ms`, { cause: error });
      }
      if (error instanceof KnowledgeIndexUnavailable) throw error;
      throw new KnowledgeIndexUnavailable("Knowledge index request failed", { cause: error });
    }
  }
}

export async function ingestAgentCorpusKnowledge(
  indexer: AgentKnowledgeIndexer,
  verified: { corpus: AgentCorpus; path: string; digest: string },
  signal?: AbortSignal,
): Promise<void> {
  const documents = verified.corpus.knowledge.documents as KnowledgeDocument[];
  await indexer.stageAgentDocuments(
    verified.corpus.creator.id,
    verified.corpus.agent_id,
    verified.digest,
    verified.path,
    documents,
    { signal },
  );
}

export async function removeAgentCorpusKnowledge(
  indexer: AgentKnowledgeIndexer,
  creatorId: string,
  agentId: string,
  corpusDigest: string,
  signal?: AbortSignal,
): Promise<void> {
  await indexer.deleteAgentDocuments(creatorId, agentId, corpusDigest, { signal });
}

function splitMarkdown(text: string, document: KnowledgeDocument, maxChars = 2400): Chunk[] {
  const chunks: Chunk[] = [];
  let heading = document.path;
  let current: string[] = [];
  const flush = () => {
    const content = current.join("\n").trim();
    if (content) chunks.push({ documentId: document.id, sourcePath: document.path, heading, text: content, chunkIndex: chunks.length });
    current = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (match) { flush(); heading = match[2]!.trim(); }
    const currentLength = current.reduce((sum, item) => sum + item.length + 1, 0);
    if (current.length > 0 && currentLength + line.length > maxChars) flush();
    current.push(line);
  }
  flush();
  return chunks;
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(`hatch:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function knowledgeIndexRequestTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  return boundedEnvironmentInteger(
    environment.HATCH_KNOWLEDGE_INDEX_REQUEST_TIMEOUT_MS,
    "HATCH_KNOWLEDGE_INDEX_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
    100,
    60_000,
  );
}

export function knowledgeIndexMaxResponseBytes(environment: NodeJS.ProcessEnv = process.env): number {
  return boundedEnvironmentInteger(
    environment.HATCH_KNOWLEDGE_INDEX_MAX_RESPONSE_BYTES,
    "HATCH_KNOWLEDGE_INDEX_MAX_RESPONSE_BYTES",
    MAX_RUNTIME_RESPONSE_BODY_BYTES,
    1_024,
    16 * 1024 * 1024,
  );
}

function boundedEnvironmentInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Knowledge index operation was aborted");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "AbortError" || error.name === "TimeoutError" || /aborted|timeout/i.test(error.message));
}

function requireCorpusDigest(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new KnowledgeIndexUnavailable("Knowledge index requires a valid corpus digest");
  }
}
