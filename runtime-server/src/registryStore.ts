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
import { loadAgentCorpus } from "./agentCorpus.js";
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

export type CreatorToolConnection = {
  id: string;
  tenant_id: string;
  kind: "http" | "mcp";
  secret_ref: string | null;
  config: Record<string, unknown>;
  status: "active" | "disabled";
};

type RegistryState = {
  schema_version: 1;
  agent_corpora: PublishedAgentCorpus[];
  agent_access: AgentAccessGrant[];
  tool_connections?: CreatorToolConnection[];
  agent_tool_bindings?: Array<{ tenant_id: string; agent_id: string; tool_id: string; connection_id: string }>;
};

export class RegistryStoreTs {
  private readonly corpora = new Map<string, PublishedAgentCorpus>();
  private readonly access = new Map<string, AgentAccessGrant>();
  private readonly toolConnections = new Map<string, CreatorToolConnection>();
  private readonly toolBindings = new Map<string, string>();
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

  async upsertCreatorToolConnection(input: {
    tenantId: string;
    connectionId: string;
    kind: "http" | "mcp";
    secretRef: string | null;
    config: Record<string, unknown>;
    status: "active" | "disabled";
  }): Promise<CreatorToolConnection> {
    validateIdentifier(input.tenantId, "tenantId");
    validateIdentifier(input.connectionId, "connectionId");
    validateConnectionConfig(input.config);
    const connection: CreatorToolConnection = {
      id: input.connectionId,
      tenant_id: input.tenantId,
      kind: input.kind,
      secret_ref: input.secretRef,
      config: input.config,
      status: input.status
    };
    this.toolConnections.set(connection.id, connection);
    if (this.pool) {
      await this.pool.query(`INSERT INTO tool_connections (id, tenant_id, kind, secret_ref, config_json, status)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, kind=EXCLUDED.kind, secret_ref=EXCLUDED.secret_ref, config_json=EXCLUDED.config_json, status=EXCLUDED.status`,
        [connection.id, connection.tenant_id, connection.kind, connection.secret_ref, JSON.stringify(connection.config), connection.status]);
    } else {
      await this.persistState();
    }
    return connection;
  }

  async bindCreatorTool(input: { tenantId: string; agentId: string; toolId: string; connectionId: string }): Promise<void> {
    validateIdentifier(input.tenantId, "tenantId");
    validateIdentifier(input.agentId, "agentId");
    validateToolIdentifier(input.toolId, "toolId");
    validateIdentifier(input.connectionId, "connectionId");
    const connection = this.toolConnections.get(input.connectionId) ?? await this.readToolConnection(input.connectionId);
    if (!connection) throw new Error(`tool connection does not exist: ${input.connectionId}`);
    if (connection.tenant_id !== input.tenantId) throw new Error("a tool connection cannot cross tenant boundaries");
    if (!this.getAgentCorpus(input.tenantId, input.agentId)) throw new Error(`agent corpus does not exist: ${input.tenantId}/${input.agentId}`);
    const corpus = await loadAgentCorpus(path.join(this.corpusRoot, input.tenantId, input.agentId));
    const declared = corpus.tools.find((tool) => tool.id === input.toolId);
    if (!declared || (declared.kind !== "http_function" && declared.kind !== "mcp_tool")) {
      throw new Error(`Agent Corpus tool does not exist: ${input.toolId}`);
    }
    const expectedKind = declared.kind === "http_function" ? "http" : "mcp";
    if (declared.connection_ref !== input.connectionId || connection.kind !== expectedKind) {
      throw new Error(`Agent Corpus tool ${input.toolId} does not match connection ${input.connectionId}`);
    }
    const bindingKey = toolBindingKey(input.tenantId, input.agentId, input.toolId);
    this.toolBindings.set(bindingKey, input.connectionId);
    if (this.pool) {
      await this.pool.query(`INSERT INTO agent_tool_bindings (tenant_id, agent_id, tool_id, connection_id)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (tenant_id, agent_id, tool_id) DO UPDATE SET connection_id=EXCLUDED.connection_id`,
        [input.tenantId, input.agentId, input.toolId, input.connectionId]);
    } else {
      await this.persistState();
    }
  }

