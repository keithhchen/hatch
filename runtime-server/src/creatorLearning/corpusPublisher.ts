import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { zipSync } from "fflate";
import type { ArtifactObjectStore } from "./objectStore.js";
import type { FactoryNodeService } from "./nodeService.js";
import { corpusInputSchema, corpusOutputSchema, type CorpusInput, type CorpusOutput } from "./corpusNode.js";
import type { RegistryStoreTs, PublishedAgentCorpus } from "../registryStore.js";
import { AgentCorpusVerificationError, extractAgentCorpusBundle, immutableReleasePath } from "../registryCorpus.js";
import { CreatorRegistryReleaseStore, type CreatorRegistryRelease } from "./creatorRegistryRelease.js";
import type { AgentKnowledgeIndexer, KnowledgeDocument } from "../qdrantIndexer.js";

export class CorpusPublishError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 503, options?: ErrorOptions) {
    super(message, options);
    this.name = "CorpusPublishError";
    this.code = code;
    this.status = status;
  }
}

export type PublishResult = {
  execution_id: string;
  output_ref: string;
  corpus_digest: string;
  published: PublishedAgentCorpus;
  release: CreatorRegistryRelease;
};

/** The only bridge from the new Node output contract into Registry. */
export class CorpusPublisher {
  constructor(
    private readonly nodes: FactoryNodeService,
    private readonly objectStore: ArtifactObjectStore,
    private readonly registry: RegistryStoreTs,
    private readonly releases: CreatorRegistryReleaseStore,
    private readonly runtimeRoot: string,
    private readonly knowledgeIndexer?: AgentKnowledgeIndexer,
  ) {}

