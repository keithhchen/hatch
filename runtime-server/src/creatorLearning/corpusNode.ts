import { z } from "zod";
import {
  criticVerdictSchema,
  type NodeActorInput,
  type NodeCriticInput,
  type NodeDefinition
} from "../node.js";

export const corpusInputSchema = z.object({
  files: z.string().min(1),
  about_you: z.string().min(1),
  product: z.string().min(1),
  previous: z.string().min(1).optional(),
  feedback: z.string().min(1).optional()
}).strict();

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

const corpusKnowledgeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  source_summary: z.string().min(1),
  content: z.string().min(1)
}).strict();

export const corpusOutputSchema = z.object({
  system_instructions: z.string().min(1),
  skills: z.array(corpusSkillSchema),
  knowledge: z.array(corpusKnowledgeSchema)
}).strict();

export const corpusCriticOutputSchema = criticVerdictSchema(z.string());

export type CorpusInput = z.infer<typeof corpusInputSchema>;
export type CorpusOutput = z.infer<typeof corpusOutputSchema>;
export type CorpusCriticOutput = z.infer<typeof corpusCriticOutputSchema>;

export const CORPUS_ACTOR_SYSTEM_PROMPT = `You are the Corpus Actor.

Your job is to turn the referenced source material into a durable agent corpus. The input contains references, not the source contents. Use the read tool to inspect files, about_you, and product. During a revision, the Runtime exposes the previous candidate at the read input "previous_candidate". Read only what you need, but read the relevant source before making claims.

Return the complete corpus candidate as JSON matching the output schema. The candidate has three parts:
- system_instructions: the stable operating principles the downstream agent should follow;
- skills: reusable methods, each with a clear use condition, instruction, and source-grounded references;
- knowledge: durable facts or explanations with their source summary.

Preserve the creator's actual judgment and examples. Do not invent facts, add evaluation cases, add tool configuration, add file paths, or add audit metadata. When revising, produce a complete replacement, not a patch. If feedback cannot be resolved from the references, keep the source-grounded parts and let the Critic continue the internal quality loop.`;

export const CORPUS_CRITIC_SYSTEM_PROMPT = `You are the Corpus Critic.

Inspect the candidate against the referenced files, about_you, and product. The Runtime exposes the candidate at the read input "candidate". Use the read tool to inspect it and the source references. Judge whether the corpus is useful, faithful to the creator, internally coherent, and complete enough for a downstream agent.

Return exactly one JSON verdict:
- {"decision":"done"} when no material correction is needed;
- {"decision":"revise","feedback":"..."} when the Actor can fix the problem from the available sources.

The Critic does not rewrite the corpus. Feedback must be concrete enough for the next Actor round. The Creator is outside this Node loop. `;

export const corpusNode: NodeDefinition<CorpusInput, CorpusOutput, string> = {
  name: "corpus",
  inputSchema: corpusInputSchema,
  actor: {
    systemPrompt: CORPUS_ACTOR_SYSTEM_PROMPT,
    outputSchema: corpusOutputSchema,
    outputSchemaName: "corpus_output",
    sessionPolicy: "spawn",
    storageAccess: "read",
    renderInput: renderCorpusActorInput
  },
  critic: {
    systemPrompt: CORPUS_CRITIC_SYSTEM_PROMPT,
    outputSchema: corpusCriticOutputSchema,
    outputSchemaName: "corpus_critic_verdict",
    sessionPolicy: "persistent",
    storageAccess: "read",
    renderInput: renderCorpusCriticInput
  }
};

function renderCorpusActorInput(
  value: NodeActorInput<CorpusInput, CorpusOutput, string>
): string {
  return JSON.stringify({
    round: value.round,
    input: value.input,
    previous_candidate_ref: value.previousCandidateRef,
    feedback: value.feedback
  }, null, 2);
}

function renderCorpusCriticInput(
  value: NodeCriticInput<CorpusInput, CorpusOutput>
): string {
  return JSON.stringify({
    round: value.round,
    input: value.input,
    candidate_ref: value.candidateRef
  }, null, 2);
}
