import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";

/** The namespace of one Node execution. */
export type NodeScope = {
  productId: string;
  nodeName: string;
  executionId: string;
};

const scopePartSchema = z.string().min(1).regex(/^[A-Za-z0-9._-]+$/);

/** Runtime boundary for the identity used by every Node read/write. */
export const nodeScopeSchema = z.object({
  productId: scopePartSchema,
  nodeName: scopePartSchema,
  executionId: scopePartSchema
}).strict();

export function parseNodeScope(raw: unknown): NodeScope {
  return nodeScopeSchema.parse(raw);
}

export type SessionPolicy = "spawn" | "persistent";

/** One generic Pi Agent configuration. Actor and Critic use this same shape. */
export type AgentConfig<Input, Output> = {
  systemPrompt: string;
  outputSchema: z.ZodType<Output>;
  outputSchemaName: string;
  /** The Node chooses whether this agent is recreated or resumed across rounds. */
  sessionPolicy: SessionPolicy;
  /** Storage access is an explicit per-instantiation capability. */
  storageAccess: "none" | "read" | "read_write";
  renderInput?: (input: Input) => string;
  tools?: readonly AgentTool[];
};

export type NodeActorInput<Input, Candidate, Feedback> = {
  input: Input;
  round: number;
  /** The previous candidate is persisted by Runtime and read by reference. */
  previousCandidateRef?: string;
  feedback?: Feedback;
};

export type NodeCriticInput<Input, Candidate> = {
  input: Input;
  round: number;
  /** The candidate is persisted by Runtime and read by reference. */
  candidateRef: string;
};

export type CriticVerdict<Feedback> =
  {
    decision: "done" | "revise";
    feedback?: Feedback;
  };

export function criticVerdictSchema<Feedback>(
  feedbackSchema: z.ZodType<Feedback>
): z.ZodType<CriticVerdict<Feedback>> {
  // Keep this a flat object. Kimi K2.6 is less reliable with oneOf/anyOf
  // schemas. This is passed to the provider as a response format. Runtime
  // does not use it as a quality gate for the model's output.
  return z.object({
    decision: z.enum(["done", "revise"]),
    feedback: feedbackSchema.optional()
  }).strict() as z.ZodType<CriticVerdict<Feedback>>;
}

export type NodeDefinition<Input, Candidate, Feedback> = {
  /** Stable name scope, for example `corpus` or `review`. */
  name: string;
  inputSchema: z.ZodType<Input>;
  actor: AgentConfig<NodeActorInput<Input, Candidate, Feedback>, Candidate>;
  critic: AgentConfig<NodeCriticInput<Input, Candidate>, CriticVerdict<Feedback>>;
};

export type NodeRound<Candidate, Feedback> = {
  round: number;
  candidate: Candidate;
  verdict: CriticVerdict<Feedback>;
};

export type NodeRunResult<Candidate, Feedback> = {
  status: "completed";
  output: Candidate;
  outputRef: string;
  rounds: readonly NodeRound<Candidate, Feedback>[];
  actorSessionIds: readonly string[];
  criticSessionIds: readonly string[];
};

export function defaultAgentInput(input: unknown): string {
  return JSON.stringify(input, null, 2);
}
