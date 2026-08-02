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
import { AgentCorpusSchema, type CreatorCorpusTool } from "./agentCorpus.js";

export class ControlPlaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

/** HTTP/MCP connection binding, never credentials. Only a secret *reference* is stored. */
export type ToolConnection = {
  id: string;
  creator_id: string;
  kind: "http" | "mcp";
  secret_ref: string | null;
  config: Record<string, unknown>;
  status: "active" | "disabled";
};

export type AgentToolBinding = {
  creator_id: string;
  agent_id: string;
  tool_id: string;
  connection_id: string;
};

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
  tool_connections: ToolConnection[];
  agent_tool_bindings: AgentToolBinding[];
};

export class RegistryStoreTs {
  private readonly corpora = new Map<string, PublishedAgentCorpus>();
  private readonly access = new Map<string, AgentAccessGrant>();
  private readonly connections = new Map<string, ToolConnection>();
  private readonly bindings = new Map<string, AgentToolBinding>();
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
    await store.load();
    if (store.pool) await store.ensureSchema();
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

  async upsertConnection(input: {
    creatorId: string;
    connectionId: string;
    kind: "http" | "mcp";
    secretRef: string | null;
    config: Record<string, unknown>;
    status: "active" | "disabled";
  }): Promise<ToolConnection> {
    requireIdentifier(input.creatorId, "creator_id");
    requireIdentifier(input.connectionId, "connection_id");
    if (input.kind !== "http" && input.kind !== "mcp") throw new ControlPlaneError("connection kind must be http or mcp");
    validateConnectionConfig(input.config);
    if (input.secretRef !== null && !input.secretRef.trim()) throw new ControlPlaneError("secret_ref cannot be blank");
    const connection: ToolConnection = {
      id: input.connectionId,
      creator_id: input.creatorId,
      kind: input.kind,
      secret_ref: input.secretRef,
      config: input.config,
      status: input.status,
    };
    this.connections.set(connection.id, connection);
    await this.persistConnection(connection);
    return connection;
  }

