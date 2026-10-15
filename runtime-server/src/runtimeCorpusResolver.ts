import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readBoundedJsonObject } from "./boundedResponse.js";
import {
  AgentCorpusSchema,
  agentCorpusDigest,
  loadAgentCorpus,
  readCorpusAsset,
  type AgentCorpus,
  type AgentCorpusResolverLike,
  type ResolvedAgentCorpus
} from "./agentCorpus.js";
import { requireUuidV4 } from "./identity.js";
import { runtimeCorpusManifestSchema, type RuntimeCorpusManifest } from "./runtimeReleaseContract.js";
import type { ArtifactObjectStore } from "./creatorLearning/objectStore.js";

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
    status: z.literal("published"),
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
  /** Reads the current published release when it is absent from the local Runtime volume. */
  objectStore?: ArtifactObjectStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Resolves the live Registry pointer and reads the published Corpus from the
 * shared Runtime volume. When a local release is absent, it reads only that
 * release's immutable assets from the configured Object Store.
 *
 * Publish owns the expensive work: OSS -> shared disk, OSS -> Qdrant, then
 * Postgres live pointer. Runtime reads the live pointer from Registry and
 * fetches missing immutable files from OSS without scanning the bucket.
 */
export class RuntimeReleaseAgentCorpusResolver implements AgentCorpusResolverLike {
  private readonly fetchImpl: typeof fetch;
  private readonly registryUrl: string;
  private readonly serviceToken: string;
  private readonly corpusRoot: string;
  private readonly objectStore?: ArtifactObjectStore;
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
    this.objectStore = options.objectStore;
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
    // Historical access grants may still supply their purchase-time digest.
    // It is bookkeeping, not a second release selector: Registry owns the
    // current Product definition for HTTP, hello, and turn authorization alike.
    const signal = typeof digestOrSignal === "string" ? explicitSignal : digestOrSignal;
    signal?.throwIfAborted();

    const response = await this.readLiveRelease(agentId, signal);
    const release = response.release;
    if (response.runtime_manifest_ref !== `${release.release_ref}/runtime/manifest.json`) {
      throw new Error("Registry runtime manifest reference is not canonical");
    }
    if (release.product_id !== agentId || release.creator_id !== creatorId) {
      throw new Error("Registry release binding does not match the requested Expert Agent");
    }

