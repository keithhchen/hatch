import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import {
  extractAgentCorpusBundle,
  installCurrentCorpus,
  verifyAgentCorpus,
  type VerifiedAgentCorpus,
  AgentCorpusVerificationError,
} from "./registryCorpus.js";
import { ingestAgentCorpusKnowledge, QdrantKnowledgeIndexer } from "./qdrantIndexer.js";

export type PublishedAgentCorpus = {
  creator_id: string;
  agent_id: string;
  corpus_digest: string;
  creator_name: string;
  product_id: string;
  product_name: string;
  product_description?: string;
  knowledge_namespace: string;
  status: "published";
  published_at: string;
};

export type AgentAccessGrant = {
  entitlement_id: string;
  user_id: string;
  creator_id: string;
  agent_id: string;
  product_id: string;
  status: "active";
  granted_at: string;
};

type RegistryState = {
  schema_version: 1;
  agent_corpora: PublishedAgentCorpus[];
  agent_access: AgentAccessGrant[];
};

export class RegistryStoreTs {
  private readonly corpora = new Map<string, PublishedAgentCorpus>();
  private readonly access = new Map<string, AgentAccessGrant>();
  private readonly pool?: Pool;
  private readonly statePath?: string;
  private indexer?: QdrantKnowledgeIndexer;

  private constructor(private readonly corpusRoot: string, options: { databaseUrl?: string; statePath?: string; indexer?: QdrantKnowledgeIndexer }) {
    this.statePath = options.statePath;
    this.indexer = options.indexer;
    if (options.databaseUrl) this.pool = new Pool({ connectionString: options.databaseUrl, max: 10 });
  }

  static async open(options: {
    corpusRoot?: string;
    databaseUrl?: string;
    statePath?: string;
    indexer?: QdrantKnowledgeIndexer;
    environment?: NodeJS.ProcessEnv;
  } = {}): Promise<RegistryStoreTs> {
    const environment = options.environment ?? process.env;
    const store = new RegistryStoreTs(
      path.resolve(options.corpusRoot ?? environment.HATCH_AGENT_CORPUS_ROOT ?? "agent-corpora"),
      {
        databaseUrl: options.databaseUrl ?? (environment.HATCH_REGISTRY_DATABASE_URL?.trim() || undefined),
        statePath: options.statePath ?? (environment.HATCH_REGISTRY_STATE_PATH?.trim() || undefined),
        indexer: options.indexer ?? QdrantKnowledgeIndexer.fromEnvironment(environment),
      },
    );
    // Postgres-backed stores must create their tables before loading them.
    // The in-memory/state-file path intentionally has no schema step.
    if (store.pool) await store.ensureSchema();
    await store.load();
    return store;
  }

  async publishAgentCorpusBundle(creatorId: string, agentId: string, bundle: Uint8Array): Promise<PublishedAgentCorpus> {
    const staging = path.join(path.dirname(this.corpusRoot), `.agent-corpus-upload-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    try {
      await extractAgentCorpusBundle(bundle, staging);
      const verified = await verifyAgentCorpus(staging, creatorId, agentId);
      const knowledgeDocuments = verified.corpus.knowledge.documents;
      if (knowledgeDocuments.length > 0 && !this.indexer) {
        throw new Error("Agent Corpus includes knowledge documents but Qdrant knowledge index is not configured");
      }
      const destination = await installCurrentCorpus(verified, this.corpusRoot);
      if (this.indexer) await ingestAgentCorpusKnowledge(this.indexer, { corpus: verified.corpus, path: destination });
      const published: PublishedAgentCorpus = {
        creator_id: verified.creator.id,
        agent_id: verified.agentId,
        corpus_digest: verified.digest,
        creator_name: verified.creator.name,
        product_id: verified.product.id,
        product_name: verified.product.name,
        ...(verified.product.description ? { product_description: verified.product.description } : {}),
        knowledge_namespace: `${verified.creator.id}:${verified.agentId}`,
        status: "published",
        published_at: new Date().toISOString(),
      };
      await this.persistCorpus(published);
      return published;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async listAgentCorpora(creatorId: string): Promise<PublishedAgentCorpus[]> {
    return [...this.corpora.values()].filter((item) => item.creator_id === creatorId).sort(byPublishedAt);
  }

  getAgentCorpus(creatorId: string, agentId: string): PublishedAgentCorpus | undefined {
    return this.corpora.get(key(creatorId, agentId));
  }

  async listAllAgentCorpora(): Promise<PublishedAgentCorpus[]> {
    return [...this.corpora.values()].sort(byPublishedAt);
  }

  databasePool(): Pool | undefined { return this.pool; }

  async close(): Promise<void> { await this.pool?.end(); }

  async grantAgentAccess(userId: string, creatorId: string, agentId: string): Promise<AgentAccessGrant> {
    const corpus = this.getAgentCorpus(creatorId, agentId);
    if (!corpus) throw new Error("agent_not_found");
    const existing = [...this.access.values()].find((item) => item.user_id === userId && item.creator_id === creatorId && item.agent_id === agentId);
    if (existing) return existing;
    const grant: AgentAccessGrant = {
      entitlement_id: `ent_${randomUUID().replaceAll("-", "")}`,
      user_id: userId,
      creator_id: creatorId,
      agent_id: agentId,
      product_id: corpus.product_id,
      status: "active",
      granted_at: new Date().toISOString(),
    };
    this.access.set(grant.entitlement_id, grant);
    await this.persistAccess(grant);
    return grant;
  }

  listAgentAccess(userId: string): AgentAccessGrant[] {
    return [...this.access.values()].filter((item) => item.user_id === userId && item.status === "active");
  }

  private async ensureSchema(): Promise<void> {
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS agent_corpora (
        creator_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        corpus_digest TEXT NOT NULL,
        creator_name TEXT NOT NULL,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        product_description TEXT,
        knowledge_namespace TEXT NOT NULL,
        status TEXT NOT NULL,
        published_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (creator_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS agent_access (
        entitlement_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        status TEXT NOT NULL,
        granted_at TIMESTAMPTZ NOT NULL,
        UNIQUE (user_id, creator_id, agent_id)
      );
    `);
  }

