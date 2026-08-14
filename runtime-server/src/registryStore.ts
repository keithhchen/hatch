import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, writeFile, rename, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Pool, type QueryConfig } from "pg";
import {
  extractAgentCorpusBundle,
  activateCurrentCorpus,
  immutableReleasePath,
  materializeAgentCorpusRelease,
  prepareCurrentCorpusInstall,
  verifyAgentCorpus,
  AgentCorpusVerificationError,
  type CurrentCorpusInstallTransaction,
  type VerifiedAgentCorpus,
} from "./registryCorpus.js";
import { loadAgentCorpus } from "./agentCorpus.js";
import {
  ingestAgentCorpusKnowledge,
  removeAgentCorpusKnowledge,
  QdrantKnowledgeIndexer,
  type AgentKnowledgeIndexer,
} from "./qdrantIndexer.js";
import { isUuidV4, requireUuidV4 } from "./identity.js";
import { mapLegacyAuthorityId, migrateUuidAuthorityIds } from "./uuidIdentityMigration.js";

export type PublishedAgentCorpus = {
  creator_id: string;
  agent_id: string;
  corpus_digest: string;
  creator_name: string;
  product_id: string;
  product_name: string;
  product_description?: string;
  product_promise?: string;
  product_boundaries: string[];
  presentation: Record<string, unknown>;
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
  order_id?: string;
  /** Current launch contract: every free purchase is permanent access. */
  access_mode?: "unmetered" | "metered";
  purchased_corpus_digest?: string;
  version_policy?: "pinned" | "track_current_compatible";
  status: "active" | "revoked" | "disabled";
  granted_at: string;
};

export type AgentAccessPresentation = AgentAccessGrant & {
  creator: { id: string; name: string };
  product: { id: string; name: string; description: string };
  presentation: Record<string, unknown>;
};

export type AgentAccessListOptions = {
  entitlementId?: string;
  limit?: number;
  offset?: number;
};

export class RegistryDeploymentConflictError extends Error {
  readonly code = "stale_current_digest";
  constructor(
    readonly expectedCurrentDigest: string | null,
    readonly currentCorpusDigest: string | null,
    readonly targetCorpusDigest: string
  ) {
    super("The current Agent Corpus changed before activation.");
    this.name = "RegistryDeploymentConflictError";
  }
}

export const MAX_AGENT_CORPORA_PER_CREATOR = 20;
export const MAX_CORPUS_BYTES_PER_CREATOR = 256 * 1024 * 1024;
export const MAX_CORPUS_BYTES_GLOBAL = 20 * 1024 * 1024 * 1024;
export const MAX_CORPUS_FILES_PER_CREATOR = 4_096;
export const MAX_CORPUS_FILES_GLOBAL = 100_000;
const DEFAULT_REGISTRY_PUBLISH_TIMEOUT_MS = 60_000;

export type CreatorToolConnection = {
  id: string;
  tenant_id: string;
  kind: "http" | "mcp";
  secret_ref: string | null;
  secret: string | null;
  config: Record<string, unknown>;
  status: "active" | "disabled";
};

type RegistryState = {
  schema_version: 2;
  agent_corpora: PublishedAgentCorpus[];
  agent_access: AgentAccessGrant[];
  tool_connections?: CreatorToolConnection[];
  agent_tool_bindings?: Array<{ tenant_id: string; agent_id: string; tool_id: string; connection_id: string }>;
};

type CorpusInstallJournal = {
  creator_id: string;
  agent_id: string;
  new_digest: string;
  previous_digest?: string;
  current_path: string;
  prepared_path: string;
  backup_path: string;
};

export class RegistryStoreTs {
  private readonly corpora = new Map<string, PublishedAgentCorpus>();
  private readonly corpusBytes = new Map<string, number>();
  private readonly corpusFiles = new Map<string, number>();
  private readonly access = new Map<string, AgentAccessGrant>();
  private readonly accessMutations = new Map<string, Promise<AgentAccessGrant>>();
  private readonly publishMutations = new Map<string, Promise<void>>();
  private readonly toolConnections = new Map<string, CreatorToolConnection>();
  private readonly toolBindings = new Map<string, string>();
  private readonly pool?: Pool;
  private readonly statePath?: string;
  private readonly publishTimeoutMs: number;
  private indexer?: AgentKnowledgeIndexer;
  private publishOutcomeUnknown?: Error;

  private constructor(private readonly corpusRoot: string, options: {
    databaseUrl?: string;
    databaseTimeoutMs: number;
    statePath?: string;
    indexer?: AgentKnowledgeIndexer;
    pool?: Pool;
    publishTimeoutMs: number;
  }) {
    this.statePath = options.statePath;
    this.indexer = options.indexer;
    this.publishTimeoutMs = options.publishTimeoutMs;
    if (options.pool && options.databaseUrl) throw new Error("RegistryStoreTs.open cannot accept both pool and databaseUrl");
    if (options.pool) this.pool = options.pool;
    else if (options.databaseUrl) this.pool = new Pool({
      connectionString: options.databaseUrl,
      max: 10,
      connectionTimeoutMillis: options.databaseTimeoutMs,
      query_timeout: options.databaseTimeoutMs,
      statement_timeout: options.databaseTimeoutMs,
      idleTimeoutMillis: 30_000,
    });
  }

  static async open(options: {
    corpusRoot?: string;
    databaseUrl?: string;
    statePath?: string;
    indexer?: AgentKnowledgeIndexer;
    pool?: Pool;
    publishTimeoutMs?: number;
    environment?: NodeJS.ProcessEnv;
  } = {}): Promise<RegistryStoreTs> {
    const environment = options.environment ?? process.env;
    const store = new RegistryStoreTs(
      path.resolve(options.corpusRoot ?? environment.HATCH_AGENT_CORPUS_ROOT ?? "agent-corpora"),
      {
        databaseUrl: options.databaseUrl ?? (environment.HATCH_REGISTRY_DATABASE_URL?.trim() || undefined),
        databaseTimeoutMs: registryDatabaseTimeoutMs(environment),
        statePath: options.statePath ?? (environment.HATCH_REGISTRY_STATE_PATH?.trim() || undefined),
        indexer: options.indexer ?? QdrantKnowledgeIndexer.fromEnvironment(environment),
        pool: options.pool,
        publishTimeoutMs: options.publishTimeoutMs ?? registryPublishTimeoutMs(environment),
      },
    );
    // Postgres-backed stores must create their tables before loading them.
    // The in-memory/state-file path intentionally has no schema step.
    if (store.pool) await store.ensureSchema();
    await store.load();
    await store.recoverPendingCorpusInstalls();
    await store.loadCorpusByteAccounting();
    await store.resumePendingIndexCleanup();
    return store;
  }

  async publishAgentCorpusBundle(creatorId: string, agentId: string, bundle: Uint8Array): Promise<PublishedAgentCorpus> {
    if (this.publishOutcomeUnknown) throw this.publishOutcomeUnknown;
    const deadline = new PublishDeadline(this.publishTimeoutMs);
    // Quotas, the state-file snapshot, and the filesystem current pointer are
    // one Registry-wide transaction boundary, so direct callers are serialized
    // even when they bypass the HTTP publish-work gate.
    const mutationKey = "registry-publish";
    const previousMutation = this.publishMutations.get(mutationKey) ?? Promise.resolve();
    let releaseMutation!: () => void;
    const mutationTurn = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutationTail = previousMutation.then(() => mutationTurn);
    this.publishMutations.set(mutationKey, mutationTail);
    void mutationTail.then(() => {
      if (this.publishMutations.get(mutationKey) === mutationTail) this.publishMutations.delete(mutationKey);
    });
    try {
      await deadline.wait(previousMutation);
      if (this.publishOutcomeUnknown) throw this.publishOutcomeUnknown;
      deadline.throwIfExpired();
      return await this.publishAgentCorpusBundleOnce(creatorId, agentId, bundle, deadline);
    } finally {
      deadline.dispose();
      const deferred = deadline.deferredCompletion();
      if (deferred) void deferred.finally(releaseMutation);
      else releaseMutation();
    }
  }

