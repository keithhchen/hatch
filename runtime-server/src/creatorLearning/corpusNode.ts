import { z } from "zod";
import {
  criticVerdictSchema,
  type NodeActorInput,
  type NodeCriticInput,
  type NodeDefinition
} from "../node.js";

export const corpusInputSchema = z.object({
  files: z.array(z.string().min(1)).min(1),
  about_you: z.string().min(1),
  product: z.string().min(1)
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
  references: z.array(corpusReferenceSchema).min(1)
}).strict();

const corpusKnowledgeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  source_summary: z.string().min(1),
  content: z.string().min(1)
}).strict();

export const corpusOutputSchema = z.object({
  system_instructions: z.string().min(40),
  skills: z.array(corpusSkillSchema).min(1),
  knowledge: z.array(corpusKnowledgeSchema).min(1)
}).strict();

export const corpusCriticOutputSchema = criticVerdictSchema(z.string().min(1));

export type CorpusInput = z.infer<typeof corpusInputSchema>;
export type CorpusOutput = z.infer<typeof corpusOutputSchema>;
export type CorpusCriticOutput = z.infer<typeof corpusCriticOutputSchema>;

export const CORPUS_ACTOR_SYSTEM_PROMPT = `You are the Corpus Actor.

Your job is to turn the referenced source material into a durable agent corpus. The input is a flat manifest of complete OSS object paths, not source contents. The path field of every read call must be a concrete path shown as a value in this input, or an unambiguous filename alias. Before writing anything, pass the exact string shown in input.product and the exact string shown in input.about_you to read. Then read every relevant declared path in input.files using its complete path or a unique filename alias. On a revision, if previous is present, read the exact path shown in previous; if feedback is present, read the exact path shown in feedback. Read the source files themselves; there is no Files snapshot to expand. Never request a path that is not in the Runtime-provided manifest. Never return a placeholder, empty skills, empty knowledge, or generic filler.

Return the complete corpus candidate as JSON matching the output schema. The candidate has three parts:
- system_instructions: the stable operating principles the downstream agent should follow;
- skills: reusable methods, each with a clear use condition, instruction, and source-grounded references;
- knowledge: durable facts or explanations with their source summary.

Preserve the creator's actual judgment and examples. Every skill must contain at least one source-grounded reference, and every knowledge item must identify the source material it summarizes. Do not invent facts, add evaluation cases, add tool configuration, add file paths, or add audit metadata. When revising, produce a complete replacement, not a patch. If the feedback is ambiguous, make the best source-grounded correction available and let the Critic return revise feedback if another correction is needed.`;

export const CORPUS_CRITIC_SYSTEM_PROMPT = `You are the Corpus Critic.

Inspect the candidate at the OSS reference shown in the candidate field. Pass that exact path to the read tool, then inspect the declared source paths in input.files, input.about_you, and input.product using their complete paths or unique filename aliases. Judge whether the corpus is useful, faithful to the creator, internally coherent, and complete enough for a downstream agent. Reject placeholder text, empty skills, empty knowledge, skills without source references, and content that could have been written without reading the source material.

Return exactly one JSON verdict:
- {"decision":"done"} when no material correction is needed;
- {"decision":"revise","feedback":"..."} when the Actor can fix the problem from the available sources.

The Critic does not rewrite the corpus. Feedback must be concrete enough for the next Actor round. `;

export const corpusNode: NodeDefinition<CorpusInput, CorpusOutput, string> = {
  name: "corpus",
  inputSchema: corpusInputSchema,
  actor: {
    systemPrompt: CORPUS_ACTOR_SYSTEM_PROMPT,
    outputSchema: corpusOutputSchema,
    outputSchemaName: "corpus_output",
    storageAccess: "read",
    sessionPolicy: "spawn",
    renderInput: renderCorpusActorInput
  },
  critic: {
    systemPrompt: CORPUS_CRITIC_SYSTEM_PROMPT,
    outputSchema: corpusCriticOutputSchema,
    outputSchemaName: "corpus_critic_verdict",
    storageAccess: "read",
    sessionPolicy: "persistent",
    renderInput: renderCorpusCriticInput
  }
};

function renderCorpusActorInput(
  value: NodeActorInput<CorpusInput>
): string {
  return JSON.stringify({
    round: value.round,
    input: value.input,
    previous: value.previousCandidate,
    feedback: value.feedback
  }, null, 2);
}

function renderCorpusCriticInput(
  value: NodeCriticInput<CorpusInput>
): string {
  return JSON.stringify({
    round: value.round,
    input: value.input,
    candidate: value.candidate
  }, null, 2);
}