  async publishLatest(input: {
    creatorId: string;
    productId: string;
    productName: string;
    productPromise: string;
    briefSpec?: unknown;
    force?: boolean;
  }): Promise<PublishResult> {
    let outerStage = "latest_completed_corpus";
    try {
    const execution = await this.nodes.getLatestCompletedExecution(input.productId, "corpus");
    if (!execution?.outputRef) throw new Error("No completed Corpus Node execution is available");
    const expected = `${input.productId}/corpus/${execution.executionId}/output.json`;
    if (execution.outputRef !== expected) throw new Error("Corpus output_ref is not canonical");
    outerStage = "oss_corpus_output";
    const bytes = await this.objectStore.get(execution.outputRef);
    outerStage = "parse_corpus_output";
    const corpus = parseCorpusOutput(bytes);
    outerStage = "read_corpus_input";
    const corpusInput = await readCorpusInput(this.objectStore, execution.inputRef);
    validateKnowledgeSelection(corpus, corpusInput);
    const sourceDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    // A lost HTTP response must not repeat materialization or indexing. The
    // live release is the durable idempotency receipt for this semantic
    // publish request; the request header is only transport metadata.
    outerStage = "postgres_live_pointer_read";
    const live = await this.releases.getLive(input.productId);
    if (!input.force &&
      live
      && live.creator_id === input.creatorId
      && live.corpus_digest === sourceDigest
      && JSON.stringify(live.brief_spec ?? null) === JSON.stringify(input.briefSpec ?? null)
    ) {
      const published = await this.registry.getAgentCorpusRelease(input.creatorId, input.productId, live.release_digest);
      if (published) {
        return { execution_id: execution.executionId, output_ref: execution.outputRef, corpus_digest: sourceDigest, published, release: live };
      }
    }
    outerStage = "runtime_bundle_generation";
    const bundle = await makeRuntimeBundle({
      objectStore: this.objectStore,
      creatorId: input.creatorId,
      productId: input.productId,
      productName: input.productName,
      productPromise: input.productPromise,
      corpus,
      briefSpec: input.briefSpec,
    });
    const staging = path.resolve(this.runtimeRoot, `.corpus-publish-${randomUUID()}`);
    outerStage = "runtime_bundle_extraction";
    await extractAgentCorpusBundle(bundle, staging);
    let staged: PublishedAgentCorpus;
    try {
      staged = await this.registry.stageAgentCorpusDirectory(
        input.creatorId,
        input.productId,
        staging,
        undefined,
        input.briefSpec as never,
        { indexKnowledge: false },
      );
    } catch (error) {
      if (error instanceof AgentCorpusVerificationError) {
        throw new CorpusPublishError(
          "corpus_bundle_invalid",
          `Generated Runtime Corpus failed Registry validation: ${error.message}`,
          422,
          { cause: error },
        );
      }
      throw new CorpusPublishError("runtime_storage_unavailable", "Registry could not write the Runtime Corpus to shared storage.", 503, { cause: error });
    }
    let publishStage = "runtime_shared_storage";
    try {
    const immutableRoot = immutableReleasePath(this.runtimeRoot, input.creatorId, input.productId, staged.corpus_digest);
    const releaseRoot = path.resolve(this.runtimeRoot, input.productId, staged.corpus_digest.slice("sha256:".length));
    await mkdir(path.dirname(releaseRoot), { recursive: true });
    await cp(immutableRoot, releaseRoot, { recursive: true, force: false, errorOnExist: false });
    publishStage = "runtime_release_assets";
    await writeRuntimeReleaseAssets({
      objectStore: this.objectStore,
      releaseRoot,
      productId: input.productId,
      productName: input.productName,
      productPromise: input.productPromise,
      creatorId: input.creatorId,
      corpus,
      sourceDigest,
      releaseDigest: staged.corpus_digest,
      briefSpec: input.briefSpec,
    });
    await writeFile(path.join(releaseRoot, "source-corpus.json"), bytes, { flag: "wx" }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(path.join(releaseRoot, "source-corpus.json"));
      if (!existing.equals(bytes)) throw new Error("Runtime release already contains different Corpus bytes");
    });
    if (corpus.knowledge.length > 0) {
      publishStage = "qdrant_knowledge_index";
      if (!this.knowledgeIndexer) {
        throw new CorpusPublishError(
          "knowledge_index_unavailable",
          "Knowledge indexing is not configured for this Registry.",
          503,
        );
      }
      try {
        await this.knowledgeIndexer.stageAgentDocuments(
          input.creatorId,
          input.productId,
          sourceDigest,
          releaseRoot,
          await Promise.all(corpus.knowledge.map(async (document): Promise<KnowledgeDocument> => {
            const id = knowledgeId(document.source);
            const relativePath = `knowledge/${id}.md`;
            const raw = await readFile(path.join(releaseRoot, relativePath));
            return {
              id,
              title: document.title,
              path: relativePath,
              sha256: digestBytes(raw),
              retrieval_only: true,
            };
          })),
        );
      } catch (error) {
        throw new CorpusPublishError(
          "knowledge_index_unavailable",
          "Knowledge indexing failed. Check Qdrant and DashScope embedding availability, credentials, and quota.",
          503,
          { cause: error },
        );
      }
    }
    const releaseDigest = staged.corpus_digest;
    const releaseRef = `registry/${input.productId}/releases/${releaseDigest.slice("sha256:".length)}`;
    const releaseCorpusRef = `${releaseRef}/corpus.json`;
    publishStage = "oss_release_assets";
    await this.objectStore.put(releaseCorpusRef, bytes, { immutable: true, contentType: "application/json" });
    const publishedAt = new Date().toISOString();
    const releaseInput = {
      product_id: input.productId,
      creator_id: input.creatorId,
      release_digest: releaseDigest,
      corpus_digest: sourceDigest,
      corpus_ref: releaseCorpusRef,
      release_ref: releaseRef,
      runtime_manifest_ref: `${releaseRef}/runtime/manifest.json`,
      brief_spec: input.briefSpec ?? null,
      published_at: publishedAt,
    } as const;
    const releaseBytes = Buffer.from(JSON.stringify({ ...releaseInput, status: "published" }, null, 2), "utf8");
    await putImmutableReleaseAsset(this.objectStore, `${releaseRef}/release.json`, releaseBytes);
    publishStage = "postgres_release_pointer";
    const release = await this.releases.publish(releaseInput);
    await rm(staging, { recursive: true, force: true });
    return { execution_id: execution.executionId, output_ref: execution.outputRef, corpus_digest: sourceDigest, published: staged, release };
    } catch (error) {
      if (error instanceof CorpusPublishError) throw error;
      throw new CorpusPublishError(
        "publish_stage_failed",
        `Registry publish failed during ${publishStage}: ${error instanceof Error ? error.message : String(error)}`,
        422,
        { cause: error instanceof Error ? error : undefined },
      );
    }
    } catch (error) {
      if (error instanceof CorpusPublishError) throw error;
      throw new CorpusPublishError(
        "publish_stage_failed",
        `Registry publish failed during ${outerStage}: ${error instanceof Error ? error.message : String(error)}`,
        422,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }
}

async function writeRuntimeReleaseAssets(input: {
  objectStore: ArtifactObjectStore; releaseRoot: string; creatorId: string; productId: string;
  productName: string; productPromise: string; corpus: CorpusOutput; sourceDigest: string;
  releaseDigest: string; briefSpec?: unknown;
}): Promise<void> {
  const runtimeRoot = path.join(input.releaseRoot, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const copyAndDescribe = async (source: string, target: string) => {
    const bytes = await readFile(path.join(input.releaseRoot, source));
    const targetPath = path.join(runtimeRoot, target);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, bytes, { flag: "wx" }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(targetPath);
      if (!existing.equals(bytes)) throw new Error(`Runtime asset collision: ${target}`);
    });
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await input.objectStore.put(`registry/${input.productId}/releases/${input.releaseDigest.slice("sha256:".length)}/runtime/${target}`, bytes, { immutable: true });
    return { path: `runtime/${target}`, sha256 };
  };
  const system = await copyAndDescribe("instructions/system.md", "instructions/system.md");
  const skills = await Promise.all(input.corpus.skills.map(async (skill) => {
    const id = safeId(skill.id);
    const instruction = await copyAndDescribe(`skills/${id}/SKILL.md`, `skills/${id}/SKILL.md`);
    const references = await Promise.all(skill.references.map(async (reference) => ({
      id: safeId(reference.id), kind: reference.kind,
      ref: await copyAndDescribe(`skills/${id}/references/${safeId(reference.id)}.md`, `skills/${id}/references/${safeId(reference.id)}.md`)
    })));
    return { id, name: id, description: skill.when_to_use, ref: instruction, references };
  }));
  const knowledge = await Promise.all(input.corpus.knowledge.map(async (doc) => {
    const id = knowledgeId(doc.source);
    return { id, title: doc.title, ref: await copyAndDescribe(`knowledge/${id}.md`, `knowledge/${id}.md`) };
  }));
  const manifest = {
    contract_version: "1", creator: { id: input.creatorId },
    product: { id: input.productId, name: input.productName, promise: input.productPromise },
    corpus_digest: input.sourceDigest, system_ref: system, skills, knowledge,
    brief_spec: input.briefSpec ?? null
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(path.join(runtimeRoot, "manifest.json"), manifestBytes, { flag: "wx" }).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path.join(runtimeRoot, "manifest.json"));
    if (!existing.equals(manifestBytes)) throw new Error("Runtime manifest collision");
  });
  await input.objectStore.put(`registry/${input.productId}/releases/${input.releaseDigest.slice("sha256:".length)}/runtime/manifest.json`, manifestBytes, { immutable: true });
}