  getConnection(creatorId: string, connectionId: string): ToolConnection {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.creator_id !== creatorId) {
      throw new ControlPlaneError(`tool connection does not exist for this creator: ${connectionId}`);
    }
    return connection;
  }

  async bindAgentTool(input: { creatorId: string; agentId: string; toolId: string; connectionId: string }): Promise<void> {
    requireIdentifier(input.creatorId, "creator_id");
    requireIdentifier(input.agentId, "agent_id");
    requireIdentifier(input.toolId, "tool_id");
    requireIdentifier(input.connectionId, "connection_id");
    const connection = this.connections.get(input.connectionId);
    if (!connection) throw new ControlPlaneError(`tool connection does not exist: ${input.connectionId}`);
    if (connection.creator_id !== input.creatorId) throw new ControlPlaneError("a tool connection cannot cross creator boundaries");
    if (!this.getAgentCorpus(input.creatorId, input.agentId)) {
      throw new ControlPlaneError(`Agent Corpus is not published: ${input.creatorId}/${input.agentId}`);
    }
    const declared = await this.declaredCorpusTool(input.creatorId, input.agentId, input.toolId);
    if (!declared) throw new ControlPlaneError(`Agent Corpus does not declare tool_id=${input.toolId}`);
    const expectedKind = declared.kind === "http_function" ? "http" : "mcp";
    if (connection.kind !== expectedKind) {
      throw new ControlPlaneError(`Agent Corpus tool ${input.toolId} does not match Control Plane kind=${connection.kind}`);
    }
    if (declared.connection_ref !== input.connectionId) {
      throw new ControlPlaneError(`Agent Corpus tool ${input.toolId} does not match connection_ref=${input.connectionId}`);
    }
    const binding: AgentToolBinding = {
      creator_id: input.creatorId,
      agent_id: input.agentId,
      tool_id: input.toolId,
      connection_id: input.connectionId,
    };
    this.bindings.set(bindingKey(binding), binding);
    await this.persistBinding(binding);
  }

  async resolveAgentToolConnection(creatorId: string, agentId: string, toolId: string): Promise<ToolConnection> {
    const binding = this.bindings.get(bindingKey({ creator_id: creatorId, agent_id: agentId, tool_id: toolId }));
    if (!binding) throw new ControlPlaneError(`no Control Plane binding for ${creatorId}/${agentId}/${toolId}`);
    const connection = this.connections.get(binding.connection_id);
    if (!connection) throw new ControlPlaneError(`tool connection does not exist: ${binding.connection_id}`);
    if (connection.status !== "active") throw new ControlPlaneError(`tool connection is not active: ${connection.id}`);
    return connection;
  }

  private async declaredCorpusTool(creatorId: string, agentId: string, toolId: string): Promise<{ kind: "http_function" | "mcp_tool"; connection_ref: string } | undefined> {
    try {
      const raw = JSON.parse(await readFile(path.join(this.corpusRoot, creatorId, agentId, "agent.json"), "utf8")) as unknown;
      const corpus = AgentCorpusSchema.parse(raw);
      const tool = corpus.tools.find((candidate) => candidate.id === toolId && (candidate.kind === "http_function" || candidate.kind === "mcp_tool")) as CreatorCorpusTool | undefined;
      if (!tool) return undefined;
      return { kind: tool.kind, connection_ref: tool.connection_ref };
    } catch {
      throw new ControlPlaneError(`Agent Corpus manifest is unreadable: ${creatorId}/${agentId}`);
    }
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
        creator_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('http', 'mcp')),
        secret_ref TEXT,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled'))
      );
      CREATE TABLE IF NOT EXISTS agent_tool_bindings (
        creator_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        connection_id TEXT NOT NULL REFERENCES tool_connections(id),
        PRIMARY KEY (creator_id, agent_id, tool_id)
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
        const connections = await this.pool.query("SELECT id, creator_id, kind, secret_ref, config_json, status FROM tool_connections");
        for (const row of connections.rows) this.connections.set(String(row.id), rowToConnection(row));
        const bindings = await this.pool.query("SELECT creator_id, agent_id, tool_id, connection_id FROM agent_tool_bindings");
        for (const row of bindings.rows) {
          const binding = rowToBinding(row as Record<string, unknown>);
          this.bindings.set(bindingKey(binding), binding);
        }
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
      for (const connection of state.tool_connections ?? []) this.connections.set(connection.id, connection);
      for (const binding of state.agent_tool_bindings ?? []) this.bindings.set(bindingKey(binding), binding);
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

  private async persistConnection(connection: ToolConnection): Promise<void> {
    if (this.pool) {
      await this.pool.query(`INSERT INTO tool_connections (id, creator_id, kind, secret_ref, config_json, status) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO UPDATE SET creator_id=EXCLUDED.creator_id, kind=EXCLUDED.kind, secret_ref=EXCLUDED.secret_ref, config_json=EXCLUDED.config_json, status=EXCLUDED.status`,
        [connection.id, connection.creator_id, connection.kind, connection.secret_ref, JSON.stringify(connection.config), connection.status]);
      return;
    }
    await this.persistState();
  }

  private async persistBinding(binding: AgentToolBinding): Promise<void> {
    if (this.pool) {
      await this.pool.query(`INSERT INTO agent_tool_bindings (creator_id, agent_id, tool_id, connection_id) VALUES ($1,$2,$3,$4)
        ON CONFLICT (creator_id, agent_id, tool_id) DO UPDATE SET connection_id=EXCLUDED.connection_id`,
        [binding.creator_id, binding.agent_id, binding.tool_id, binding.connection_id]);
      return;
    }
    await this.persistState();
  }

  private async persistState(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({
      schema_version: 1,
      agent_corpora: [...this.corpora.values()],
      agent_access: [...this.access.values()],
      tool_connections: [...this.connections.values()],
      agent_tool_bindings: [...this.bindings.values()]
    }, null, 2) + "\n", "utf8");
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

function rowToConnection(row: Record<string, any>): ToolConnection {
  return {
    id: String(row.id),
    creator_id: String(row.creator_id),
    kind: row.kind === "mcp" ? "mcp" : "http",
    secret_ref: row.secret_ref === null || row.secret_ref === undefined ? null : String(row.secret_ref),
    config: parseConfig(String(row.config_json)),
    status: row.status === "disabled" ? "disabled" : "active",
  };
}

function rowToBinding(row: Record<string, any>): AgentToolBinding {
  return {
    creator_id: String(row.creator_id),
    agent_id: String(row.agent_id),
    tool_id: String(row.tool_id),
    connection_id: String(row.connection_id),
  };
}

function parseConfig(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ControlPlaneError("stored connection config is invalid");
  return parsed as Record<string, unknown>;
}

function bindingKey(binding: Pick<AgentToolBinding, "creator_id" | "agent_id" | "tool_id">): string {
  return `${binding.creator_id}:${binding.agent_id}:${binding.tool_id}`;
}

function requireIdentifier(value: string, field: string): void {
  if (!value || /\s/.test(value)) throw new ControlPlaneError(`${field} must be a non-empty identifier`);
}

function validateConnectionConfig(config: Record<string, unknown>): void {
  if (!config || typeof config !== "object" || Array.isArray(config) || typeof config.url !== "string" || !/^https?:\/\//.test(config.url)) {
    throw new ControlPlaneError("connection config requires an http(s) url");
  }
  rejectSecretFields(config);
}

const SECRET_KEYS = new Set(["authorization", "api_key", "apikey", "token", "password", "secret", "bearer"]);

function rejectSecretFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/-/g, "_");
    if (SECRET_KEYS.has(normalized)) throw new ControlPlaneError("connection config must not contain credentials; use secret_ref");
    rejectSecretFields(item);
  }
}

export { AgentCorpusVerificationError };