  private async publishAgentCorpusBundleOnce(
    creatorId: string,
    agentId: string,
    bundle: Uint8Array,
    deadline: PublishDeadline,
  ): Promise<PublishedAgentCorpus> {
    const staging = path.join(path.dirname(this.corpusRoot), `.agent-corpus-upload-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    let install: CurrentCorpusInstallTransaction | undefined;
    let indexAttempted = false;
    let metadataCommitted = false;
    let verifiedDigest: string | undefined;
    let priorCorpus: PublishedAgentCorpus | undefined;
    let stagedDigestCleanupMarker: string | undefined;
    let installJournal: string | undefined;
    let preserveInstallForRecovery = false;
    try {
      await extractAgentCorpusBundle(bundle, staging, { signal: deadline.signal });
      const verified = await verifyAgentCorpus(staging, creatorId, agentId, { signal: deadline.signal });
      verifiedDigest = verified.digest;
      const corpusKey = key(verified.creator.id, verified.agentId);
      priorCorpus = this.corpora.get(corpusKey);
      const existingBytes = this.corpusBytes.get(corpusKey) ?? 0;
      const existingFiles = this.corpusFiles.get(corpusKey) ?? 0;
      const creatorBytes = [...this.corpusBytes.entries()]
        .filter(([candidate]) => candidate.startsWith(`${verified.creator.id}:`))
        .reduce((total, [, bytes]) => total + bytes, 0);
      const globalBytes = [...this.corpusBytes.values()].reduce((total, bytes) => total + bytes, 0);
      const creatorFiles = [...this.corpusFiles.entries()]
        .filter(([candidate]) => candidate.startsWith(`${verified.creator.id}:`))
        .reduce((total, [, files]) => total + files, 0);
      const globalFiles = [...this.corpusFiles.values()].reduce((total, files) => total + files, 0);
      if (creatorBytes - existingBytes + verified.totalBytes > MAX_CORPUS_BYTES_PER_CREATOR) {
        throw new AgentCorpusVerificationError("Creator Agent Corpus storage quota exceeded");
      }
      if (globalBytes - existingBytes + verified.totalBytes > MAX_CORPUS_BYTES_GLOBAL) {
        throw new AgentCorpusVerificationError("Registry Agent Corpus storage quota exceeded");
      }
      if (creatorFiles - existingFiles + verified.totalFiles > MAX_CORPUS_FILES_PER_CREATOR) {
        throw new AgentCorpusVerificationError("Creator Agent Corpus file quota exceeded");
      }
      if (globalFiles - existingFiles + verified.totalFiles > MAX_CORPUS_FILES_GLOBAL) {
        throw new AgentCorpusVerificationError("Registry Agent Corpus file quota exceeded");
      }
      if (
        !this.corpora.has(corpusKey)
        && !this.corpusBytes.has(corpusKey)
        && new Set([
          ...[...this.corpora.values()].filter((item) => item.creator_id === verified.creator.id).map((item) => item.agent_id),
          ...[...this.corpusBytes.keys()].filter((candidate) => candidate.startsWith(`${verified.creator.id}:`)).map((candidate) => candidate.slice(verified.creator.id.length + 1)),
        ]).size >= MAX_AGENT_CORPORA_PER_CREATOR
      ) {
        throw new AgentCorpusVerificationError(`A Creator may publish at most ${MAX_AGENT_CORPORA_PER_CREATOR} Agents`);
      }
      const knowledgeDocuments = verified.corpus.knowledge.documents;
      if (knowledgeDocuments.length > 0 && !this.indexer) {
        throw new Error("Agent Corpus includes knowledge documents but Qdrant knowledge index is not configured");
      }
      install = await prepareCurrentCorpusInstall(verified, this.corpusRoot, { signal: deadline.signal });
      installJournal = await this.createCorpusInstallJournal(
        verified.creator.id,
        verified.agentId,
        verified.digest,
        priorCorpus?.corpus_digest,
        install,
      );
      if (this.indexer) {
        if (priorCorpus?.corpus_digest !== verified.digest) {
          stagedDigestCleanupMarker = await this.createIndexCleanupMarker(
            verified.creator.id,
            verified.agentId,
            verified.digest,
          );
        }
        indexAttempted = true;
        await deadline.wait(ingestAgentCorpusKnowledge(this.indexer, {
          corpus: verified.corpus,
          path: install.preparedPath,
          digest: verified.digest,
        }, deadline.signal));
      }
      const published: PublishedAgentCorpus = {
        creator_id: verified.creator.id,
        agent_id: verified.agentId,
        corpus_digest: verified.digest,
        creator_name: verified.creator.name,
        product_id: verified.product.id,
        product_name: verified.product.name,
        ...(verified.product.description ? { product_description: verified.product.description } : {}),
        ...(verified.product.promise ? { product_promise: verified.product.promise } : {}),
        product_boundaries: verified.product.boundaries,
        presentation: verified.product.presentation,
        knowledge_namespace: `${verified.creator.id}:${verified.agentId}`,
        status: "published",
        published_at: new Date().toISOString(),
      };
      deadline.throwIfExpired();
      await install.commit();
      try {
        await this.persistCorpus(published, deadline);
        metadataCommitted = true;
      } catch (persistError) {
        let canonicalDigest: string | undefined;
        try {
          canonicalDigest = await this.readCanonicalCorpusDigest(verified.creator.id, verified.agentId);
        } catch (reconciliationError) {
          preserveInstallForRecovery = true;
          this.publishOutcomeUnknown = new AggregateError(
            [persistError, reconciliationError],
            "Agent Corpus metadata commit outcome is unknown; restart Registry to run install-journal recovery",
          );
          throw this.publishOutcomeUnknown;
        }
        if (canonicalDigest === verified.digest) {
          // PostgreSQL may commit and then lose the response. A canonical
          // re-read turns that ambiguous transport failure into success.
          this.corpora.set(corpusKey, published);
          metadataCommitted = true;
        } else {
          throw persistError;
        }
      }
      this.corpusBytes.set(corpusKey, verified.totalBytes);
      this.corpusFiles.set(corpusKey, verified.totalFiles);
      const finalized = await install.finalize().then(() => true, () => false);
      if (finalized && installJournal) {
        await rm(installJournal, { force: true }).catch(() => undefined);
      }
      if (stagedDigestCleanupMarker) {
        await rm(stagedDigestCleanupMarker, { force: true }).catch(() => undefined);
      }
      if (this.indexer && priorCorpus && priorCorpus.corpus_digest !== verified.digest) {
        const oldDigestCleanupMarker = await this.createIndexCleanupMarker(
          verified.creator.id,
          verified.agentId,
          priorCorpus.corpus_digest,
        ).catch(() => undefined);
        if (oldDigestCleanupMarker) {
        await cleanIndexDigestBestEffort(
          this.indexer,
          verified.creator.id,
          verified.agentId,
          priorCorpus.corpus_digest,
          oldDigestCleanupMarker,
          deadline,
        );
        }
      }
      return published;
    } catch (error) {
      if (!metadataCommitted && install && !preserveInstallForRecovery) {
        try {
          await install.rollback();
          if (installJournal) await rm(installJournal, { force: true });
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Agent Corpus publish failed and filesystem rollback did not complete");
        }
      }
      if (
        !metadataCommitted
        && !preserveInstallForRecovery
        && indexAttempted
        && this.indexer
        && verifiedDigest
        && verifiedDigest !== priorCorpus?.corpus_digest
        && stagedDigestCleanupMarker
      ) {
        await cleanIndexDigestBestEffort(
          this.indexer,
          creatorId,
          agentId,
          verifiedDigest,
          stagedDigestCleanupMarker,
          deadline,
        );
      }
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async listAgentCorpora(creatorId: string): Promise<PublishedAgentCorpus[]> {
    requireUuidV4(creatorId, "creator_id");
    return [...this.corpora.values()].filter((item) => item.creator_id === creatorId).sort(byPublishedAt);
  }

  getAgentCorpus(creatorId: string, agentId: string): PublishedAgentCorpus | undefined {
    requireUuidV4(creatorId, "creator_id");
    requireUuidV4(agentId, "product_id");
    return this.corpora.get(key(creatorId, agentId));
  }

  async listAllAgentCorpora(options: { limit?: number; offset?: number } = {}): Promise<PublishedAgentCorpus[]> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 21) throw new Error("catalog limit is invalid");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error("catalog offset is invalid");
    return [...this.corpora.values()].sort(byPublishedAt).slice(offset, offset + limit);
  }

  databasePool(): Pool | undefined { return this.pool; }

  async checkReady(): Promise<void> {
    if (this.pool) await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> { await this.pool?.end(); }

  /** Stage a verified Factory candidate as an immutable release without changing current. */
  async stageAgentCorpusDirectory(
    creatorId: string,
    agentId: string,
    corpusRoot: string,
    expectedDigest: string
  ): Promise<PublishedAgentCorpus> {
    const verified = await verifyAgentCorpus(corpusRoot, creatorId, agentId);
    if (verified.digest !== expectedDigest) throw new Error("candidate_changed");
    const immutableRoot = await materializeAgentCorpusRelease(verified, this.corpusRoot);
    if (this.indexer) {
      await ingestAgentCorpusKnowledge(this.indexer, {
        corpus: verified.corpus,
        path: immutableRoot,
        digest: verified.digest
      });
    }
    return publishedCorpusFromVerified(verified);
  }

  async getAgentCorpusRelease(
    creatorId: string,
    agentId: string,
    corpusDigest: string
  ): Promise<PublishedAgentCorpus | undefined> {
    try {
      const releaseRoot = immutableReleasePath(this.corpusRoot, creatorId, agentId, corpusDigest);
      const verified = await verifyAgentCorpus(releaseRoot, creatorId, agentId);
      if (verified.digest !== corpusDigest) return undefined;
      return publishedCorpusFromVerified(verified);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async activateAgentCorpusRelease(
    creatorId: string,
    agentId: string,
    corpusDigest: string,
    options: { operationId: string; expectedCurrentDigest: string | null }
  ): Promise<PublishedAgentCorpus> {
    if (!options.operationId.trim()) throw new Error("invalid_deployment_operation_id");
    const release = await this.getAgentCorpusRelease(creatorId, agentId, corpusDigest);
    if (!release) throw new Error("agent_corpus_release_not_found");
    const current = this.getAgentCorpus(creatorId, agentId)?.corpus_digest ?? null;
    if (current === corpusDigest) {
      await activateCurrentCorpus(creatorId, agentId, corpusDigest, this.corpusRoot);
      return release;
    }
    if (current !== options.expectedCurrentDigest) {
      throw new RegistryDeploymentConflictError(options.expectedCurrentDigest, current, corpusDigest);
    }
    const deadline = new PublishDeadline(this.publishTimeoutMs);
    try {
      await this.persistCorpus(release, deadline);
      await activateCurrentCorpus(creatorId, agentId, corpusDigest, this.corpusRoot);
      return release;
    } finally {
      deadline.dispose();
    }
  }

  async grantAgentAccess(
    userId: string,
    creatorId: string,
    agentId: string,
    orderId: string,
    entitlementId?: string,
    purchasedCorpusDigest?: string,
    versionPolicy: "pinned" | "track_current_compatible" = "pinned"
  ): Promise<AgentAccessGrant> {
    requireUuidV4(userId, "user_id");
    requireUuidV4(creatorId, "creator_id");
    requireUuidV4(agentId, "product_id");
    const normalizedOrderId = orderId.trim();
    if (!normalizedOrderId) throw new Error("order_id_required");
    requireUuidV4(normalizedOrderId, "order_id");
    if (entitlementId !== undefined) requireUuidV4(entitlementId, "entitlement_id");
    const binding = accessBindingKey(userId, creatorId, agentId);
    const previous = this.accessMutations.get(binding);
    const mutation = (previous ? previous.catch(() => undefined) : Promise.resolve(undefined))
      .then(() => this.grantAgentAccessOnce(
        userId,
        creatorId,
        agentId,
        normalizedOrderId,
        entitlementId,
        purchasedCorpusDigest,
        versionPolicy
      ));
    this.accessMutations.set(binding, mutation);
    try {
      return await mutation;
    } finally {
      if (this.accessMutations.get(binding) === mutation) this.accessMutations.delete(binding);
    }
  }

  private async grantAgentAccessOnce(
    userId: string,
    creatorId: string,
    agentId: string,
    orderId: string,
    entitlementId?: string,
    purchasedCorpusDigest?: string,
    versionPolicy: "pinned" | "track_current_compatible" = "pinned"
  ): Promise<AgentAccessGrant> {
    const corpus = this.getAgentCorpus(creatorId, agentId);
    if (!corpus) throw new Error("agent_not_found");
    const boundDigest = purchasedCorpusDigest ?? corpus.corpus_digest;
    if (boundDigest !== corpus.corpus_digest) throw new Error("corpus_digest_mismatch");
    const grantedAt = new Date().toISOString();

    if (this.pool) {
      // The unique binding, not the caller-generated entitlement id, is the
      // authority. RETURNING gives every Registry replica the same canonical
      // row when concurrent checkout requests race across processes.
      const result = await this.pool.query(`INSERT INTO agent_access
        (entitlement_id, user_id, creator_id, agent_id, product_id, order_id, purchased_corpus_digest, version_policy, status, granted_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9)
        ON CONFLICT (user_id, creator_id, agent_id) DO UPDATE SET
          -- Commerce owns the entitlement identity. Rebind an orphan row, or
          -- repair a row whose order already points at this checkout but kept
          -- the pre-Commerce entitlement id. Do not let a later checkout
          -- silently rewrite an already-bound order's identity.
          entitlement_id=CASE
            WHEN agent_access.order_id IS NULL
              OR (agent_access.order_id = EXCLUDED.order_id AND agent_access.entitlement_id <> EXCLUDED.entitlement_id)
            THEN EXCLUDED.entitlement_id
            ELSE agent_access.entitlement_id
          END,
          product_id=EXCLUDED.product_id,
          order_id=EXCLUDED.order_id,
          purchased_corpus_digest=EXCLUDED.purchased_corpus_digest,
          version_policy=EXCLUDED.version_policy,
          status='active',
          granted_at=CASE WHEN agent_access.status='active' THEN agent_access.granted_at ELSE EXCLUDED.granted_at END
        RETURNING entitlement_id, user_id, creator_id, agent_id, product_id, order_id, purchased_corpus_digest, version_policy, status, granted_at`, [
        entitlementId ?? randomUUID(),
        userId,
        creatorId,
        agentId,
        corpus.product_id,
        orderId,
        boundDigest,
        versionPolicy,
        grantedAt
      ]);
      const canonical = rowToAccess(result.rows[0]);
      for (const [entitlementId, cached] of this.access) {
        if (accessBindingKey(cached.user_id, cached.creator_id, cached.agent_id) === accessBindingKey(userId, creatorId, agentId)) {
          this.access.delete(entitlementId);
        }
      }
      this.access.set(canonical.entitlement_id, canonical);
      return canonical;
    }

    const existing = [...this.access.values()].find((item) => item.user_id === userId && item.creator_id === creatorId && item.agent_id === agentId);
    if (existing) {
      const orderChanged = orderId !== existing.order_id;
      const rebindCanonicalIdentity = typeof entitlementId === "string"
        && entitlementId !== existing.entitlement_id
        && (!existing.order_id || existing.order_id === orderId);
      if (existing.status !== "active" || orderChanged || existing.product_id !== corpus.product_id || rebindCanonicalIdentity) {
        const updated = {
          ...existing,
          ...(rebindCanonicalIdentity ? { entitlement_id: entitlementId } : {}),
          product_id: corpus.product_id,
          access_mode: "unmetered" as const,
          status: "active" as const,
          order_id: orderId,
          purchased_corpus_digest: boundDigest,
          version_policy: versionPolicy,
          ...(existing.status !== "active" ? { granted_at: grantedAt } : {})
        };
        if (rebindCanonicalIdentity) this.access.delete(existing.entitlement_id);
        this.access.set(updated.entitlement_id, updated);
        try {
          await this.persistState();
        } catch (error) {
          this.access.delete(updated.entitlement_id);
          this.access.set(existing.entitlement_id, existing);
          throw error;
        }
        return updated;
      }
      return existing;
    }
    const grant: AgentAccessGrant = {
      entitlement_id: entitlementId ?? randomUUID(),
      user_id: userId,
      creator_id: creatorId,
      agent_id: agentId,
      product_id: corpus.product_id,
      access_mode: "unmetered" as const,
      order_id: orderId,
      purchased_corpus_digest: boundDigest,
      version_policy: versionPolicy,
      status: "active",
      granted_at: grantedAt,
    };
    this.access.set(grant.entitlement_id, grant);
    try {
      await this.persistState();
    } catch (error) {
      this.access.delete(grant.entitlement_id);
      throw error;
    }
    return grant;
  }

  async revokeAgentAccess(entitlementId: string, userId: string): Promise<AgentAccessGrant | undefined> {
    const existing = this.access.get(entitlementId);
    if (!existing || existing.user_id !== userId) return undefined;
    if (this.pool) {
      const result = await this.pool.query(`UPDATE agent_access SET status='revoked'
        WHERE entitlement_id=$1 AND user_id=$2
        RETURNING entitlement_id, user_id, creator_id, agent_id, product_id, order_id, purchased_corpus_digest, version_policy, status, granted_at`, [entitlementId, userId]);
      if (!result.rows[0]) return undefined;
      const revoked = rowToAccess(result.rows[0]);
      this.access.set(entitlementId, revoked);
      return revoked;
    }
    const revoked: AgentAccessGrant = { ...existing, status: "revoked" };
    this.access.set(entitlementId, revoked);
    try {
      await this.persistState();
      return revoked;
    } catch (error) {
      this.access.set(entitlementId, existing);
      throw error;
    }
  }

  async listAgentAccess(userId: string, options: AgentAccessListOptions = {}): Promise<AgentAccessGrant[]> {
    const page = accessListPage(options);
    if (this.pool) {
      const result = await this.pool.query(`SELECT entitlement_id, user_id, creator_id, agent_id, product_id, order_id, purchased_corpus_digest, version_policy, status, granted_at
        FROM agent_access
        WHERE user_id=$1 AND status='active'${options.entitlementId ? " AND entitlement_id=$2" : ""}
        ORDER BY granted_at DESC
        LIMIT $${options.entitlementId ? 3 : 2} OFFSET $${options.entitlementId ? 4 : 3}`,
      options.entitlementId
        ? [userId, options.entitlementId, page.limit, page.offset]
        : [userId, page.limit, page.offset]);
      const canonical = result.rows.map(rowToAccess);
      for (const [entitlementId, cached] of this.access) {
        if (cached.user_id === userId) this.access.delete(entitlementId);
      }
      for (const grant of canonical) this.access.set(grant.entitlement_id, grant);
      return canonical;
    }
    return [...this.access.values()]
      .filter((item) => item.user_id === userId && item.status === "active")
      .filter((item) => !options.entitlementId || item.entitlement_id === options.entitlementId)
      .sort((left, right) => Date.parse(right.granted_at) - Date.parse(left.granted_at))
      .slice(page.offset, page.offset + page.limit);
  }

  async listAgentAccessPresentation(userId: string, options: AgentAccessListOptions = {}): Promise<AgentAccessPresentation[]> {
    const page = accessListPage(options);
    if (this.pool) {
      const result = await this.pool.query(`SELECT
          a.entitlement_id, a.user_id, a.creator_id, a.agent_id, a.product_id, a.order_id,
          a.purchased_corpus_digest, a.version_policy,
          a.status AS access_status, a.granted_at,
          c.creator_name, c.product_name, c.product_description, c.product_json
        FROM agent_access AS a
        JOIN agent_corpora AS c ON c.creator_id=a.creator_id AND c.agent_id=a.agent_id
        WHERE a.user_id=$1 AND a.status='active' AND c.status='published'${options.entitlementId ? " AND a.entitlement_id=$2" : ""}
        ORDER BY a.granted_at DESC
        LIMIT $${options.entitlementId ? 3 : 2} OFFSET $${options.entitlementId ? 4 : 3}`,
      options.entitlementId
        ? [userId, options.entitlementId, page.limit, page.offset]
        : [userId, page.limit, page.offset]);
      return result.rows.map(rowToAccessPresentation);
    }
    return (await this.listAgentAccess(userId, options)).flatMap((grant) => {
      const corpus = this.getAgentCorpus(grant.creator_id, grant.agent_id);
      if (!corpus || corpus.status !== "published") return [];
      return [{
        ...grant,
        creator: { id: corpus.creator_id, name: corpus.creator_name },
        product: {
          id: corpus.product_id,
          name: corpus.product_name,
          description: corpus.product_description ?? "Work with this Creator Agent in your own files and context."
        },
        presentation: corpus.presentation
      }];
    });
  }

  async upsertCreatorToolConnection(input: {
    tenantId: string;
    connectionId: string;
    kind: "http" | "mcp";
    secretRef: string | null;
    secret: string | null;
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
      secret: input.secret,
      config: input.config,
      status: input.status
    };
    this.toolConnections.set(connection.id, connection);
    if (this.pool) {
      await this.pool.query(`INSERT INTO tool_connections (id, tenant_id, kind, secret_ref, secret_value, config_json, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, kind=EXCLUDED.kind, secret_ref=EXCLUDED.secret_ref, secret_value=EXCLUDED.secret_value, config_json=EXCLUDED.config_json, status=EXCLUDED.status`,
        [connection.id, connection.tenant_id, connection.kind, connection.secret_ref, connection.secret, JSON.stringify(connection.config), connection.status]);
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
    if (this.pool) {
      const result = await this.pool.query(`SELECT c.id, c.tenant_id, c.kind, c.secret_ref, c.secret_value, c.config_json, c.status
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
      throw new Error(`no Control Plane binding for ${input.tenantId}/${input.agentId}/${input.toolId}`);
    }
    const connectionId = this.toolBindings.get(bindingKey);
    const connection = connectionId ? this.toolConnections.get(connectionId) : undefined;
    if (connection) {
      if (connection.status !== "active") throw new Error(`tool connection is not active: ${connection.id}`);
      return connection;
    }
    throw new Error(`no Control Plane binding for ${input.tenantId}/${input.agentId}/${input.toolId}`);
  }

  private async ensureSchema(): Promise<void> {
    await this.migrateLegacyIdentitySchema();
    await this.ensureCurrentSchema();
    await migrateUuidAuthorityIds(this.pool!);
  }

  /**
   * Perform the one-way UUID cutover for the original text-key Registry
   * tables. This runs before the typed schema is created, in the same
   * transaction as the data copy, so a failed deployment leaves the old
   * database untouched and a successful deployment leaves no slug authority
   * behind. Unknown real records receive a fresh UUID v4; the canonical
   * shipped Seth/Maya records retain their published UUIDs.
   */
  private async migrateLegacyIdentitySchema(): Promise<void> {
    const pool = this.pool!;
    const columns = await pool.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('agent_corpora', 'agent_access', 'agent_tool_bindings')
    `);
    const identityColumns = new Set(["creator_id", "agent_id", "product_id"]);
    const legacy = columns.rows.some((row) =>
      identityColumns.has(String(row.column_name)) && String(row.data_type) !== "uuid"
    );
    if (!legacy) return;

    const tableNames = {
      corpora: "agent_corpora",
      access: "agent_access",
      bindings: "agent_tool_bindings",
    } as const;
    const suffix = `legacy_uuid_cutover_${Date.now()}_${randomUUID().replaceAll("-", "")}`;
    const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const existing = await pool.query(`
      SELECT tablename
      FROM pg_catalog.pg_tables
      WHERE schemaname = current_schema() AND tablename = ANY($1::text[])
    `, [Object.values(tableNames)]);
    const existingNames = new Set(existing.rows.map((row) => String(row.tablename)));
    const legacyTables = new Map<keyof typeof tableNames, string>();
    for (const [kind, table] of Object.entries(tableNames) as Array<[keyof typeof tableNames, string]>) {
      if (existingNames.has(table)) {
        legacyTables.set(kind, `${table}_${suffix}`);
      }
    }

    const knownCreators = new Map([
      ["seth", "32ffccf7-893d-4ef3-bdbc-c82fc8fcb90b"],
      ["maya-chen", "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21"],
      ["madeline-mann", "90e72cbf-c474-4897-baab-ae7261b0a89f"],
    ]);
    const knownProducts = new Map([
      ["seth\u0000alpha-lite", "026651b1-8a8a-4484-aac5-ace6bd662157"],
      ["maya-chen\u0000signal-resume-review", "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42"],
      ["maya-chen\u0000maya-chen-resume-review", "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42"],
      ["madeline-mann\u0000interview-answer-rewriter", "4f357cee-ea68-45cf-a364-bc771aea850e"],
    ]);
    const creatorIds = new Map<string, string>();
    const productIds = new Map<string, string>();
    const creatorIdFor = (value: unknown): string => {
      const legacyId = String(value ?? "").trim();
      if (!legacyId) throw new Error("Registry UUID cutover found an empty creator identity");
      const existingId = creatorIds.get(legacyId);
      if (existingId) return existingId;
      const id = knownCreators.get(legacyId) ?? (isUuidV4(legacyId) ? legacyId.toLowerCase() : randomUUID());
      creatorIds.set(legacyId, id);
      return id;
    };
    const productIdFor = (creatorLegacy: unknown, value: unknown): string => {
      const creatorKey = String(creatorLegacy ?? "").trim();
      const productKey = String(value ?? "").trim();
      if (!productKey) throw new Error("Registry UUID cutover found an empty product identity");
      const composite = `${creatorKey}\u0000${productKey}`;
      const existingId = productIds.get(composite);
      if (existingId) return existingId;
      const id = knownProducts.get(composite) ?? (isUuidV4(productKey) ? productKey.toLowerCase() : randomUUID());
      productIds.set(composite, id);
      return id;
    };
    const text = (value: unknown, fallback: string): string => {
      const normalized = String(value ?? "").trim();
      return normalized || fallback;
    };
    const timestamp = (value: unknown): string => {
      const parsed = new Date(String(value ?? ""));
      return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
    };

    const client = typeof (pool as any).connect === "function" ? await (pool as any).connect() : undefined;
    const executor = client ?? pool;
    try {
      if (client) await client.query("BEGIN");
      for (const table of Object.values(tableNames)) {
        if (existingNames.has(table)) {
          await executor.query(`ALTER TABLE ${quoted(table)} RENAME TO ${quoted(`${table}_${suffix}`)}`);
        }
      }
      await this.ensureCurrentSchema(executor);

      const oldRows = async (kind: keyof typeof tableNames): Promise<Record<string, any>[]> => {
        const table = legacyTables.get(kind);
        if (!table) return [];
        return (await executor.query(`SELECT * FROM ${quoted(table)}`) as { rows: Record<string, any>[] }).rows;
      };
      const corpora = await oldRows("corpora");
      const access = await oldRows("access");
      const bindings = await oldRows("bindings");
      const legacyTenants = new Set<string>([
        ...corpora.map((row) => String(row.creator_id ?? "").trim()).filter(Boolean),
        ...access.map((row) => String(row.creator_id ?? "").trim()).filter(Boolean),
        ...bindings.map((row) => String(row.tenant_id ?? "").trim()).filter(Boolean),
      ]);
      for (const legacyTenant of legacyTenants) {
        await executor.query(
          "UPDATE tool_connections SET tenant_id=$1 WHERE tenant_id=$2",
          [creatorIdFor(legacyTenant), legacyTenant],
        );
      }
      const products = new Set<string>();
      const ensureProduct = async (creatorLegacy: unknown, productLegacy: unknown, row: Record<string, any>): Promise<{ creatorId: string; productId: string }> => {
        const creatorId = creatorIdFor(creatorLegacy);
        const productId = productIdFor(creatorLegacy, productLegacy);
        const productKey = `${creatorId}\u0000${productId}`;
        if (!products.has(productKey)) {
          const creatorName = text(row.creator_name, String(creatorLegacy ?? "Creator"));
          const productName = text(row.product_name, String(productLegacy ?? "Creator Agent"));
          await executor.query(
            `INSERT INTO creators (id, display_name) VALUES ($1,$2)
             ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`,
            [creatorId, creatorName],
          );
          await executor.query(
            `INSERT INTO products (id, creator_id, name, description, status) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (id) DO UPDATE SET creator_id=EXCLUDED.creator_id, name=EXCLUDED.name, description=EXCLUDED.description, status=EXCLUDED.status`,
            [productId, creatorId, productName, text(row.product_description, productName), text(row.status, "published")],
          );
          products.add(productKey);
        }
        return { creatorId, productId };
      };

      for (const row of corpora) {
        const creatorLegacy = row.creator_id;
        const productLegacy = row.product_id ?? row.agent_id;
        const { creatorId, productId } = await ensureProduct(creatorLegacy, productLegacy, row);
        const productJson = row.product_json
          ? String(row.product_json)
          : JSON.stringify({ boundaries: [], presentation: {} });
        await executor.query(
          `INSERT INTO agent_corpora
             (creator_id, agent_id, corpus_digest, creator_name, product_id, product_name,
              product_description, product_json, knowledge_namespace, status, published_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (creator_id, agent_id) DO UPDATE SET
             corpus_digest=EXCLUDED.corpus_digest, creator_name=EXCLUDED.creator_name,
             product_id=EXCLUDED.product_id, product_name=EXCLUDED.product_name,
             product_description=EXCLUDED.product_description, product_json=EXCLUDED.product_json,
             knowledge_namespace=EXCLUDED.knowledge_namespace, status=EXCLUDED.status,
             published_at=EXCLUDED.published_at`,
          [
            creatorId,
            productId,
            (() => {
              const digest = String(row.corpus_digest ?? "").trim();
              if (!digest) throw new Error(`Registry UUID cutover found an empty corpus digest for ${creatorLegacy}/${productLegacy}`);
              return digest;
            })(),
            text(row.creator_name, String(creatorLegacy)),
            productId,
            text(row.product_name, String(productLegacy)),
            row.product_description ?? null,
            productJson,
            `${creatorId}:${productId}`,
            text(row.status, "published"),
            timestamp(row.published_at),
          ],
        );
      }
      for (const row of access) {
        const creatorLegacy = row.creator_id;
        const productLegacy = row.product_id ?? row.agent_id;
        const { creatorId, productId } = await ensureProduct(creatorLegacy, productLegacy, row);
        const entitlementLegacy = String(row.entitlement_id ?? "").trim();
        const userLegacy = String(row.user_id ?? "").trim();
        if (!entitlementLegacy) throw new Error("Registry UUID cutover found an empty entitlement identity");
        if (!userLegacy) throw new Error("Registry UUID cutover found an empty user identity");
        const entitlementId = await mapLegacyAuthorityId(executor, "entitlement", entitlementLegacy);
        const userId = await mapLegacyAuthorityId(executor, "account", userLegacy);
        const orderLegacy = String(row.order_id ?? "").trim();
        const orderId = orderLegacy ? await mapLegacyAuthorityId(executor, "order", orderLegacy) : null;
        await executor.query(
          `INSERT INTO agent_access
             (entitlement_id, user_id, creator_id, agent_id, product_id, order_id,
              purchased_corpus_digest, version_policy, status, granted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (user_id, creator_id, agent_id) DO UPDATE SET
             product_id=EXCLUDED.product_id, order_id=COALESCE(agent_access.order_id, EXCLUDED.order_id),
             purchased_corpus_digest=COALESCE(agent_access.purchased_corpus_digest, EXCLUDED.purchased_corpus_digest),
             version_policy=EXCLUDED.version_policy, status=EXCLUDED.status`,
          [
            entitlementId,
            userId,
            creatorId,
            productId,
            productId,
            orderId,
            row.purchased_corpus_digest ?? null,
            row.version_policy === "track_current_compatible" ? "track_current_compatible" : "pinned",
            row.status === "revoked" ? "revoked" : row.status === "disabled" ? "disabled" : "active",
            timestamp(row.granted_at),
          ],
        );
      }
      for (const row of bindings) {
        const creatorLegacy = row.tenant_id;
        const productLegacy = row.agent_id;
        const creatorId = creatorIdFor(creatorLegacy);
        const productId = productIdFor(creatorLegacy, productLegacy);
        await executor.query(
          `INSERT INTO agent_tool_bindings (tenant_id, agent_id, tool_id, connection_id)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id, agent_id, tool_id) DO UPDATE SET connection_id=EXCLUDED.connection_id`,
          [creatorId, productId, String(row.tool_id), String(row.connection_id)],
        );
      }
      for (const table of legacyTables.values()) await executor.query(`DROP TABLE IF EXISTS ${quoted(table)}`);
      if (client) await client.query("COMMIT");
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client?.release();
    }
  }

  private async ensureCurrentSchema(executor: { query: (text: string) => Promise<unknown> } = this.pool!): Promise<void> {
    await executor.query(`
      CREATE TABLE IF NOT EXISTS creators (
        id UUID PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY,
        creator_id UUID NOT NULL REFERENCES creators(id),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS agent_corpora (
        creator_id UUID NOT NULL REFERENCES creators(id),
        agent_id UUID NOT NULL REFERENCES products(id),
        corpus_digest TEXT NOT NULL,
        creator_name TEXT NOT NULL,
        product_id UUID NOT NULL REFERENCES products(id),
        product_name TEXT NOT NULL,
        product_description TEXT,
        product_json TEXT,
        knowledge_namespace TEXT NOT NULL,
        status TEXT NOT NULL,
        published_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (creator_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS agent_access (
        entitlement_id UUID PRIMARY KEY,
        user_id UUID NOT NULL,
        creator_id UUID NOT NULL REFERENCES creators(id),
        agent_id UUID NOT NULL REFERENCES products(id),
        product_id UUID NOT NULL REFERENCES products(id),
        order_id UUID,
        purchased_corpus_digest TEXT,
        version_policy TEXT NOT NULL DEFAULT 'pinned',
        status TEXT NOT NULL,
        granted_at TIMESTAMPTZ NOT NULL,
        UNIQUE (user_id, creator_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS tool_connections (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        secret_ref TEXT,
        secret_value TEXT,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL
      );
      ALTER TABLE tool_connections ADD COLUMN IF NOT EXISTS secret_value TEXT;
      ALTER TABLE agent_corpora ADD COLUMN IF NOT EXISTS product_json TEXT;
      ALTER TABLE agent_access ADD COLUMN IF NOT EXISTS order_id TEXT;
      ALTER TABLE agent_access ADD COLUMN IF NOT EXISTS purchased_corpus_digest TEXT;
      ALTER TABLE agent_access ADD COLUMN IF NOT EXISTS version_policy TEXT NOT NULL DEFAULT 'pinned';
      CREATE TABLE IF NOT EXISTS agent_tool_bindings (
        tenant_id TEXT NOT NULL,
        agent_id UUID NOT NULL REFERENCES products(id),
        tool_id TEXT NOT NULL,
        connection_id TEXT NOT NULL REFERENCES tool_connections(id),
        PRIMARY KEY (tenant_id, agent_id, tool_id)
      );
    `);
  }

  private async load(): Promise<void> {
    if (this.pool) {
      try {
      const corpora = await this.pool.query("SELECT creator_id, agent_id, corpus_digest, creator_name, product_id, product_name, product_description, product_json, knowledge_namespace, status, published_at FROM agent_corpora");
      for (const row of corpora.rows) {
        requireUuidV4(row.creator_id, "creator_id");
        requireUuidV4(row.agent_id, "product_id");
        requireUuidV4(row.product_id, "product_id");
        assertCanonicalProductIdentity(row.agent_id, row.product_id);
        this.corpora.set(key(row.creator_id, row.agent_id), rowToCorpus(row));
      }
      const access = await this.pool.query("SELECT entitlement_id, user_id, creator_id, agent_id, product_id, order_id, purchased_corpus_digest, version_policy, status, granted_at FROM agent_access");
        for (const row of access.rows) {
          requireUuidV4(row.creator_id, "creator_id");
          requireUuidV4(row.agent_id, "product_id");
          requireUuidV4(row.product_id, "product_id");
          assertCanonicalProductIdentity(row.agent_id, row.product_id);
          this.access.set(row.entitlement_id, rowToAccess(row));
        }
        const connections = await this.pool.query("SELECT id, tenant_id, kind, secret_ref, secret_value, config_json, status FROM tool_connections");
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
      if (state.schema_version !== 2) throw new Error("Registry state schema_version 2 is required after UUID identity cutover");
      for (const corpus of state.agent_corpora ?? []) {
        requireUuidV4(corpus.creator_id, "creator_id");
        requireUuidV4(corpus.agent_id, "product_id");
        requireUuidV4(corpus.product_id, "product_id");
        assertCanonicalProductIdentity(corpus.agent_id, corpus.product_id);
        this.corpora.set(key(corpus.creator_id, corpus.agent_id), {
        ...corpus,
        product_boundaries: corpus.product_boundaries ?? [],
        presentation: corpus.presentation ?? {}
        });
      }
      for (const grant of state.agent_access ?? []) {
        requireUuidV4(grant.creator_id, "creator_id");
        requireUuidV4(grant.agent_id, "product_id");
        requireUuidV4(grant.product_id, "product_id");
        assertCanonicalProductIdentity(grant.agent_id, grant.product_id);
        this.access.set(grant.entitlement_id, grant);
      }
      for (const connection of state.tool_connections ?? []) this.toolConnections.set(connection.id, { ...connection, secret: connection.secret ?? null });
      for (const binding of state.agent_tool_bindings ?? []) this.toolBindings.set(toolBindingKey(binding.tenant_id, binding.agent_id, binding.tool_id), binding.connection_id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async loadCorpusByteAccounting(): Promise<void> {
    this.corpusBytes.clear();
    this.corpusFiles.clear();
    let creators;
    try { creators = await readdir(this.corpusRoot, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const creator of creators) {
      if (!creator.isDirectory() || creator.name.startsWith(".")) continue;
      const creatorRoot = path.join(this.corpusRoot, creator.name);
      for (const agent of await readdir(creatorRoot, { withFileTypes: true })) {
        if (!agent.isDirectory() || agent.name.startsWith(".")) continue;
        const usage = await directoryUsage(path.join(creatorRoot, agent.name));
        this.corpusBytes.set(key(creator.name, agent.name), usage.bytes);
        this.corpusFiles.set(key(creator.name, agent.name), usage.files);
      }
    }
  }

  private async createCorpusInstallJournal(
    creatorId: string,
    agentId: string,
    newDigest: string,
    previousDigest: string | undefined,
    install: CurrentCorpusInstallTransaction,
  ): Promise<string> {
    const directory = path.join(this.corpusRoot, ".install-journal");
    const journalPath = path.join(directory, `${creatorId}--${agentId}--${randomUUID()}.json`);
    await writeDurableJsonFile(journalPath, {
      creator_id: creatorId,
      agent_id: agentId,
      new_digest: newDigest,
      ...(previousDigest ? { previous_digest: previousDigest } : {}),
      current_path: install.currentPath,
      prepared_path: install.preparedPath,
      backup_path: install.backupPath,
    });
    return journalPath;
  }

  private async recoverPendingCorpusInstalls(): Promise<void> {
    const directory = path.join(this.corpusRoot, ".install-journal");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
      const journalPath = path.join(directory, entry.name);
      const journal = await this.readCorpusInstallJournal(journalPath);
      const canonicalDigest = await this.readCanonicalCorpusDigest(journal.creator_id, journal.agent_id);
      const currentDigest = await verifiedDigestAt(
        journal.current_path,
        journal.creator_id,
        journal.agent_id,
      );

      if (canonicalDigest === journal.new_digest) {
        if (currentDigest !== journal.new_digest) {
          throw new Error(`Agent Corpus recovery found committed metadata without its filesystem current: ${journal.creator_id}/${journal.agent_id}`);
        }
        await rm(journal.prepared_path, { recursive: true, force: true });
        await rm(journal.backup_path, { recursive: true, force: true });
        await rm(journalPath, { force: true });
        continue;
      }

      // A later publish may already have installed the canonical version. In
      // that case this old journal is superseded and must not roll it back.
      if (canonicalDigest && currentDigest === canonicalDigest) {
        await rm(journal.prepared_path, { recursive: true, force: true });
        await rm(journal.backup_path, { recursive: true, force: true });
        await rm(journalPath, { force: true });
        continue;
      }

      if (await pathExists(journal.backup_path)) {
        const displaced = `${journal.current_path}.${randomUUID()}.recovery`;
        const hadCurrent = await pathExists(journal.current_path);
        if (hadCurrent) await rename(journal.current_path, displaced);
        try {
          await rename(journal.backup_path, journal.current_path);
        } catch (error) {
          if (hadCurrent) await rename(displaced, journal.current_path).catch(() => undefined);
          throw error;
        }
        if (hadCurrent) await rm(displaced, { recursive: true, force: true });
      } else if (currentDigest === journal.new_digest) {
        if (journal.previous_digest) {
          throw new Error(`Agent Corpus recovery cannot restore missing backup for ${journal.creator_id}/${journal.agent_id}`);
        }
        await rm(journal.current_path, { recursive: true, force: true });
      }
      await rm(journal.prepared_path, { recursive: true, force: true });

      const restoredDigest = await verifiedDigestAt(
        journal.current_path,
        journal.creator_id,
        journal.agent_id,
      );
      const expectedDigest = canonicalDigest ?? journal.previous_digest;
      if (restoredDigest !== expectedDigest) {
        throw new Error(`Agent Corpus recovery could not restore canonical filesystem state for ${journal.creator_id}/${journal.agent_id}`);
      }
      await rm(journalPath, { force: true });
    }
  }

  private async readCorpusInstallJournal(journalPath: string): Promise<CorpusInstallJournal> {
    const metadata = await stat(journalPath);
    if (metadata.size > 16_384) throw new Error(`Agent Corpus install journal is oversized: ${journalPath}`);
    const parsed = JSON.parse(await readFile(journalPath, "utf8")) as Partial<CorpusInstallJournal>;
    if (
      typeof parsed.creator_id !== "string"
      || typeof parsed.agent_id !== "string"
      || typeof parsed.new_digest !== "string"
      || typeof parsed.current_path !== "string"
      || typeof parsed.prepared_path !== "string"
      || typeof parsed.backup_path !== "string"
      || !isUuidV4(parsed.creator_id)
      || !isUuidV4(parsed.agent_id)
      || !/^sha256:[a-f0-9]{64}$/.test(parsed.new_digest)
      || (parsed.previous_digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(parsed.previous_digest))
    ) throw new Error(`Agent Corpus install journal is invalid: ${journalPath}`);
    const expectedCurrent = path.join(this.corpusRoot, parsed.creator_id, parsed.agent_id);
    const expectedDirectory = path.dirname(expectedCurrent);
    if (
      path.resolve(parsed.current_path) !== expectedCurrent
      || path.dirname(path.resolve(parsed.prepared_path)) !== expectedDirectory
      || path.dirname(path.resolve(parsed.backup_path)) !== expectedDirectory
      || !path.basename(parsed.prepared_path).startsWith(`.${parsed.agent_id}.`)
      || !path.basename(parsed.prepared_path).endsWith(".prepared")
      || !path.basename(parsed.backup_path).startsWith(`.${parsed.agent_id}.`)
      || !path.basename(parsed.backup_path).endsWith(".backup")
    ) throw new Error(`Agent Corpus install journal paths are invalid: ${journalPath}`);
    return parsed as CorpusInstallJournal;
  }

  private async createIndexCleanupMarker(
    creatorId: string,
    agentId: string,
    corpusDigest: string,
  ): Promise<string> {
    const directory = path.join(this.corpusRoot, ".index-gc");
    const marker = path.join(directory, `${creatorId}--${agentId}--${corpusDigest.slice("sha256:".length)}.json`);
    await writeDurableJsonFile(marker, {
      creator_id: creatorId,
      agent_id: agentId,
      corpus_digest: corpusDigest,
    });
    return marker;
  }

  private async resumePendingIndexCleanup(): Promise<void> {
    if (!this.indexer) return;
    const directory = path.join(this.corpusRoot, ".index-gc");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // Bound startup repair work. Remaining markers stay durable for the next
    // process start instead of making Registry availability depend on Qdrant.
    for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json")).slice(0, 20)) {
      const markerPath = path.join(directory, entry.name);
      let marker: { creator_id: string; agent_id: string; corpus_digest: string };
      try {
        const metadata = await stat(markerPath);
        if (metadata.size > 4_096) throw new Error("cleanup marker is oversized");
        marker = JSON.parse(await readFile(markerPath, "utf8")) as typeof marker;
        if (
          !isUuidV4(marker.creator_id)
          || !isUuidV4(marker.agent_id)
          || !/^sha256:[a-f0-9]{64}$/.test(marker.corpus_digest)
        ) throw new Error("cleanup marker is invalid");
      } catch {
        continue;
      }
      const currentDigest = await this.readCanonicalCorpusDigest(marker.creator_id, marker.agent_id);
      if (currentDigest === marker.corpus_digest) {
        await rm(markerPath, { force: true });
        continue;
      }
      try {
        const latestDigest = await this.readCanonicalCorpusDigest(marker.creator_id, marker.agent_id);
        if (latestDigest === marker.corpus_digest) {
          await rm(markerPath, { force: true });
          continue;
        }
        await removeAgentCorpusKnowledge(
          this.indexer,
          marker.creator_id,
          marker.agent_id,
          marker.corpus_digest,
        );
        const digestAfterDelete = await this.readCanonicalCorpusDigest(marker.creator_id, marker.agent_id);
        if (digestAfterDelete === marker.corpus_digest) {
          const current = await verifyAgentCorpus(
            path.join(this.corpusRoot, marker.creator_id, marker.agent_id),
            marker.creator_id,
            marker.agent_id,
          );
          await ingestAgentCorpusKnowledge(this.indexer, current);
        }
        await rm(markerPath, { force: true });
      } catch {
        // Keep the marker so a later Registry process can retry.
      }
    }
  }

  private async readCanonicalCorpusDigest(creatorId: string, agentId: string): Promise<string | undefined> {
    if (!this.pool) return this.corpora.get(key(creatorId, agentId))?.corpus_digest;
    const result = await this.pool.query(
      "SELECT corpus_digest FROM agent_corpora WHERE creator_id=$1 AND agent_id=$2",
      [creatorId, agentId],
    );
    return result.rows[0]?.corpus_digest ? String(result.rows[0].corpus_digest) : undefined;
  }

  private async persistCorpus(corpus: PublishedAgentCorpus, deadline: PublishDeadline): Promise<void> {
    const corpusKey = key(corpus.creator_id, corpus.agent_id);
    requireUuidV4(corpus.creator_id, "creator_id");
    requireUuidV4(corpus.product_id, "product_id");
    requireUuidV4(corpus.agent_id, "product_id");
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO creators (id, display_name) VALUES ($1,$2)
         ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`,
        [corpus.creator_id, corpus.creator_name],
      );
      await this.pool.query(
        `INSERT INTO products (id, creator_id, name, description, status)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET creator_id=EXCLUDED.creator_id, name=EXCLUDED.name, description=EXCLUDED.description, status=EXCLUDED.status`,
        [corpus.product_id, corpus.creator_id, corpus.product_name, corpus.product_description ?? corpus.product_name, corpus.status],
      );
      const query: QueryConfig & { query_timeout: number } = {
        text: `INSERT INTO agent_corpora (creator_id, agent_id, corpus_digest, creator_name, product_id, product_name, product_description, product_json, knowledge_namespace, status, published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (creator_id, agent_id) DO UPDATE SET corpus_digest=EXCLUDED.corpus_digest, creator_name=EXCLUDED.creator_name, product_id=EXCLUDED.product_id, product_name=EXCLUDED.product_name, product_description=EXCLUDED.product_description, product_json=EXCLUDED.product_json, knowledge_namespace=EXCLUDED.knowledge_namespace, status=EXCLUDED.status, published_at=EXCLUDED.published_at`,
        values: [corpus.creator_id, corpus.agent_id, corpus.corpus_digest, corpus.creator_name, corpus.product_id, corpus.product_name, corpus.product_description ?? null, JSON.stringify({ promise: corpus.product_promise, boundaries: corpus.product_boundaries, presentation: corpus.presentation }), corpus.knowledge_namespace, corpus.status, corpus.published_at],
        query_timeout: deadline.remainingMs(),
      };
      await this.pool.query(query);
      // The database row is authoritative. Do not expose the new metadata in
      // this process until the upsert has actually committed.
      this.corpora.set(corpusKey, corpus);
      return;
    }
    const nextCorpora = new Map(this.corpora);
    nextCorpora.set(corpusKey, corpus);
    await this.persistState({ corpora: nextCorpora.values(), signal: deadline.signal });
    this.corpora.set(corpusKey, corpus);
  }

  private async persistState(options: {
    corpora?: Iterable<PublishedAgentCorpus>;
    signal?: AbortSignal;
  } = {}): Promise<void> {
    if (!this.statePath) return;
    throwIfAborted(options.signal);
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    const state = {
      schema_version: 2,
      agent_corpora: [...(options.corpora ?? this.corpora.values())],
      agent_access: [...this.access.values()],
      tool_connections: [...this.toolConnections.values()],
      agent_tool_bindings: [...this.toolBindings.entries()].map(([binding, connection_id]) => {
        const [tenant_id, agent_id, ...toolParts] = binding.split("\u0000");
        return { tenant_id, agent_id, tool_id: toolParts.join("\u0000"), connection_id };
      })
    };
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
        encoding: "utf8",
        signal: options.signal,
      });
      throwIfAborted(options.signal);
      await rename(temporary, this.statePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async readToolConnection(connectionId: string): Promise<CreatorToolConnection | undefined> {
    if (!this.pool) return undefined;
    const result = await this.pool.query("SELECT id, tenant_id, kind, secret_ref, secret_value, config_json, status FROM tool_connections WHERE id=$1", [connectionId]);
    const row = result.rows[0];
    if (!row) return undefined;
    const connection = rowToToolConnection(row);
    this.toolConnections.set(connection.id, connection);
    return connection;
  }
}

export function registryDatabaseTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.HATCH_REGISTRY_DB_TIMEOUT_MS?.trim();
  if (!raw) return 5_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new Error("HATCH_REGISTRY_DB_TIMEOUT_MS must be an integer between 100 and 60000");
  }
  return value;
}

export class RegistryPublishTimeoutError extends Error {
  readonly code = "registry_publish_timeout";
  readonly status = 504;

  constructor(timeoutMs: number) {
    super(`Agent Corpus publish exceeded its ${timeoutMs}ms hard deadline`);
    this.name = "RegistryPublishTimeoutError";
  }
}

export function registryPublishTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.HATCH_REGISTRY_PUBLISH_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_REGISTRY_PUBLISH_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 100 || value > 300_000) {
    throw new Error("HATCH_REGISTRY_PUBLISH_TIMEOUT_MS must be an integer between 100 and 300000");
  }
  return value;
}

class PublishDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly expiresAt: number;
  private readonly timer: NodeJS.Timeout;
  private readonly deferredOperations: Promise<void>[] = [];