function parseCorpusOutput(bytes: Buffer): CorpusOutput {
  try {
    return corpusOutputSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new Error(`Corpus output does not match the Corpus Node contract: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function makeRuntimeBundle(input: {
  objectStore: ArtifactObjectStore;
  creatorId: string; productId: string; productName: string; productPromise: string;
  corpus: CorpusOutput; briefSpec?: unknown;
}): Promise<Buffer> {
  const files: Record<string, Uint8Array> = {};
  const put = (name: string, content: string | Uint8Array): void => { files[name] = Buffer.from(content); };
  const assets: Record<string, { id: string; path: string; sha256: string; description?: string }> = {};
  const addAsset = (id: string, filePath: string, content: string | Uint8Array, description?: string): void => {
    put(filePath, content); assets[id] = { id, path: filePath, sha256: digestBytes(Buffer.from(content)), ...(description ? { description } : {}) };
  };
  addAsset("system", "instructions/system.md", input.corpus.system_instructions, "Corpus system instructions");
  const skills = input.corpus.skills.map((skill) => {
    const id = safeId(skill.id);
    const skillPath = `skills/${id}/SKILL.md`;
    const skillMarkdown = `---\nname: ${id}\ndescription: ${yaml(skill.when_to_use)}\n---\n\n${skill.instruction.trim()}\n`;
    const instructionId = `skill-${id}`;
    addAsset(instructionId, skillPath, skillMarkdown, skill.title);
    const references = skill.references.map((ref) => {
      const refId = safeId(ref.id);
      const refPath = `skills/${id}/references/${refId}.md`;
      const assetId = `ref-${id}-${refId}`;
      addAsset(assetId, refPath, ref.content);
      return { kind: ref.kind, asset: assets[assetId]! };
    });
    return { id, name: id, when_to_use: skill.when_to_use, instruction: assets[instructionId]!, references, allowed_tool_ids: [] };
  });
  const knowledge: Array<Record<string, unknown>> = [];
  for (const doc of input.corpus.knowledge) {
    const id = knowledgeId(doc.source);
    const assetId = `knowledge-${id}`;
    const sourceBytes = await input.objectStore.get(doc.source);
    addAsset(assetId, `knowledge/${id}.md`, sourceBytes, doc.title);
    knowledge.push({ id, path: assets[assetId]!.path, sha256: assets[assetId]!.sha256, retrieval_only: true, title: doc.title });
  }
  const manifest = {
    contract_version: "1",
    creator: { id: input.creatorId, name: "Creator" },
    product: { id: input.productId, name: input.productName, promise: input.productPromise, boundaries: [], ...(input.briefSpec !== undefined ? { brief_spec: input.briefSpec } : {}), presentation: {} },
    instructions: { system: assets.system! },
    skills,
    knowledge: { documents: knowledge },
    tools: [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
      ...(knowledge.length ? [{ id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" }] : [])
    ],
    evaluations: { synthetic_qa: [], held_out: [] }
  };
  put("agent.json", JSON.stringify(manifest, null, 2));
  return Buffer.from(zipSync(files));
}

async function readCorpusInput(objectStore: ArtifactObjectStore, reference: string | undefined): Promise<CorpusInput> {
  if (!reference) throw new Error("Completed Corpus execution has no input_ref");
  try {
    return corpusInputSchema.parse(JSON.parse((await objectStore.get(reference)).toString("utf8")));
  } catch (error) {
    throw new Error(`Corpus input is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateKnowledgeSelection(corpus: CorpusOutput, input: CorpusInput): void {
  const declared = new Set(input.files);
  const selected = new Set<string>();
  for (const document of corpus.knowledge) {
    if (!declared.has(document.source)) {
      throw new Error(`Corpus Knowledge source is not declared in input.files: ${document.source}`);
    }
    if (selected.has(document.source)) {
      throw new Error(`Corpus Knowledge source is selected more than once: ${document.source}`);
    }
    selected.add(document.source);
  }
}

function knowledgeId(source: string): string {
  const match = source.match(/\/files\/(file_[A-Za-z0-9_-]+)\/projection\.md$/);
  if (!match?.[1]) throw new Error(`Corpus Knowledge source is not a Product File projection: ${source}`);
  return safeId(match[1]);
}

function digestBytes(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function safeId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Corpus asset id is empty");
  return id;
}

function yaml(value: string): string { return JSON.stringify(value); }

async function putImmutableReleaseAsset(
  objectStore: ArtifactObjectStore,
  key: string,
  bytes: Buffer,
): Promise<void> {
  try {
    await objectStore.put(key, bytes, { immutable: true, contentType: "application/json" });
    return;
  } catch (error) {
    // A retry of the same content-addressed release may have a new request
    // timestamp. Reuse the existing immutable asset when its release identity
    // is otherwise identical; never overwrite a different release.
    const existing = await objectStore.get(key);
    const normalize = (value: Buffer): string => {
      const parsed = JSON.parse(value.toString("utf8")) as Record<string, unknown>;
      delete parsed.published_at;
      return stableJson(parsed);
    };
    if (normalize(existing) === normalize(bytes)) return;
    throw error;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
