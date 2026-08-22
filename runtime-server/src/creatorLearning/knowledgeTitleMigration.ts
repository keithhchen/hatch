import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  AgentCorpusSchema,
  loadAgentCorpus,
  type AgentCorpus,
} from "../agentCorpus.js";
import { requireUuidV4 } from "../identity.js";
import { runtimeCorpusManifestSchema, type RuntimeCorpusManifest } from "../runtimeReleaseContract.js";
import {
  CreatorRegistryReleaseStore,
  type CreatorRegistryRelease,
  type ReleaseInput,
} from "./creatorRegistryRelease.js";
import type { ArtifactObjectStore } from "./objectStore.js";
import type { AgentKnowledgeIndexer, KnowledgeDocument } from "../qdrantIndexer.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * This is the only runtime reader that knows the removed field. It exists at
 * the one-time historical migration boundary; the produced release is
 * validated exclusively by the current title-only Runtime schema below.
 */
const historicalRuntimeManifestSchema = z.object({
  contract_version: z.literal("1"),
  creator: z.object({ id: z.string().min(1) }).strict(),
  product: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    promise: z.string().min(1)
  }).strict(),
  corpus_digest: z.string().regex(DIGEST),
  system_ref: z.object({
    path: z.string().min(1),
    sha256: z.string().regex(DIGEST)
  }).strict(),
  skills: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    ref: z.object({
      path: z.string().min(1),
      sha256: z.string().regex(DIGEST)
    }).strict(),
    references: z.array(z.object({
      id: z.string().min(1),
      kind: z.enum(["method", "style", "example", "few_shots"]),
      ref: z.object({
        path: z.string().min(1),
        sha256: z.string().regex(DIGEST)
      }).strict()
    }).strict())
  }).strict()),
  knowledge: z.array(z.union([
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      ref: z.object({
        path: z.string().min(1),
        sha256: z.string().regex(DIGEST)
      }).strict()
    }).strict(),
    // Historical input only. Never emit this shape.
    z.object({
      id: z.string().min(1),
      source_summary: z.string().min(1).max(4_096),
      ref: z.object({
        path: z.string().min(1),
        sha256: z.string().regex(DIGEST)
      }).strict()
    }).strict()
  ])),
  tools: z.array(z.record(z.string(), z.unknown())).default([]),
  brief_spec: z.unknown()
}).strict();

export type KnowledgeTitleMigrationInput = {
  objectStore: ArtifactObjectStore;
  releaseStore: CreatorRegistryReleaseStore;
  /** Shared Runtime volume containing <product>/<release>/agent.json. */
  runtimeCorpusRoot: string;
  /** Read and validate every live release without writing a new release. */
  verifyOnly?: boolean;
  /** Optional Qdrant writer used to replace historical source_summary payloads. */
  knowledgeIndexer?: AgentKnowledgeIndexer;
  signal?: AbortSignal;
};

export type KnowledgeTitleMigrationReleaseInput = Omit<KnowledgeTitleMigrationInput, "verifyOnly"> & {
  release: CreatorRegistryRelease;
  verifyOnly?: boolean;
};

export type KnowledgeTitleMigrationResult = {
  product_id: string;
  creator_id: string;
  status: "migrated" | "already_current";
  migrated_documents: number;
  previous_release: CreatorRegistryRelease;
  release?: CreatorRegistryRelease;
};

export type KnowledgeTitleMigrationReport = {
  scanned: number;
  migrated: number;
  unchanged: number;
  verified: number;
};

/**
 * Migrates every live release (or one selected Product) to the title-only
 * Knowledge representation. Re-running this function is safe: a migrated
 * live release is observed as already current, and every object write is
 * immutable/content-addressed.
 */
export async function migrateKnowledgeTitles(
  input: KnowledgeTitleMigrationInput,
): Promise<KnowledgeTitleMigrationReport> {
  const releases = await input.releaseStore.listLive();
  let migrated = 0;
  let unchanged = 0;
  for (const release of releases) {
    throwIfAborted(input.signal);
    const result = await migrateKnowledgeTitleRelease({ ...input, release });
    if (result.status === "migrated") migrated += 1;
    else unchanged += 1;
  }
  return {
    scanned: releases.length,
    migrated,
    unchanged,
    verified: releases.length,
  };
}

/**
 * Migrates one live release. The old release is never edited. The new local
 * directory and OSS prefix are fully materialized and validated before the
 * final release-store call, which is the only operation that changes the live
 * pointer.
 */
