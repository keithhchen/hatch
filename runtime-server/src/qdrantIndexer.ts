import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type AgentCorpus } from "./agentCorpus.js";

const COLLECTION = "hatch_knowledge_text_v4_1024";
const DIMENSIONS = 1024;

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
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeIndexUnavailable";
  }
}

export class QdrantKnowledgeIndexer {
  private readonly collection: string;
  private readonly embeddingBaseUrl: string;

  constructor(
    private readonly qdrantUrl: string,
    private readonly qdrantApiKey: string | undefined,
    private readonly dashscopeApiKey: string,
    options: { collection?: string; embeddingBaseUrl?: string } = {},
  ) {
    this.collection = options.collection?.trim() || COLLECTION;
    this.embeddingBaseUrl = (options.embeddingBaseUrl?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): QdrantKnowledgeIndexer | undefined {
    const qdrantUrl = environment.HATCH_QDRANT_URL?.trim();
    const key = environment.DASHSCOPE_API_KEY?.trim();
    if (!qdrantUrl && !key) return undefined;
    if (!qdrantUrl || !key) throw new KnowledgeIndexUnavailable("Qdrant ingestion requires HATCH_QDRANT_URL and DASHSCOPE_API_KEY");
    return new QdrantKnowledgeIndexer(qdrantUrl, environment.HATCH_QDRANT_API_KEY?.trim() || undefined, key, {
      collection: environment.HATCH_QDRANT_COLLECTION,
      embeddingBaseUrl: environment.DASHSCOPE_EMBEDDING_BASE_URL,
    });
  }

  async replaceAgentDocuments(
    creatorId: string,
    agentId: string,
    corpusRoot: string,
    documents: KnowledgeDocument[],
  ): Promise<void> {
    await this.ensureCollection();
    await this.qdrant("POST", `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`, {
      filter: { must: [
        { key: "creator_id", match: { value: creatorId } },
        { key: "agent_id", match: { value: agentId } },
      ] }
    });
    const chunks: Chunk[] = [];
    for (const document of documents) {
      const raw = await readFile(`${corpusRoot}/${document.path}`, "utf8");
      chunks.push(...splitMarkdown(raw, document));
    }
    for (let start = 0; start < chunks.length; start += 16) {
      const batch = chunks.slice(start, start + 16);
      const vectors = await this.embed(batch.map((chunk) => chunk.text));
      await this.qdrant("PUT", `/collections/${encodeURIComponent(this.collection)}/points?wait=true`, {
        points: batch.map((chunk, index) => ({
          id: stableUuid(`${creatorId}:${agentId}:${chunk.documentId}:${chunk.chunkIndex}`),
          vector: vectors[index],
          payload: {
            creator_id: creatorId,
            agent_id: agentId,
            document_id: chunk.documentId,
            source_path: chunk.sourcePath,
            heading: chunk.heading,
            text: chunk.text,
            chunk_index: chunk.chunkIndex,
          },
        }))
      });
    }
  }

  private async ensureCollection(): Promise<void> {
    try {
      await this.qdrant("GET", `/collections/${encodeURIComponent(this.collection)}`);
      return;
    } catch (error) {
      if (!(error instanceof KnowledgeIndexUnavailable) || !error.message.includes("HTTP 404")) throw error;
    }
    await this.qdrant("PUT", `/collections/${encodeURIComponent(this.collection)}`, { vectors: { size: DIMENSIONS, distance: "Cosine" } });
    for (const field of ["creator_id", "agent_id"]) {
      await this.qdrant("PUT", `/collections/${encodeURIComponent(this.collection)}/index`, { field_name: field, field_schema: "keyword" });
    }
  }

  private async embed(texts: string[]): Promise<number[][]> {
    const payload = await this.dashscope("/embeddings", { model: "text-embedding-v4", input: texts, dimensions: DIMENSIONS }, this.embeddingBaseUrl);
    const rows = payload.data;
    const vectors = Array.isArray(rows) ? rows.map((row) => row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>).embedding : undefined) : [];
    if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector) || vector.length !== DIMENSIONS || vector.some((value) => typeof value !== "number"))) {
      throw new KnowledgeIndexUnavailable("DashScope embedding response is incomplete or has the wrong dimensions");
    }
    return vectors as number[][];
  }

  private async qdrant(method: string, pathname: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.httpJson(`${this.qdrantUrl.replace(/\/$/, "")}${pathname}`, method, body, this.qdrantApiKey ? { "api-key": this.qdrantApiKey } : {});
  }

  private async dashscope(pathname: string, body: Record<string, unknown>, baseUrl: string): Promise<Record<string, unknown>> {
    return this.httpJson(`${baseUrl.replace(/\/$/, "")}${pathname}`, "POST", body, { authorization: `Bearer ${this.dashscopeApiKey}` });
  }

  private async httpJson(url: string, method: string, body: Record<string, unknown> | undefined, extraHeaders: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method,
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...extraHeaders },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) throw new KnowledgeIndexUnavailable(`Knowledge index request failed with HTTP ${response.status}`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new KnowledgeIndexUnavailable("Knowledge index returned an invalid response");
    return payload as Record<string, unknown>;
  }
}

export async function ingestAgentCorpusKnowledge(
  indexer: QdrantKnowledgeIndexer,
  verified: { corpus: AgentCorpus; path: string },
): Promise<void> {
  const documents = verified.corpus.knowledge.documents as KnowledgeDocument[];
  await indexer.replaceAgentDocuments(verified.corpus.creator.id, verified.corpus.agent_id, verified.path, documents);
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