  constructor(private readonly timeoutMs: number) {
    this.signal = this.controller.signal;
    this.expiresAt = performance.now() + timeoutMs;
    this.timer = setTimeout(() => {
      this.controller.abort(new RegistryPublishTimeoutError(timeoutMs));
    }, timeoutMs);
  }

  remainingMs(): number {
    this.throwIfExpired();
    return Math.max(1, Math.ceil(this.expiresAt - performance.now()));
  }

  throwIfExpired(): void {
    throwIfAborted(this.signal);
    if (performance.now() >= this.expiresAt) {
      const error = new RegistryPublishTimeoutError(this.timeoutMs);
      this.controller.abort(error);
      throw error;
    }
  }

  async wait<T>(operation: Promise<T>): Promise<T> {
    this.throwIfExpired();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => {
          this.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          this.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  defer(operation: Promise<void>): void {
    this.deferredOperations.push(operation);
  }

  deferredCompletion(): Promise<void> | undefined {
    if (this.deferredOperations.length === 0) return undefined;
    return Promise.allSettled(this.deferredOperations).then(() => undefined);
  }
}

function key(creatorId: string, agentId: string): string { return `${creatorId}:${agentId}`; }
function publishedCorpusFromVerified(verified: VerifiedAgentCorpus): PublishedAgentCorpus {
  return {
    creator_id: verified.creator.id,
    agent_id: verified.agentId,
    corpus_digest: verified.digest,
    creator_name: verified.creator.name,
    product_id: verified.product.id,
    product_name: verified.product.name,
    ...(verified.product.description ? { product_description: verified.product.description } : {}),
    ...(verified.product.promise ? { product_promise: verified.product.promise } : {}),
    product_boundaries: verified.product.boundaries,
    presentation: verified.product.presentation,
    knowledge_namespace: `${verified.creator.id}:${verified.agentId}:${verified.digest}`,
    status: "published",
    published_at: new Date().toISOString()
  };
}
function accessListPage(options: AgentAccessListOptions): { limit: number; offset: number } {
  if (options.entitlementId !== undefined) {
    if (!options.entitlementId || options.entitlementId.length > 256) throw new Error("entitlementId is invalid");
    return { limit: 1, offset: 0 };
  }
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 21) throw new Error("agent access limit is invalid");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error("agent access offset is invalid");
  return { limit, offset };
}
async function directoryUsage(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await directoryUsage(absolute);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      bytes += (await stat(absolute)).size;
      files += 1;
    }
    else throw new AgentCorpusVerificationError(`Agent Corpus contains unsupported filesystem entry: ${absolute}`);
  }
  return { bytes, files };
}
function accessBindingKey(userId: string, creatorId: string, agentId: string): string {
  return `${userId}\u0000${creatorId}\u0000${agentId}`;
}
function byPublishedAt(a: PublishedAgentCorpus, b: PublishedAgentCorpus): number { return Date.parse(b.published_at) - Date.parse(a.published_at); }
function rowToCorpus(row: Record<string, any>): PublishedAgentCorpus {
  const product = typeof row.product_json === "string" ? JSON.parse(row.product_json) : row.product_json ?? {};
  assertCanonicalProductIdentity(String(row.agent_id), String(row.product_id));
  return {
    creator_id: String(row.creator_id),
    agent_id: String(row.agent_id),
    corpus_digest: String(row.corpus_digest),
    creator_name: String(row.creator_name),
    product_id: String(row.product_id),
    product_name: String(row.product_name),
    ...(row.product_description ? { product_description: String(row.product_description) } : {}),
    ...(product.promise ? { product_promise: String(product.promise) } : {}),
    product_boundaries: Array.isArray(product.boundaries) ? product.boundaries.map(String) : [],
    presentation: product.presentation && typeof product.presentation === "object" ? product.presentation : {},
    knowledge_namespace: String(row.knowledge_namespace),
    status: "published",
    published_at: new Date(row.published_at).toISOString(),
  };
}
function rowToAccess(row: Record<string, any>): AgentAccessGrant {
  requireUuidV4(String(row.entitlement_id), "entitlement_id");
  requireUuidV4(String(row.user_id), "user_id");
  assertCanonicalProductIdentity(String(row.agent_id), String(row.product_id));
  if (row.order_id) requireUuidV4(String(row.order_id), "order_id");
  return {
    entitlement_id: String(row.entitlement_id),
    user_id: String(row.user_id),
    creator_id: String(row.creator_id),
    agent_id: String(row.agent_id),
    product_id: String(row.product_id),
    access_mode: "unmetered",
    ...(row.order_id ? { order_id: String(row.order_id) } : {}),
    ...(row.purchased_corpus_digest ? { purchased_corpus_digest: String(row.purchased_corpus_digest) } : {}),
    version_policy: row.version_policy === "track_current_compatible" ? "track_current_compatible" : "pinned",
    status: row.status === "active" ? "active" : row.status === "revoked" ? "revoked" : "disabled",
    granted_at: new Date(row.granted_at).toISOString(),
  };
}