export async function migrateKnowledgeTitleRelease(
  input: KnowledgeTitleMigrationReleaseInput,
): Promise<KnowledgeTitleMigrationResult> {
  throwIfAborted(input.signal);
  const release = validateRelease(input.release);
  const runtimeRootValue = input.runtimeCorpusRoot.trim();
  if (!runtimeRootValue) throw new Error("Runtime Corpus root is required");
  const runtimeRoot = path.resolve(runtimeRootValue);

  const oldRoot = localReleasePath(runtimeRoot, release.product_id, release.release_digest);
  const oldAgentPath = path.join(oldRoot, "agent.json");
  const oldRuntimeManifestPath = path.join(oldRoot, "runtime", "manifest.json");
  const oldRuntimeBytes = await readBoundedFile(oldRuntimeManifestPath, "old Runtime manifest");
  const remoteRuntimeBytes = await input.objectStore.get(release.runtime_manifest_ref);
  if (!remoteRuntimeBytes.equals(oldRuntimeBytes)) {
    throw new Error("Shared Runtime manifest differs from the live OSS release");
  }

  const oldRuntimeRaw = parseJson(oldRuntimeBytes, "old Runtime manifest");
  const normalizedRuntime = normalizeRuntimeManifest(oldRuntimeRaw);
  const oldAgentRaw = parseJson(await readBoundedFile(oldAgentPath, "old Agent Corpus manifest"), "old Agent Corpus manifest");
  const normalizedAgent = normalizeAgentManifest(oldAgentRaw);
  const changed = normalizedRuntime.changed || normalizedAgent.changed;

  if (!changed) {
    // A current release is still checked at the read boundary so the
    // migration cannot silently report success for a broken live release.
    await validateCurrentRelease(oldRoot, normalizedRuntime.manifest, normalizedAgent.manifest);
    return {
      product_id: release.product_id,
      creator_id: release.creator_id,
      status: "already_current",
      migrated_documents: 0,
      previous_release: release,
    };
  }

  if (input.verifyOnly) {
    throw new Error(`Live release still contains historical Knowledge source_summary: ${release.product_id}`);
  }

  assertKnowledgeAlignment(normalizedRuntime.manifest, normalizedAgent.corpus);
  const agentBytes = encodeJson(normalizedAgent.manifest);
  const runtimeBytes = encodeJson(normalizedRuntime.manifest);
  // Validate the exact bytes that will be published, not merely an in-memory
  // object. AgentCorpusSchema is intentionally the current title-only schema.
  AgentCorpusSchema.parse(JSON.parse(agentBytes.toString("utf8")));
  runtimeCorpusManifestSchema.parse(JSON.parse(runtimeBytes.toString("utf8")));

  const newReleaseDigest = migrationReleaseDigest(release, agentBytes, runtimeBytes);
  if (newReleaseDigest === release.release_digest) {
    throw new Error("Knowledge title migration produced the existing release digest");
  }
  const newReleaseRef = releaseRefForDigest(release.release_ref, release.release_digest, newReleaseDigest, release.product_id);
  const newRuntimeManifestRef = `${newReleaseRef}/runtime/manifest.json`;
  const newCorpusRef = `${newReleaseRef}/corpus.json`;
  const newReleaseInput: ReleaseInput = {
    product_id: release.product_id,
    creator_id: release.creator_id,
    release_digest: newReleaseDigest,
    corpus_digest: release.corpus_digest,
    corpus_ref: newCorpusRef,
    release_ref: newReleaseRef,
    runtime_manifest_ref: newRuntimeManifestRef,
    brief_spec: release.brief_spec ?? null,
    published_at: release.published_at,
  };
  const newReleaseBytes = encodeJson({ ...newReleaseInput, status: "published" });
  const newRoot = localReleasePath(runtimeRoot, release.product_id, newReleaseDigest);
  const stagingRoot = path.join(
    path.dirname(newRoot),
    `.knowledge-title-migration-${newReleaseDigest.slice("sha256:".length)}-${randomUUID()}`,
  );

  let stagingOwned = false;
  try {
    throwIfAborted(input.signal);
    await mkdir(path.dirname(newRoot), { recursive: true });
    await cp(oldRoot, stagingRoot, { recursive: true, force: false, errorOnExist: true });
    stagingOwned = true;
    await writeFile(path.join(stagingRoot, "agent.json"), agentBytes);
    await writeFile(path.join(stagingRoot, "runtime", "manifest.json"), runtimeBytes);
    await validateCurrentRelease(stagingRoot, normalizedRuntime.manifest, normalizedAgent.manifest);
    await assertKnowledgeBytesUnchanged(oldRoot, stagingRoot, normalizedRuntime.manifest, normalizedAgent.corpus, input.signal);

    const corpusBytes = await input.objectStore.get(release.corpus_ref);
    if (digest(corpusBytes) !== release.corpus_digest) {
      throw new Error("Live release Corpus bytes do not match corpus_digest");
    }
    await copyReleaseObjects({
      objects: input.objectStore,
      oldReleaseRef: release.release_ref,
      newReleaseRef,
      oldRuntimeManifestRef: release.runtime_manifest_ref,
      oldCorpusRef: release.corpus_ref,
      newRuntimeManifestRef,
      newCorpusRef,
      agentBytes,
      runtimeBytes,
      releaseBytes: newReleaseBytes,
      signal: input.signal,
    });

    await installLocalRelease(stagingRoot, newRoot, normalizedRuntime.manifest, normalizedAgent.manifest, oldRoot, input.signal);
    stagingOwned = false;
    if (input.knowledgeIndexer && normalizedAgent.corpus.knowledge.documents.length > 0) {
      await input.knowledgeIndexer.stageAgentDocuments(
        release.creator_id,
        release.product_id,
        release.corpus_digest,
        newRoot,
        normalizedAgent.corpus.knowledge.documents as KnowledgeDocument[],
        { signal: input.signal },
      );
    }
    // Re-check after every asset has been materialized and immediately before
    // the pointer mutation. A newer publish must never be replaced by this
    // historical migration.
    const current = await input.releaseStore.getLive(release.product_id);
    if (!current || current.release_digest !== release.release_digest) {
      throw new Error("Live release changed while Knowledge title migration was staging");
    }
    const published = await input.releaseStore.publish(newReleaseInput);
    return {
      product_id: release.product_id,
      creator_id: release.creator_id,
      status: "migrated",
      migrated_documents: normalizedAgent.corpus.knowledge.documents.length,
      previous_release: release,
      release: published,
    };
  } finally {
    if (stagingOwned) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function validateRelease(release: CreatorRegistryRelease): CreatorRegistryRelease {
  requireUuidV4(release.product_id, "product_id");
  requireUuidV4(release.creator_id, "creator_id");
  assertDigest(release.release_digest, "release_digest");
  assertDigest(release.corpus_digest, "corpus_digest");
  const suffix = `${release.product_id}/releases/${release.release_digest.slice("sha256:".length)}`;
  if (!release.release_ref.endsWith(suffix)) throw new Error("Live release reference is not canonical");
  if (release.corpus_ref !== `${release.release_ref}/corpus.json`) throw new Error("Live Corpus reference is not canonical");
  if (release.runtime_manifest_ref !== `${release.release_ref}/runtime/manifest.json`) {
    throw new Error("Live Runtime manifest reference is not canonical");
  }
  return release;
}

function normalizeRuntimeManifest(raw: unknown): { manifest: RuntimeCorpusManifest; changed: boolean } {
  const historical = historicalRuntimeManifestSchema.parse(raw);
  let changed = false;
  const knowledge = historical.knowledge.map((document) => {
    if ("source_summary" in document) {
      changed = true;
      return { id: document.id, title: document.source_summary, ref: document.ref };
    }
    return document;
  });
  const manifest = runtimeCorpusManifestSchema.parse({ ...historical, knowledge });
  return { manifest, changed };
}

function normalizeAgentManifest(raw: unknown): {
  manifest: Record<string, unknown>;
  corpus: AgentCorpus;
  changed: boolean;
} {
  const root = jsonObject(raw, "Agent Corpus manifest");
  const normalized = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
  let changed = false;
  const knowledge = normalized.knowledge;
  if (knowledge !== undefined) {
    const knowledgeObject = jsonObject(knowledge, "Agent Corpus knowledge");
    const documents = knowledgeObject.documents;
    if (documents !== undefined) {
      if (!Array.isArray(documents)) throw new Error("Agent Corpus knowledge.documents must be an array");
      knowledgeObject.documents = documents.map((document) => {
        const row = jsonObject(document, "Agent Corpus Knowledge document");
        if (!Object.prototype.hasOwnProperty.call(row, "source_summary")) return row;
        if (Object.prototype.hasOwnProperty.call(row, "title")) {
          throw new Error("Agent Corpus Knowledge document contains both title and historical source_summary");
        }
        const summary = row.source_summary;
        if (typeof summary !== "string") throw new Error("Historical Knowledge source_summary must be a string");
        delete row.source_summary;
        row.title = summary;
        changed = true;
        return row;
      });
    }
  }
  // Product pricing metadata was removed before the title cutover. A new
  // release must not carry that historical field forward either.
  const product = normalized.product;
  if (product && typeof product === "object" && !Array.isArray(product)) {
    const productObject = product as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(productObject, "offer")) {
      delete productObject.offer;
      changed = true;
    }
  }
  const corpus = AgentCorpusSchema.parse(normalized);
  return { manifest: normalized, corpus, changed };
}

function assertKnowledgeAlignment(runtime: RuntimeCorpusManifest, corpus: AgentCorpus): void {
  const runtimeById = new Map(runtime.knowledge.map((document) => [document.id, document]));
  if (runtimeById.size !== runtime.knowledge.length || runtimeById.size !== corpus.knowledge.documents.length) {
    throw new Error("Runtime and Agent Corpus Knowledge document sets do not match");
  }
  for (const document of corpus.knowledge.documents) {
    const runtimeDocument = runtimeById.get(document.id);
    if (!runtimeDocument || runtimeDocument.title !== document.title) {
      throw new Error(`Runtime and Agent Corpus Knowledge title mismatch: ${document.id}`);
    }
  }
}

async function validateCurrentRelease(
  root: string,
  runtimeManifest: RuntimeCorpusManifest,
  agentManifest: Record<string, unknown>,
): Promise<void> {
  const parsedAgent = await loadAgentCorpus(root);
  AgentCorpusSchema.parse(JSON.parse(encodeJson(agentManifest).toString("utf8")));
  const parsedRuntime = runtimeCorpusManifestSchema.parse(runtimeManifest);
  assertKnowledgeAlignment(parsedRuntime, parsedAgent);
  await verifyRuntimeAssets(root, parsedRuntime);
}

async function verifyRuntimeAssets(root: string, manifest: RuntimeCorpusManifest): Promise<void> {
  const assets = [
    manifest.system_ref,
    ...manifest.skills.flatMap((skill) => [skill.ref, ...skill.references.map((reference) => reference.ref)]),
    ...manifest.knowledge.map((document) => document.ref),
  ];
  for (const asset of assets) await readDigestCheckedFile(root, asset.path, asset.sha256);
}

async function assertKnowledgeBytesUnchanged(
  oldRoot: string,
  newRoot: string,
  runtimeManifest: RuntimeCorpusManifest,
  corpus: AgentCorpus,
  signal?: AbortSignal,
): Promise<void> {
  for (const document of corpus.knowledge.documents) {
    throwIfAborted(signal);
    await compareFiles(oldRoot, newRoot, document.path, document.sha256);
  }
  for (const document of runtimeManifest.knowledge) {
    throwIfAborted(signal);
    await compareFiles(oldRoot, newRoot, document.ref.path, document.ref.sha256);
  }
}

async function compareFiles(oldRoot: string, newRoot: string, relativePath: string, expectedDigest: string): Promise<void> {
  const oldBytes = await readContainedFile(oldRoot, relativePath);
  const newBytes = await readContainedFile(newRoot, relativePath);
  if (!oldBytes.equals(newBytes)) throw new Error(`Knowledge asset bytes changed during migration: ${relativePath}`);
  if (digest(oldBytes) !== expectedDigest) throw new Error(`Knowledge asset digest is invalid: ${relativePath}`);
}

async function copyReleaseObjects(input: {
  objects: ArtifactObjectStore;
  oldReleaseRef: string;
  newReleaseRef: string;
  oldRuntimeManifestRef: string;
  oldCorpusRef: string;
  newRuntimeManifestRef: string;
  newCorpusRef: string;
  agentBytes: Buffer;
  runtimeBytes: Buffer;
  releaseBytes: Buffer;
  signal?: AbortSignal;
}): Promise<void> {
  const listed = await input.objects.list(input.oldReleaseRef);
  const keys = new Set(listed.filter((key) => key.startsWith(`${input.oldReleaseRef}/`)));
  keys.add(input.oldRuntimeManifestRef);
  keys.add(input.oldCorpusRef);
  for (const key of [...keys].sort()) {
    throwIfAborted(input.signal);
    const suffix = key.slice(input.oldReleaseRef.length);
    if (!suffix.startsWith("/")) throw new Error(`Object store returned a non-descendant release key: ${key}`);
    const target = `${input.newReleaseRef}${suffix}`;
    if (key === input.oldRuntimeManifestRef || suffix === "/runtime/manifest.json") {
      await input.objects.put(input.newRuntimeManifestRef, input.runtimeBytes, { immutable: true, contentType: "application/json" });
      continue;
    }
    if (suffix === "/release.json") continue;
    if (suffix === "/agent.json") {
      await input.objects.put(`${input.newReleaseRef}/agent.json`, input.agentBytes, { immutable: true, contentType: "application/json" });
      continue;
    }
    await input.objects.put(target, await input.objects.get(key), { immutable: true });
  }
  // These explicit writes make the operation independent of list pagination
  // and ensure the two release contracts are present before publication.
  await input.objects.put(input.newRuntimeManifestRef, input.runtimeBytes, { immutable: true, contentType: "application/json" });
  await input.objects.put(input.newCorpusRef, await input.objects.get(input.oldCorpusRef), { immutable: true, contentType: "application/json" });
  await input.objects.put(`${input.newReleaseRef}/release.json`, input.releaseBytes, { immutable: true, contentType: "application/json" });
  const installedRuntime = await input.objects.get(input.newRuntimeManifestRef);
  if (!installedRuntime.equals(input.runtimeBytes)) throw new Error("Migrated OSS Runtime manifest cannot be verified");
}

async function installLocalRelease(
  stagingRoot: string,
  destinationRoot: string,
  runtimeManifest: RuntimeCorpusManifest,
  agentManifest: Record<string, unknown>,
  oldRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (await pathExists(destinationRoot)) {
    await validateCurrentRelease(destinationRoot, runtimeManifest, agentManifest);
    await assertKnowledgeBytesUnchanged(oldRoot, destinationRoot, runtimeManifest, AgentCorpusSchema.parse(agentManifest), signal);
    await rm(stagingRoot, { recursive: true, force: true });
    return;
  }
  try {
    await rename(stagingRoot, destinationRoot);
  } catch (error) {
    if (!(await pathExists(destinationRoot))) throw error;
    await validateCurrentRelease(destinationRoot, runtimeManifest, agentManifest);
    await assertKnowledgeBytesUnchanged(oldRoot, destinationRoot, runtimeManifest, AgentCorpusSchema.parse(agentManifest), signal);
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

function localReleasePath(runtimeRoot: string, productId: string, releaseDigest: string): string {
  assertDigest(releaseDigest, "release_digest");
  requireUuidV4(productId, "product_id");
  const base = path.resolve(runtimeRoot);
  const resolved = path.resolve(base, productId, releaseDigest.slice("sha256:".length));
  if (!resolved.startsWith(`${base}${path.sep}`)) throw new Error("Runtime release path escapes the shared volume");
  return resolved;
}

function releaseRefForDigest(oldReleaseRef: string, oldDigest: string, newDigest: string, productId: string): string {
  const match = oldReleaseRef.match(/^(.*\/releases\/)([a-f0-9]{64})$/);
  if (!match || match[2] !== oldDigest.slice("sha256:".length) || !match[1].endsWith(`${productId}/releases/`)) {
    throw new Error("Live release reference does not contain its release digest");
  }
  return `${match[1]}${newDigest.slice("sha256:".length)}`;
}

function migrationReleaseDigest(release: CreatorRegistryRelease, agentBytes: Buffer, runtimeBytes: Buffer): string {
  return digest(Buffer.from(JSON.stringify({
    migration: "knowledge-title-v1",
    previous_release_digest: release.release_digest,
    corpus_digest: release.corpus_digest,
    agent_manifest_digest: digest(agentBytes),
    runtime_manifest_digest: digest(runtimeBytes),
  })));
}

async function readBoundedFile(filePath: string, label: string): Promise<Buffer> {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) throw new Error(`${label} is invalid or too large`);
  return readFile(filePath);
}

async function readDigestCheckedFile(root: string, relativePath: string, expectedDigest: string): Promise<Buffer> {
  const bytes = await readContainedFile(root, relativePath);
  if (digest(bytes) !== expectedDigest) throw new Error(`Runtime asset digest is invalid: ${relativePath}`);
  return bytes;
}

async function readContainedFile(root: string, relativePath: string): Promise<Buffer> {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Runtime asset path escapes its release: ${relativePath}`);
  }
  return readFile(resolved);
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digest(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST.test(value)) throw new Error(`${label} is invalid`);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Knowledge title migration was aborted");
}
