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

/** One generic Pi Agent configuration. Actor and Critic use this same shape. */
export type NodeSessionPolicy = "spawn" | "persistent";

export type AgentConfig<Input, Output> = {
  systemPrompt: string;
  outputSchema: z.ZodType<Output>;
  outputSchemaName: string;
  /** Storage access is an explicit per-instantiation capability. */
  storageAccess: "none" | "read";
  /** Runtime creates/resumes the session according to the Node's policy. */
  sessionPolicy: NodeSessionPolicy;
  renderInput?: (input: Input) => string;
  tools?: readonly AgentTool[];
};

export type NodeActorInput<Input> = {
  input: Input;
  round: number;
  /** Full OSS object path; the Actor reads the candidate through `read`. */
  previousCandidate?: string;
  /** Full OSS object path; the Actor reads the feedback through `read`. */
  feedback?: string;
};

export type NodeCriticInput<Input> = {
  input: Input;
  round: number;
  /** Full OSS object path; the Critic reads the candidate through `read`. */
  candidate: string;
};

export type CriticVerdict<Feedback> = {
  decision: "done" | "revise";
  feedback?: Feedback;
};

export function criticVerdictSchema<Feedback>(
  feedbackSchema: z.ZodType<Feedback>
): z.ZodType<CriticVerdict<Feedback>> {
  // Keep this a flat object. Kimi K2.6 is less reliable with oneOf/anyOf
  // schemas, while the Runtime can validate the decision-specific fields
  // after parsing the provider response.
  return z.object({
    decision: z.enum(["done", "revise"]),
    feedback: feedbackSchema.optional()
  }).strict() as z.ZodType<CriticVerdict<Feedback>>;
}

export type NodeDefinition<Input, Candidate, Feedback> = {
  /** Stable name scope, for example `corpus` or `review`. */
  name: string;
  inputSchema: z.ZodType<Input>;
  actor: AgentConfig<NodeActorInput<Input>, Candidate>;
  critic: AgentConfig<NodeCriticInput<Input>, CriticVerdict<Feedback>>;
};

export type NodeRound<Candidate, Feedback> = {
  round: number;
  candidate: Candidate;
  verdict: CriticVerdict<Feedback>;
};

export type NodeRunResult<Candidate, Feedback> = {
  status: "completed";
  output: Candidate;
  rounds: readonly NodeRound<Candidate, Feedback>[];
  actorSessionId: string;
  criticSessionId: string;
};

export function defaultAgentInput(input: unknown): string {
  return JSON.stringify(input, null, 2);
}