function rowToAccessPresentation(row: Record<string, any>): AgentAccessPresentation {
  const product = typeof row.product_json === "string" ? JSON.parse(row.product_json) : row.product_json ?? {};
  requireUuidV4(String(row.entitlement_id), "entitlement_id");
  requireUuidV4(String(row.user_id), "user_id");
  requireUuidV4(String(row.creator_id), "creator_id");
  requireUuidV4(String(row.agent_id), "product_id");
  requireUuidV4(String(row.product_id), "product_id");
  assertCanonicalProductIdentity(String(row.agent_id), String(row.product_id));
  if (row.order_id) requireUuidV4(String(row.order_id), "order_id");
  return {
    entitlement_id: String(row.entitlement_id),
    user_id: String(row.user_id),
    creator_id: String(row.creator_id),
    agent_id: String(row.agent_id),
    product_id: String(row.product_id),
    access_mode: "unmetered",
    ...(row.order_id ? { order_id: String(row.order_id) } : {}),
    ...(row.purchased_corpus_digest ? { purchased_corpus_digest: String(row.purchased_corpus_digest) } : {}),
    version_policy: row.version_policy === "track_current_compatible" ? "track_current_compatible" : "pinned",
    status: "active",
    granted_at: new Date(row.granted_at).toISOString(),
    creator: { id: String(row.creator_id), name: String(row.creator_name) },
    product: {
      id: String(row.product_id),
      name: String(row.product_name),
      description: row.product_description
        ? String(row.product_description)
        : "Work with this Creator Agent in your own files and context.",
    },
    presentation: product.presentation && typeof product.presentation === "object"
      ? product.presentation
      : {},
  };
}

