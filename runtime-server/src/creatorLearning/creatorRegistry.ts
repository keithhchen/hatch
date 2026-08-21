import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeNodeObjectPath } from "../node.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import { normalizeBriefSpec, type BriefSpec } from "../brief.js";
import { corpusOutputSchema, type CorpusOutput } from "./corpusNode.js";
import { isObjectStoreNotFound, type ArtifactObjectStore } from "./objectStore.js";

const RELEASE_REF_SCHEMA = z.object({
  contract_version: z.literal("1"),
  product_id: z.string().min(1),
  creator_id: z.string().min(1),
  release_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  corpus_ref: z.string().min(1),
  corpus_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  brief_spec: z.unknown(),
  status: z.literal("live"),
  published_at: z.string().datetime()
}).strict();

const RUNTIME_ASSET_REF_SCHEMA = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/)
}).strict();

/** The only manifest Runtime needs after it has read the live release pointer. */
export const CREATOR_RUNTIME_MANIFEST_SCHEMA = z.object({
  contract_version: z.literal("1"),
  creator: z.object({ id: z.string().min(1) }).strict(),
  product: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    promise: z.string().min(1)
  }).strict(),
  corpus_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  system_ref: RUNTIME_ASSET_REF_SCHEMA,
  skills: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    ref: RUNTIME_ASSET_REF_SCHEMA,
    references: z.array(z.object({
      id: z.string().min(1),
      kind: z.enum(["method", "style", "example", "few_shots"]),
      ref: RUNTIME_ASSET_REF_SCHEMA
    }).strict())
  }).strict()),
  knowledge: z.array(z.object({
    id: z.string().min(1),
    ref: RUNTIME_ASSET_REF_SCHEMA,
    source_summary: z.string().min(1)
  }).strict()),
  brief_spec: z.unknown()
}).strict();

export type CreatorRuntimeManifest = z.infer<typeof CREATOR_RUNTIME_MANIFEST_SCHEMA>;

/**
 * The v1 Registry artifact is a deterministic, consumer-facing materialized
 * document. It is intentionally different from the raw Corpus Node output:
 * product identity, creator binding, and the post-Corpus Brief belong at the
 * publish boundary, not inside the Node candidate.
 */
export const CREATOR_REGISTRY_ARTIFACT_SCHEMA = z.object({
  contract_version: z.literal("1"),
  creator: z.object({ id: z.string().min(1) }).strict(),
  product: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    promise: z.string().min(1)
  }).strict(),
  brief_spec: z.unknown(),
  corpus: corpusOutputSchema
}).strict();

export type CreatorRegistryArtifact = z.infer<typeof CREATOR_REGISTRY_ARTIFACT_SCHEMA>;