  async resolveCreatorToolConnection(input: { tenantId: string; agentId: string; toolId: string }): Promise<CreatorToolConnection> {
    const bindingKey = toolBindingKey(input.tenantId, input.agentId, input.toolId);
    const connectionId = this.toolBindings.get(bindingKey);
    const connection = connectionId ? this.toolConnections.get(connectionId) : undefined;
    if (connection) {
      if (connection.status !== "active") throw new Error(`tool connection is not active: ${connection.id}`);
      return connection;
    }
    if (this.pool) {
      const result = await this.pool.query(`SELECT c.id, c.tenant_id, c.kind, c.secret_ref, c.config_json, c.status
        FROM agent_tool_bindings AS b JOIN tool_connections AS c ON c.id=b.connection_id
        WHERE b.tenant_id=$1 AND b.agent_id=$2 AND b.tool_id=$3`,
        [input.tenantId, input.agentId, input.toolId]);
      const row = result.rows[0];
      if (row) {
        if (row.status !== "active") throw new Error(`tool connection is not active: ${row.id}`);
        const resolved = rowToToolConnection(row);
        this.toolConnections.set(resolved.id, resolved);
        this.toolBindings.set(bindingKey, resolved.id);
        return resolved;
      }
    }
    throw new Error(`no Control Plane binding for ${input.tenantId}/${input.agentId}/${input.toolId}`);
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
      CREATE TABLE IF NOT EXISTS tool_connections (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        secret_ref TEXT,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_tool_bindings (
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        connection_id TEXT NOT NULL REFERENCES tool_connections(id),
        PRIMARY KEY (tenant_id, agent_id, tool_id)
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
        const connections = await this.pool.query("SELECT id, tenant_id, kind, secret_ref, config_json, status FROM tool_connections");
        for (const row of connections.rows) this.toolConnections.set(row.id, rowToToolConnection(row));
        const bindings = await this.pool.query("SELECT tenant_id, agent_id, tool_id, connection_id FROM agent_tool_bindings");
        for (const row of bindings.rows) this.toolBindings.set(toolBindingKey(row.tenant_id, row.agent_id, row.tool_id), String(row.connection_id));
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
      for (const connection of state.tool_connections ?? []) this.toolConnections.set(connection.id, connection);
      for (const binding of state.agent_tool_bindings ?? []) this.toolBindings.set(toolBindingKey(binding.tenant_id, binding.agent_id, binding.tool_id), binding.connection_id);
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
    const state = {
      schema_version: 1,
      agent_corpora: [...this.corpora.values()],
      agent_access: [...this.access.values()],
      tool_connections: [...this.toolConnections.values()],
      agent_tool_bindings: [...this.toolBindings.entries()].map(([binding, connection_id]) => {
        const [tenant_id, agent_id, ...toolParts] = binding.split("\u0000");
        return { tenant_id, agent_id, tool_id: toolParts.join("\u0000"), connection_id };
      })
    };
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
    await rename(temporary, this.statePath);
  }

  private async readToolConnection(connectionId: string): Promise<CreatorToolConnection | undefined> {
    if (!this.pool) return undefined;
    const result = await this.pool.query("SELECT id, tenant_id, kind, secret_ref, config_json, status FROM tool_connections WHERE id=$1", [connectionId]);
    const row = result.rows[0];
    if (!row) return undefined;
    const connection = rowToToolConnection(row);
    this.toolConnections.set(connection.id, connection);
    return connection;
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

function rowToToolConnection(row: Record<string, any>): CreatorToolConnection {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    kind: row.kind === "mcp" ? "mcp" : "http",
    secret_ref: row.secret_ref === null || row.secret_ref === undefined ? null : String(row.secret_ref),
    config: typeof row.config_json === "string" ? JSON.parse(row.config_json) : row.config_json,
    status: row.status === "disabled" ? "disabled" : "active"
  };
}

function toolBindingKey(tenantId: string, agentId: string, toolId: string): string {
  return [tenantId, agentId, toolId].join("\u0000");
}

function validateIdentifier(value: string, field: string): void {
  if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(value)) throw new Error(`${field} must be a valid identifier`);
}

function validateToolIdentifier(value: string, field: string): void {
  if (!/^creator\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)) throw new Error(`${field} must be a valid Creator tool identifier`);
}

function validateConnectionConfig(config: Record<string, unknown>): void {
  const url = config.url;
  if (typeof url !== "string") throw new Error("connection config requires a URL");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("connection config requires an absolute URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("connection config requires an http(s) URL");
  const forbidden = new Set(["authorization", "api_key", "apikey", "token", "password", "secret", "bearer"]);
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) scan(item); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key.toLowerCase().replaceAll("-", "_"))) throw new Error("connection config must not contain credentials");
      scan(child);
    }
  };
  scan(config);
}

export { AgentCorpusVerificationError };
