import { z } from "zod";

const corpusReferenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["method", "style", "example", "few_shots"]),
  content: z.string().min(1)
}).strict();

const corpusSkillSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  when_to_use: z.string().min(1),
  instruction: z.string().min(1),
  references: z.array(corpusReferenceSchema)
}).strict();

// Creator-owned tools are declarations, not connection details.  The
// connection_ref is resolved by Registry/Runtime after publication.
const corpusToolSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  capability: z.string().min(1).optional(),
  connection_ref: z.string().min(1).optional(),
  operation: z.string().min(1).optional(),
  tool_name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  input_schema: z.record(z.string(), z.unknown()).optional()
}).strict();

export const corpusOutputSchema = z.object({
  system_instructions: z.string().min(1),
  skills: z.array(corpusSkillSchema),
  tools: z.array(corpusToolSchema).default([])
}).strict();

export type CorpusOutput = z.infer<typeof corpusOutputSchema>;

/**
 * Read-time migration for corpora stored before the knowledge layer was retired (PR #278): published releases still
 * carry `knowledge`. New corpora are validated strictly; stored ones drop the retired key before the same strict parse.
 */
const RETIRED_CORPUS_KEYS = ["knowledge"] as const;
export function parseStoredCorpus(value: unknown): CorpusOutput {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const current = { ...(value as Record<string, unknown>) };
    for (const key of RETIRED_CORPUS_KEYS) delete current[key];
    return corpusOutputSchema.parse(current);
  }
  return corpusOutputSchema.parse(value);
}