/**
 * UUID cutover collapses the old Agent key into the Product authority. Keep
 * the internal `agent_id` column only as a storage alias, never as a second
 * identity. A mismatch means the persisted state was not migrated and must
 * fail closed instead of creating two resources for one public Product URL.
 */
function assertCanonicalProductIdentity(agentId: unknown, productId: unknown): void {
  if (String(agentId) !== String(productId)) {
    throw new Error("Registry state is not migrated: agent_id must equal product_id");
  }
}

function rowToToolConnection(row: Record<string, any>): CreatorToolConnection {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    kind: row.kind === "mcp" ? "mcp" : "http",
    secret_ref: row.secret_ref === null || row.secret_ref === undefined ? null : String(row.secret_ref),
    secret: row.secret_value === null || row.secret_value === undefined ? null : String(row.secret_value),
    config: typeof row.config_json === "string" ? JSON.parse(row.config_json) : row.config_json,
    status: row.status === "disabled" ? "disabled" : "active"
  };
}

function toolBindingKey(tenantId: string, agentId: string, toolId: string): string {
  return [tenantId, agentId, toolId].join("\u0000");
}

function validateIdentifier(value: string, field: string): void {
  if (!isUuidV4(value) && !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(value)) {
    throw new Error(`${field} must be a valid identifier`);
  }
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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Registry operation was aborted");
}

