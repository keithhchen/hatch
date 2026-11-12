import { z } from "zod";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** The immutable nested manifest produced by CreatorRegistry. */
export const runtimeCorpusManifestSchema = z.object({
  contract_version: z.literal("1"),
  creator: z.object({ id: z.string().min(1) }).strict(),
  product: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    promise: z.string().min(1)
  }).strict(),
  corpus_digest: digestSchema,
  system_ref: z.object({
    path: z.string().min(1),
    sha256: digestSchema
  }).strict(),
  skills: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    ref: z.object({
      path: z.string().min(1),
      sha256: digestSchema
    }).strict(),
    references: z.array(z.object({
      id: z.string().min(1),
      kind: z.enum(["method", "style", "example", "few_shots"]),
      ref: z.object({
        path: z.string().min(1),
        sha256: digestSchema
      }).strict()
    }).strict())
  }).strict()),
  tools: z.array(z.record(z.string(), z.unknown())).default([]),
  brief_spec: z.unknown()
}).strict();

export type RuntimeCorpusManifest = z.infer<typeof runtimeCorpusManifestSchema>;

/** Read boundary: manifests published while knowledge retrieval existed carry a retired `knowledge` list, which is dropped. */
export function parseRuntimeCorpusManifest(raw: unknown): RuntimeCorpusManifest {
  const { knowledge: _retired, ...manifest } = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return runtimeCorpusManifestSchema.parse(manifest);
}
