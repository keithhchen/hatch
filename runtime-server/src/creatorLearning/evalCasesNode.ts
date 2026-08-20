import { z } from "zod";
import {
  criticVerdictSchema,
  type NodeActorInput,
  type NodeCriticInput,
  type NodeDefinition,
  nodeObjectPathSchema
} from "../node.js";

/** Eval Cases Generation receives the Product and the upstream Corpus. */
export const evalCasesInputSchema = z.object({
  product: nodeObjectPathSchema,
  corpus: nodeObjectPathSchema
}).strict();

/** One evaluator-owned case. The input is shown to Hatch; the other fields stay with the evaluator. */
const evalCaseSchema = z.object({
  case_id: z.string().min(1),
  split: z.enum(["development", "held_out"]),
  input: z.string().min(1),
  expected_behavior: z.string().min(1),
  checks: z.array(z.string().min(1)).min(1)
}).strict();

export const evalCasesOutputSchema = z.object({
  cases: z.array(evalCaseSchema).min(1)
}).strict();

export const evalCasesCriticOutputSchema = criticVerdictSchema(z.string());

export type EvalCasesInput = z.infer<typeof evalCasesInputSchema>;
export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalCasesOutput = z.infer<typeof evalCasesOutputSchema>;
export type EvalCasesCriticOutput = z.infer<typeof evalCasesCriticOutputSchema>;

const EVAL_CASES_INPUT_PROTOCOL = `Input and read protocol:

This Node receives a flat manifest of complete OSS object paths. The Runtime has already resolved the references; use the exact paths shown in the input.

- product: one OSS path to the Product brief. It defines the customer job, intended user, deliverable, and boundary that the cases must exercise.
- corpus: one OSS path to the upstream Corpus candidate. It contains the Creator-derived instructions, reusable skills, and knowledge that the cases must test.

Read both paths before designing or judging cases. On an Actor revision, first read previous_candidate_ref and feedback_ref, then reread product and corpus as needed.`;

export const EVAL_CASES_ACTOR_SYSTEM_PROMPT = `You are the Eval Cases Generation Actor.

Your job is to turn one Product and one upstream Corpus into a compact, useful evaluation set for the downstream Eval Runner. The cases test whether Hatch can perform the Product job using the Corpus; they are not additional Corpus content.

${EVAL_CASES_INPUT_PROTOCOL}

Work sequence:
1. Understand the Product job, user, deliverable, and boundary.
2. Read the Corpus and identify the decisions, methods, quality bars, exceptions, and abstention behavior that matter.
3. Design distinct case families that exercise ordinary work, combined decisions, boundary handling, missing information, and out-of-scope behavior when those patterns are supported by the Product and Corpus.
4. Generate two kinds of cases:
   - development: visible to the build-time evaluation loop and useful for diagnosing Corpus quality;
   - held_out: novel cases reserved for the generalization check.
5. Keep each case's input, expected behavior, and observable checks coherent. Expected behavior describes what a good result must do, not one mandatory wording.
6. Submit the complete replacement through submit_output.

Output contract:
- cases is a list of evaluator-owned cases;
- case_id is unique within this candidate so results can refer back to a case;
- split is development or held_out;
- input is the prompt or task payload that Hatch will receive;
- expected_behavior is the source-grounded behavior the evaluator should look for;
- checks are concrete observable checks for the evaluator.

The Eval Cases Node does not create regression cases. Regression is a historical set formed when a downstream evaluation identifies a failure worth protecting against. Keep development and held_out cases separate, make held_out cases genuinely new rather than surface rewrites of development cases, and ground every expected behavior in the Product or Corpus. A complete replacement is required on revision.`;

export const EVAL_CASES_CRITIC_SYSTEM_PROMPT = `You are the Eval Cases Generation Critic.

Your only job is to decide whether the Actor produced a useful, source-grounded evaluation set for the Product and Corpus. This is an internal quality loop. The Creator is outside this Node.

${EVAL_CASES_INPUT_PROTOCOL}

For each review, read candidate_ref first, then read product and corpus. Judge the candidate against these boundaries:
- every case tests the specified Product job rather than generic model ability;
- expected_behavior and checks are supported by the Product or Corpus and are observable;
- development and held_out are represented as separate splits;
- held_out cases are meaningfully different from development cases and do not simply change names or numbers;
- cases cover the important method, quality, missing-information, and boundary behavior that the Corpus actually contains;
- inputs are usable prompts or task payloads, while expected_behavior and checks remain evaluator-side material;
- case_id values are unique and each case is internally coherent;
- the candidate does not invent Creator facts, historical failures, unsupported rules, or a regression set.

Return exactly one verdict through submit_output:
- {"decision":"done"} when no material correction is needed;
- {"decision":"revise","feedback":"..."} when the Actor can correct the candidate from product, corpus, and the current candidate.

Feedback must identify the missing case family, unsupported expectation, split/leakage problem, or concrete case defect. Do not rewrite the cases. Do not ask the Creator and do not create a second human-interaction loop.`;

export const evalCasesNode: NodeDefinition<EvalCasesInput, EvalCasesOutput, string> = {
  name: "eval-cases",
  inputSchema: evalCasesInputSchema,
  actor: {
    systemPrompt: EVAL_CASES_ACTOR_SYSTEM_PROMPT,
    outputSchema: evalCasesOutputSchema,
    outputSchemaName: "eval_cases_output",
    sessionPolicy: "spawn",
    storageAccess: "read",
    renderInput: renderEvalCasesActorInput
  },
  critic: {
    systemPrompt: EVAL_CASES_CRITIC_SYSTEM_PROMPT,
    outputSchema: evalCasesCriticOutputSchema,
    outputSchemaName: "eval_cases_critic_verdict",
    sessionPolicy: "persistent",
    storageAccess: "read",
    renderInput: renderEvalCasesCriticInput
  }
};

function renderEvalCasesActorInput(
  value: NodeActorInput<EvalCasesInput, EvalCasesOutput, string>
): string {
  return JSON.stringify({
    round: value.round,
    input: value.input,
    previous_candidate_ref: value.previousCandidateRef,
    feedback_ref: value.feedbackRef
  }, null, 2);
}

function renderEvalCasesCriticInput(
  value: NodeCriticInput<EvalCasesInput, EvalCasesOutput>
): string {
  return JSON.stringify({
    round: value.round,
    input: value.input,
    candidate_ref: value.candidateRef
  }, null, 2);
}