  private async load(): Promise<void> {
    if (this.pool) {
      try {
        const corpora = await this.pool.query("SELECT creator_id, agent_id, corpus_digest, creator_name, product_id, product_name, product_description, knowledge_namespace, status, published_at FROM agent_corpora");
        for (const row of corpora.rows) this.corpora.set(key(row.creator_id, row.agent_id), rowToCorpus(row));
        const access = await this.pool.query("SELECT entitlement_id, user_id, creator_id, agent_id, product_id, status, granted_at FROM agent_access");
        for (const row of access.rows) this.access.set(row.entitlement_id, rowToAccess(row));
        return;
      } catch (error) {
        throw new Error(`Registry Postgres load failed: ${String(error)}`);
      }
    }
    if (!this.statePath) return;
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as RegistryState;
      for (const corpus of state.agent_corpora ?? []) this.corpora.set(key(corpus.creator_id, corpus.agent_id), corpus);
      for (const grant of state.agent_access ?? []) this.access.set(grant.entitlement_id, grant);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persistCorpus(corpus: PublishedAgentCorpus): Promise<void> {
    this.corpora.set(key(corpus.creator_id, corpus.agent_id), corpus);
    if (this.pool) {
      await this.pool.query(`INSERT INTO agent_corpora (creator_id, agent_id, corpus_digest, creator_name, product_id, product_name, product_description, knowledge_namespace, status, published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (creator_id, agent_id) DO UPDATE SET corpus_digest=EXCLUDED.corpus_digest, creator_name=EXCLUDED.creator_name, product_id=EXCLUDED.product_id, product_name=EXCLUDED.product_name, product_description=EXCLUDED.product_description, knowledge_namespace=EXCLUDED.knowledge_namespace, status=EXCLUDED.status, published_at=EXCLUDED.published_at`,
        [corpus.creator_id, corpus.agent_id, corpus.corpus_digest, corpus.creator_name, corpus.product_id, corpus.product_name, corpus.product_description ?? null, corpus.knowledge_namespace, corpus.status, corpus.published_at]);
      return;
    }
    await this.persistState();
  }

  private async persistAccess(grant: AgentAccessGrant): Promise<void> {
    if (this.pool) {
      await this.pool.query(`INSERT INTO agent_access (entitlement_id, user_id, creator_id, agent_id, product_id, status, granted_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id, creator_id, agent_id) DO NOTHING`, [grant.entitlement_id, grant.user_id, grant.creator_id, grant.agent_id, grant.product_id, grant.status, grant.granted_at]);
      return;
    }
    await this.persistState();
  }

  private async persistState(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ schema_version: 1, agent_corpora: [...this.corpora.values()], agent_access: [...this.access.values()] }, null, 2) + "\n", "utf8");
    await rename(temporary, this.statePath);
  }
}

function key(creatorId: string, agentId: string): string { return `${creatorId}:${agentId}`; }
function byPublishedAt(a: PublishedAgentCorpus, b: PublishedAgentCorpus): number { return Date.parse(b.published_at) - Date.parse(a.published_at); }
function rowToCorpus(row: Record<string, any>): PublishedAgentCorpus {
  return {
    creator_id: String(row.creator_id),
    agent_id: String(row.agent_id),
    corpus_digest: String(row.corpus_digest),
    creator_name: String(row.creator_name),
    product_id: String(row.product_id),
    product_name: String(row.product_name),
    ...(row.product_description ? { product_description: String(row.product_description) } : {}),
    knowledge_namespace: String(row.knowledge_namespace),
    status: "published",
    published_at: new Date(row.published_at).toISOString(),
  };
}
function rowToAccess(row: Record<string, any>): AgentAccessGrant {
  return {
    entitlement_id: String(row.entitlement_id),
    user_id: String(row.user_id),
    creator_id: String(row.creator_id),
    agent_id: String(row.agent_id),
    product_id: String(row.product_id),
    status: "active",
    granted_at: new Date(row.granted_at).toISOString(),
  };
}

export { AgentCorpusVerificationError };