async function cleanIndexDigestBestEffort(
  indexer: AgentKnowledgeIndexer,
  creatorId: string,
  agentId: string,
  corpusDigest: string,
  markerPath: string,
  deadline: PublishDeadline,
): Promise<void> {
  // Cleanup receives a fresh indexer-level timeout instead of the already
  // aborted publish signal. If the hard publish deadline has elapsed, cleanup
  // continues in the background but cannot delay the caller's timeout result.
  const cleanupSignal = AbortSignal.timeout(5_000);
  const cleanup = waitForAbort(
    removeAgentCorpusKnowledge(indexer, creatorId, agentId, corpusDigest, cleanupSignal),
    cleanupSignal,
  ).then(
    () => rm(markerPath, { force: true }).then(() => undefined),
    () => undefined,
  );
  deadline.defer(cleanup);
  if (deadline.signal.aborted) {
    void cleanup;
    return;
  }
  await deadline.wait(cleanup).catch(() => undefined);
}

async function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function writeDurableJsonFile(filePath: string, value: Record<string, unknown>): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function verifiedDigestAt(
  corpusPath: string,
  creatorId: string,
  agentId: string,
): Promise<string | undefined> {
  if (!(await pathExists(corpusPath))) return undefined;
  return (await verifyAgentCorpus(corpusPath, creatorId, agentId)).digest;
}

export { AgentCorpusVerificationError };