    const releaseDirectory = releaseDirectoryName(release.release_digest);
    const root = containedCorpusPath(this.corpusRoot, agentId, releaseDirectory);
    if (this.objectStore && !(await fileExists(path.join(root, "runtime/manifest.json")))) {
      await materializePublishedRuntimeRelease({
        objectStore: this.objectStore,
        root,
        releaseRef: release.release_ref,
        manifestRef: response.runtime_manifest_ref,
        creatorId,
        productId: agentId,
        corpusDigest: release.corpus_digest
      });
    }
    let corpus: AgentCorpus;
    try {
      const manifestBytes = await readFile(path.join(root, "runtime", "manifest.json"), signal ? { signal } : undefined);
      if (manifestBytes.byteLength > 1_048_576) throw new Error("Runtime Corpus manifest is too large");
      const manifest = runtimeCorpusManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
      if (manifest.creator.id !== creatorId || manifest.product.id !== agentId || manifest.corpus_digest !== release.corpus_digest) {
        throw new Error("Runtime manifest binding does not match the Registry release");
      }
      const runtimeManifestCorpus = runtimeManifestToAgentCorpus(manifest);
      await verifyRuntimeManifestAssets(root, runtimeManifestCorpus, signal);
      // The runtime manifest describes the installed assets, but agent.json is
      // the execution contract consumed by materializeAgentCorpus. Keep one
      // canonical corpus object across hello, turn revalidation, tool setup,
      // and prompt materialization; otherwise the manifest's `runtime/...`
      // paths and agent.json's root-relative paths produce different digests.
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

function runtimeManifestToAgentCorpus(manifest: RuntimeCorpusManifest): AgentCorpus {
  const rootPath = (value: string): string => {
    if (!value.startsWith("runtime/")) throw new Error(`Runtime asset path is invalid: ${value}`);
    return value.slice("runtime/".length);
  };
  return AgentCorpusSchema.parse({
    contract_version: "1",
    creator: { id: manifest.creator.id, name: "Expert" },
    product: {
      id: manifest.product.id,
      name: manifest.product.name,
      promise: manifest.product.promise,
      boundaries: [],
      brief_spec: manifest.brief_spec,
      presentation: {}
    },
    instructions: {
      system: {
        id: "system",
        path: rootPath(manifest.system_ref.path),
        sha256: manifest.system_ref.sha256,
        description: "Expert system instructions"
      }
    },
    skills: manifest.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      when_to_use: skill.description,
      instruction: {
        id: `skill-${skill.id}`,
        path: rootPath(skill.ref.path),
        sha256: skill.ref.sha256,
        description: skill.description
      },
      references: skill.references.map((reference) => ({
        kind: reference.kind,
        asset: {
          id: `ref-${skill.id}-${reference.id}`,
          path: rootPath(reference.ref.path),
          sha256: reference.ref.sha256,
          description: `${skill.name} reference`
        }
      })),
      allowed_tool_ids: []
    })),
    knowledge: {
      documents: manifest.knowledge.map((document) => ({
        id: document.id,
        path: rootPath(document.ref.path),
        sha256: document.ref.sha256,
        retrieval_only: true,
        title: document.title
      }))
    },
    tools: [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
      ...(manifest.knowledge.length > 0 ? [{ id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" }] : []),
      ...manifest.tools
    ],
    evaluations: { synthetic_qa: [], held_out: [] }
  });
}

async function verifyRuntimeManifestAssets(root: string, corpus: AgentCorpus, signal?: AbortSignal): Promise<void> {
  const assets = [
    corpus.instructions.system,
    ...corpus.skills.flatMap((skill) => [skill.instruction, ...skill.references.map((reference) => reference.asset)]),
    ...corpus.knowledge.documents
  ];
  for (const asset of assets) {
    signal?.throwIfAborted();
    await readCorpusAsset(root, asset, signal);
  }
}

async function materializePublishedRuntimeRelease(input: {
  objectStore: ArtifactObjectStore;
  root: string;
  releaseRef: string;
  manifestRef: string;
  creatorId: string;
  productId: string;
  corpusDigest: string;
}): Promise<void> {
  const expectedReleaseRef = `registry/${input.productId}/releases/${path.basename(input.root)}`;
  if (input.releaseRef !== expectedReleaseRef || input.manifestRef !== `${expectedReleaseRef}/runtime/manifest.json`) {
    throw new Error("Registry release references are not canonical");
  }
  await mkdir(input.root, { recursive: true });
  const manifestBytes = await input.objectStore.get(input.manifestRef);
  if (manifestBytes.byteLength > 1_048_576) throw new Error("Runtime Corpus manifest is too large");
  const manifest = runtimeCorpusManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.creator.id !== input.creatorId || manifest.product.id !== input.productId || manifest.corpus_digest !== input.corpusDigest) {
    throw new Error("Runtime manifest binding does not match the Registry release");
  }
  const corpus = runtimeManifestToAgentCorpus(manifest);
  const assets = [
    manifest.system_ref,
    ...manifest.skills.flatMap((skill) => [skill.ref, ...skill.references.map((reference) => reference.ref)]),
    ...manifest.knowledge.map((document) => document.ref)
  ];
  for (const asset of assets) {
    const relativeRuntimePath = safeRuntimeAssetPath(asset.path);
    const bytes = await input.objectStore.get(`${input.releaseRef}/${relativeRuntimePath}`);
    const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actualDigest !== asset.sha256) throw new Error(`Published Runtime asset digest mismatch: ${relativeRuntimePath}`);
    await writeImmutableLocalFile(input.root, relativeRuntimePath.slice("runtime/".length), bytes);
    await writeImmutableLocalFile(input.root, relativeRuntimePath, bytes);
  }
  const agentManifest = Object.fromEntries(Object.entries(corpus).filter(([key]) => key !== "agent_id"));
  await writeImmutableLocalFile(input.root, "agent.json", Buffer.from(JSON.stringify(agentManifest, null, 2), "utf8"));
  await writeImmutableLocalFile(input.root, "runtime/manifest.json", manifestBytes);
}

async function writeImmutableLocalFile(root: string, relativePath: string, bytes: Buffer): Promise<void> {
  const destination = path.resolve(root, relativePath);
  if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Runtime asset path escapes its release directory");
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(destination, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(destination);
    if (!existing.equals(bytes)) throw new Error(`Runtime release already contains different bytes: ${relativePath}`);
  }
}

function safeRuntimeAssetPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized.startsWith("runtime/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Runtime asset path is invalid: ${value}`);
  }
  return normalized;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
