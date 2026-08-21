import path from "node:path";
import { z } from "zod";
import { readBoundedJsonObject } from "./boundedResponse.js";
import {
  agentCorpusDigest,
  loadAgentCorpus,
  type AgentCorpusResolverLike,
  type ResolvedAgentCorpus
} from "./agentCorpus.js";
import { requireUuidV4 } from "./identity.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const runtimeReleaseResponseSchema = z.object({
  release: z.object({
    product_id: z.string().min(1),
    creator_id: z.string().min(1),
    release_digest: digestSchema,
    corpus_digest: digestSchema,
    corpus_ref: z.string().min(1),
    release_ref: z.string().min(1),
    brief_spec: z.unknown(),
    status: z.literal("live"),
    published_at: z.string().datetime()
  }).strict(),
  runtime_manifest_ref: z.string().min(1)
}).strict();

export type RuntimeReleaseResponse = z.infer<typeof runtimeReleaseResponseSchema>;

export type RuntimeReleaseAgentCorpusResolverOptions = {
  registryUrl: string;
  serviceToken: string;
  /** Shared, publish-time materialized Runtime Corpus directory. */
  corpusRoot: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Resolves the live Registry pointer and reads the already-published Corpus
 * from the shared Runtime volume.
 *
 * Publish owns the expensive work: OSS -> shared disk, OSS -> Qdrant, then
 * Postgres live pointer. Runtime never downloads Corpus assets or creates a
 * Knowledge index while serving a request.
 */
export class RuntimeReleaseAgentCorpusResolver implements AgentCorpusResolverLike {
  private readonly fetchImpl: typeof fetch;
  private readonly registryUrl: string;
  private readonly serviceToken: string;
  private readonly corpusRoot: string;
  private readonly timeoutMs: number;

  constructor(options: RuntimeReleaseAgentCorpusResolverOptions) {
    const registryUrl = options.registryUrl.trim().replace(/\/$/, "");
    if (!registryUrl) throw new Error("Runtime Registry URL is required");
    const serviceToken = options.serviceToken.trim();
    if (!serviceToken) throw new Error("Runtime Registry service token is required");
    if (!options.corpusRoot.trim()) throw new Error("Runtime Corpus root is required");
    this.registryUrl = registryUrl;
    this.serviceToken = serviceToken;
    this.corpusRoot = path.resolve(options.corpusRoot);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = positiveTimeout(options.timeoutMs ?? 30_000);
  }

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
    if (selectedDigest !== undefined && !digestSchema.safeParse(selectedDigest).success) {
      throw new Error("pinned corpus digest is invalid");
    }

    const response = await this.readLiveRelease(agentId, signal);
    const release = response.release;
    if (release.product_id !== agentId || release.creator_id !== creatorId) {
      throw new Error("Registry release binding does not match the requested Creator Agent");
    }
    if (selectedDigest !== undefined && release.corpus_digest !== selectedDigest) {
      throw new Error("The requested pinned Corpus release is not the live Registry release");
    }

    const releaseDirectory = releaseDirectoryName(release.release_digest);
    const root = containedCorpusPath(this.corpusRoot, agentId, releaseDirectory);
    let corpus;
    try {
      corpus = await loadAgentCorpus(root, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Published Runtime Corpus is not materialized: ${agentId}/${releaseDirectory}`);
      }
      throw error;
    }
    if (corpus.creator.id !== creatorId || corpus.agent_id !== agentId || corpus.product.id !== agentId) {
      throw new Error("Published Runtime Corpus binding does not match the Registry release");
    }
    const digest = await agentCorpusDigest(root, corpus, signal);
    // Registry's corpus_digest is the source Node output digest. The installed
    // Runtime representation has its own verified digest; keep both explicit.
    signal?.throwIfAborted();
    return { root, corpus, digest: release.corpus_digest, runtimeDigest: digest };
  }

  /** Runtime has no catalog authority; Registry owns Product listing. */
  async list(_creatorId: string, signal?: AbortSignal): Promise<ResolvedAgentCorpus[]> {
    signal?.throwIfAborted();
    return [];
  }

  private async readLiveRelease(productId: string, signal?: AbortSignal): Promise<RuntimeReleaseResponse> {
    const response = await this.fetchImpl(
      `${this.registryUrl}/v1/runtime/products/${encodeURIComponent(productId)}/release`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.serviceToken}`
        },
        signal: boundedSignal(signal, this.timeoutMs)
      }
    );
    const payload = await readBoundedJsonObject(response);
    if (!response.ok) {
      const detail = typeof payload.detail === "string" ? payload.detail : `HTTP ${response.status}`;
      throw new Error(`Registry runtime release lookup failed: ${detail}`);
    }
    const parsed = runtimeReleaseResponseSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Registry runtime release response is invalid: ${parsed.error.message}`);
    return parsed.data;
  }
}

function containedCorpusPath(root: string, productId: string, releaseDirectory: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, productId, releaseDirectory);
  if (!resolved.startsWith(`${base}${path.sep}`)) throw new Error("Runtime Corpus path escapes its root");
  return resolved;
}

function releaseDirectoryName(releaseDigest: string): string {
  if (!digestSchema.safeParse(releaseDigest).success) throw new Error("Registry release digest is invalid");
  return releaseDigest.slice("sha256:".length);
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 120_000) {
    throw new Error("Runtime Registry timeout must be an integer between 100 and 120000");
  }
  return value;
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