export const POSTGRES_CREATOR_REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_creator_registry_releases (
  product_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  release_digest TEXT NOT NULL,
  corpus_digest TEXT NOT NULL,
  corpus_ref TEXT NOT NULL,
  release_ref TEXT NOT NULL,
  brief_spec JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, release_digest)
);
ALTER TABLE hatch_creator_registry_releases ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'live';
CREATE TABLE IF NOT EXISTS hatch_creator_registry_live (
  product_id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  release_digest TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hatch_creator_registry_live_creator_idx
  ON hatch_creator_registry_live (creator_id, product_id);
`;

export type CreatorRegistryRelease = {
  productId: string;
  creatorId: string;
  releaseDigest: string;
  corpusDigest: string;
  corpusRef: string;
  releaseRef: string;
  runtimeManifestRef: string;
  briefSpec: BriefSpec;
  status: "live";
  publishedAt: string;
};

export class CreatorRegistryError extends Error {
  constructor(
    readonly code: "invalid_corpus_ref" | "corpus_not_found" | "invalid_corpus" | "registry_unavailable",
    message: string,
    readonly status = code === "registry_unavailable" ? 503 : 422
  ) {
    super(message);
    this.name = "CreatorRegistryError";
  }
}

/** The new Creator publish boundary: immutable OSS release + Postgres pointer. */
export class CreatorRegistry {
  private schemaPromise?: Promise<void>;

  constructor(
    private readonly objects: ArtifactObjectStore,
    private readonly pool: PostgresQueryExecutor,
    private readonly prefix = "registry"
  ) {}

  async initialize(): Promise<void> {
    this.schemaPromise ??= this.pool.query(POSTGRES_CREATOR_REGISTRY_SCHEMA).then(() => undefined);
    await this.schemaPromise;
  }

  async publish(input: {
    creatorId: string;
    productId: string;
    product: {
      name: string;
      promise: string;
    };
    corpusRef: string;
    briefSpec: unknown;
  }): Promise<CreatorRegistryRelease> {
    await this.initialize();
    const corpusRef = this.validateCorpusRef(input.productId, input.corpusRef);
    const sourceBytes = await this.readCorpus(corpusRef);
    const corpus = parseCorpus(sourceBytes);
    const briefSpec = normalizeBriefSpec(input.briefSpec);
    const materialized = materializeRegistryArtifact({
      creatorId: input.creatorId,
      productId: input.productId,
      product: input.product,
      briefSpec,
      corpus
    });
    const bytes = Buffer.from(`${JSON.stringify(materialized, null, 2)}\n`, "utf8");
    const corpusDigest = sha256(bytes);
    const releaseDigest = sha256(Buffer.from(JSON.stringify({ corpusDigest, briefSpec }), "utf8"));
    const releaseRoot = `${safePart(this.prefix)}/${safePart(input.productId)}/releases/${releaseDigest.slice("sha256:".length)}`;
    const releaseCorpusRef = `${releaseRoot}/corpus.json`;
    const releaseRef = `${releaseRoot}/release.json`;
    const existingManifest = await this.readExistingManifest(
      releaseRef,
      releaseCorpusRef,
      input.productId,
      input.creatorId,
      releaseDigest,
      corpusDigest,
      briefSpec
    );
    const publishedAt = existingManifest?.published_at ?? new Date().toISOString();
    const manifest = existingManifest ?? {
      contract_version: "1" as const,
      product_id: input.productId,
      creator_id: input.creatorId,
      release_digest: releaseDigest,
      corpus_ref: releaseCorpusRef,
      corpus_digest: corpusDigest,
      brief_spec: briefSpec,
      status: "live",
      published_at: publishedAt
    };
    if (!existingManifest) {
      await this.objects.put(releaseCorpusRef, bytes, {
        contentType: "application/json; charset=utf-8",
        immutable: true
      });
      await this.objects.put(releaseRef, `${JSON.stringify(manifest, null, 2)}\n`, {
        contentType: "application/json; charset=utf-8",
        immutable: true
      });
    }
    const runtimeManifestRef = await this.materializeRuntimeRelease({
      releaseRoot,
      creatorId: input.creatorId,
      productId: input.productId,
      corpusDigest,
      briefSpec,
      product: input.product,
      corpus: materialized.corpus
    });
    await this.pool.query(`
      INSERT INTO hatch_creator_registry_releases
        (product_id, creator_id, release_digest, corpus_digest, corpus_ref, release_ref, brief_spec, status, published_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'live', $8::timestamptz)
      ON CONFLICT (product_id, release_digest) DO NOTHING
    `, [
      input.productId,
      input.creatorId,
      releaseDigest,
      corpusDigest,
      releaseCorpusRef,
      releaseRef,
      JSON.stringify(briefSpec),
      publishedAt
    ]);
    await this.pool.query(`
      INSERT INTO hatch_creator_registry_live
        (product_id, creator_id, release_digest, updated_at)
      VALUES ($1, $2, $3, clock_timestamp())
      ON CONFLICT (product_id) DO UPDATE SET
        creator_id = EXCLUDED.creator_id,
        release_digest = EXCLUDED.release_digest,
        updated_at = clock_timestamp()
    `, [input.productId, input.creatorId, releaseDigest]);
    return {
      productId: input.productId,
      creatorId: input.creatorId,
      releaseDigest,
      corpusDigest,
      corpusRef: releaseCorpusRef,
      releaseRef,
      runtimeManifestRef,
      briefSpec,
      status: "live",
      publishedAt
    };
  }

  private async materializeRuntimeRelease(input: {
    releaseRoot: string;
    creatorId: string;
    productId: string;
    corpusDigest: string;
    briefSpec: BriefSpec;
    product: { name: string; promise: string };
    corpus: CorpusOutput;
  }): Promise<string> {
    const runtimeRoot = `${input.releaseRoot}/runtime`;
    const systemPath = `${runtimeRoot}/instructions/system.md`;
    const systemBytes = Buffer.from(input.corpus.system_instructions, "utf8");
    await this.objects.put(systemPath, systemBytes, { contentType: "text/markdown; charset=utf-8", immutable: true });

    const skills: CreatorRuntimeManifest["skills"] = [];
    const seenSkillIds = new Set<string>();
    for (const skill of input.corpus.skills) {
      const id = runtimeIdentifier(skill.id, "Skill");
      if (seenSkillIds.has(id)) throw new CreatorRegistryError("invalid_corpus", `Duplicate runtime Skill id: ${id}`);
      seenSkillIds.add(id);
      const instructionPath = `${runtimeRoot}/skills/${id}/SKILL.md`;
      const instruction = [
        "---",
        `name: ${JSON.stringify(id)}`,
        `description: ${JSON.stringify(skill.when_to_use)}`,
        "---",
        "",
        skill.instruction
      ].join("\n");
      const instructionBytes = Buffer.from(instruction, "utf8");
      await this.objects.put(instructionPath, instructionBytes, { contentType: "text/markdown; charset=utf-8", immutable: true });
      const references: CreatorRuntimeManifest["skills"][number]["references"] = [];
      const seenReferenceIds = new Set<string>();
      for (const reference of skill.references) {
        const referenceId = runtimeIdentifier(reference.id, `Skill ${id} reference`);
        if (seenReferenceIds.has(referenceId)) {
          throw new CreatorRegistryError("invalid_corpus", `Duplicate runtime reference id in Skill ${id}: ${referenceId}`);
        }
        seenReferenceIds.add(referenceId);
        const referencePath = `${runtimeRoot}/skills/${id}/references/${referenceId}.md`;
        const referenceBytes = Buffer.from(reference.content, "utf8");
        await this.objects.put(referencePath, referenceBytes, { contentType: "text/markdown; charset=utf-8", immutable: true });
        references.push({
          id: referenceId,
          kind: reference.kind,
          ref: { path: referencePath, sha256: sha256(referenceBytes) }
        });
      }
      skills.push({
        id,
        name: skill.title,
        description: skill.when_to_use,
        ref: { path: instructionPath, sha256: sha256(instructionBytes) },
        references
      });
    }

    const knowledge: CreatorRuntimeManifest["knowledge"] = [];
    const seenKnowledgeIds = new Set<string>();
    for (const document of input.corpus.knowledge) {
      const id = runtimeIdentifier(document.id, "Knowledge document");
      if (seenKnowledgeIds.has(id)) throw new CreatorRegistryError("invalid_corpus", `Duplicate runtime Knowledge id: ${id}`);
      seenKnowledgeIds.add(id);
      const assetPath = `${runtimeRoot}/knowledge/${id}.md`;
      const bytes = Buffer.from(document.content, "utf8");
      await this.objects.put(assetPath, bytes, { contentType: "text/markdown; charset=utf-8", immutable: true });
      knowledge.push({
        id,
        ref: { path: assetPath, sha256: sha256(bytes) },
        source_summary: document.source_summary
      });
    }

    const manifest: CreatorRuntimeManifest = CREATOR_RUNTIME_MANIFEST_SCHEMA.parse({
      contract_version: "1",
      creator: { id: input.creatorId },
      product: {
        id: input.productId,
        name: input.product.name.trim(),
        promise: input.product.promise.trim()
      },
      corpus_digest: input.corpusDigest,
      system_ref: { path: systemPath, sha256: sha256(systemBytes) },
      skills,
      knowledge,
      brief_spec: input.briefSpec
    });
    const manifestPath = `${runtimeRoot}/manifest.json`;
    await this.objects.put(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      contentType: "application/json; charset=utf-8",
      immutable: true
    });
    return manifestPath;
  }

  private async readExistingManifest(
    releaseRef: string,
    releaseCorpusRef: string,
    productId: string,
    creatorId: string,
    releaseDigest: string,
    corpusDigest: string,
    briefSpec: BriefSpec
  ): Promise<z.infer<typeof RELEASE_REF_SCHEMA> | undefined> {
    let manifestBytes: Buffer;
    try {
      manifestBytes = await this.objects.get(releaseRef);
    } catch (error) {
      if (isObjectStoreNotFound(error)) return undefined;
      throw error;
    }
    let manifest: z.infer<typeof RELEASE_REF_SCHEMA>;
    try {
      manifest = RELEASE_REF_SCHEMA.parse(JSON.parse(manifestBytes.toString("utf8")));
    } catch (error) {
      throw new CreatorRegistryError("invalid_corpus", `The existing Registry release is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (manifest.product_id !== productId
      || manifest.creator_id !== creatorId
      || manifest.release_digest !== releaseDigest
      || manifest.corpus_ref !== releaseCorpusRef
      || manifest.corpus_digest !== corpusDigest
      || JSON.stringify(normalizeBriefSpec(manifest.brief_spec)) !== JSON.stringify(briefSpec)) {
      throw new CreatorRegistryError("invalid_corpus", "The deterministic Registry release key contains different content");
    }
    try {
      const corpusBytes = await this.objects.get(releaseCorpusRef);
      if (sha256(corpusBytes) !== manifest.corpus_digest) {
        throw new CreatorRegistryError("invalid_corpus", "The existing Registry release has a different Corpus digest");
      }
      try {
        CREATOR_REGISTRY_ARTIFACT_SCHEMA.parse(JSON.parse(corpusBytes.toString("utf8")));
      } catch (error) {
        throw new CreatorRegistryError("invalid_corpus", `The existing Registry Corpus artifact is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      if (!isObjectStoreNotFound(error)) throw error;
      throw new CreatorRegistryError("invalid_corpus", "The existing Registry release is missing its Corpus artifact");
    }
    return manifest;
  }

  async current(creatorId: string, productId: string): Promise<CreatorRegistryRelease | undefined> {
    await this.initialize();
    const result = await this.pool.query<RegistryReleaseRow>(`
      SELECT release.product_id, release.creator_id, release.release_digest,
             release.corpus_digest, release.corpus_ref, release.release_ref,
             release.brief_spec, release.status, release.published_at
      FROM hatch_creator_registry_live AS live
      JOIN hatch_creator_registry_releases AS release
        ON release.product_id = live.product_id
       AND release.release_digest = live.release_digest
      WHERE live.creator_id = $1 AND live.product_id = $2
        AND release.status = 'live'
      LIMIT 1
    `, [creatorId, productId]);
    const row = result.rows[0];
    return row ? releaseFromRow(row) : undefined;
  }

  async currentByProduct(productId: string): Promise<CreatorRegistryRelease | undefined> {
    await this.initialize();
    const result = await this.pool.query<RegistryReleaseRow>(`
      SELECT release.product_id, release.creator_id, release.release_digest,
             release.corpus_digest, release.corpus_ref, release.release_ref,
             release.brief_spec, release.status, release.published_at
      FROM hatch_creator_registry_live AS live
      JOIN hatch_creator_registry_releases AS release
        ON release.product_id = live.product_id
       AND release.release_digest = live.release_digest
      WHERE live.product_id = $1 AND release.status = 'live'
      LIMIT 1
    `, [productId]);
    const row = result.rows[0];
    return row ? releaseFromRow(row) : undefined;
  }

  async listCurrent(creatorId: string): Promise<CreatorRegistryRelease[]> {
    await this.initialize();
    const result = await this.pool.query<RegistryReleaseRow>(`
      SELECT release.product_id, release.creator_id, release.release_digest,
             release.corpus_digest, release.corpus_ref, release.release_ref,
             release.brief_spec, release.status, release.published_at
      FROM hatch_creator_registry_live AS live
      JOIN hatch_creator_registry_releases AS release
        ON release.product_id = live.product_id
       AND release.release_digest = live.release_digest
      WHERE live.creator_id = $1 AND release.status = 'live'
      ORDER BY release.published_at DESC, release.product_id ASC
    `, [creatorId]);
    return result.rows.map(releaseFromRow);
  }

  private validateCorpusRef(productId: string, value: string): string {
    let reference: string;
    try {
      reference = normalizeNodeObjectPath(value);
    } catch {
      throw new CreatorRegistryError("invalid_corpus_ref", "corpus_ref must be a complete OSS object path");
    }
    const prefix = `${safePart(productId)}/corpus/`;
    if (!reference.startsWith(prefix) || !reference.endsWith("/output.json")) {
      throw new CreatorRegistryError("invalid_corpus_ref", "corpus_ref must point to a completed Corpus Node output");
    }
    return reference;
  }

  private async readCorpus(reference: string): Promise<Buffer> {
    try {
      return await this.objects.get(reference);
    } catch (error) {
      if (isObjectStoreNotFound(error)) {
        throw new CreatorRegistryError("corpus_not_found", "The Corpus output is no longer available in OSS", 404);
      }
      throw new CreatorRegistryError(
        "registry_unavailable",
        `Registry could not read the Corpus output from OSS: ${error instanceof Error ? error.message : String(error)}`,
        503
      );
    }
  }
}

type RegistryReleaseRow = {
  product_id: string;
  creator_id: string;
  release_digest: string;
  corpus_digest: string;
  corpus_ref: string;
  release_ref: string;
  brief_spec: unknown;
  status: string;
  published_at: string | Date;
};

function parseCorpus(bytes: Buffer): CorpusOutput {
  try {
    return corpusOutputSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new CreatorRegistryError("invalid_corpus", `The Corpus output is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function materializeRegistryArtifact(input: {
  creatorId: string;
  productId: string;
  product: { name: string; promise: string };
  briefSpec: BriefSpec;
  corpus: CorpusOutput;
}): CreatorRegistryArtifact {
  return CREATOR_REGISTRY_ARTIFACT_SCHEMA.parse({
    contract_version: "1",
    creator: { id: input.creatorId },
    product: {
      id: input.productId,
      name: input.product.name.trim(),
      promise: input.product.promise.trim()
    },
    brief_spec: input.briefSpec,
    corpus: input.corpus
  });
}

function releaseFromRow(row: RegistryReleaseRow): CreatorRegistryRelease {
  const manifest = RELEASE_REF_SCHEMA.parse({
    contract_version: "1",
    product_id: row.product_id,
    creator_id: row.creator_id,
    release_digest: row.release_digest,
    corpus_ref: row.corpus_ref,
    corpus_digest: row.corpus_digest,
    brief_spec: typeof row.brief_spec === "string" ? JSON.parse(row.brief_spec) : row.brief_spec,
    status: row.status,
    published_at: new Date(row.published_at).toISOString()
  });
  return {
    productId: row.product_id,
    creatorId: row.creator_id,
    releaseDigest: row.release_digest,
    corpusDigest: manifest.corpus_digest,
    corpusRef: manifest.corpus_ref,
    releaseRef: row.release_ref,
    runtimeManifestRef: runtimeManifestRef(row.release_ref),
    briefSpec: normalizeBriefSpec(manifest.brief_spec),
    status: "live",
    publishedAt: manifest.published_at
  };
}

function runtimeManifestRef(releaseRef: string): string {
  if (!releaseRef.endsWith("/release.json")) {
    throw new CreatorRegistryError("invalid_corpus", "Registry release_ref must point to release.json");
  }
  return `${releaseRef.slice(0, -"/release.json".length)}/runtime/manifest.json`;
}

function runtimeIdentifier(value: string, label: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized) || normalized.length > 128) {
    throw new CreatorRegistryError("invalid_corpus", `${label} id must be a runtime-safe identifier: ${value}`);
  }
  return normalized;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function safePart(value: string): string {
  const normalized = value.trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) throw new Error(`Unsafe registry path part: ${value}`);
  return normalized;
}
