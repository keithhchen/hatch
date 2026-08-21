import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";

/** The namespace of one Node execution. */
export type NodeScope = {
  productId: string;
  nodeName: string;
  executionId: string;
};

const scopePartSchema = z.string().min(1).regex(/^[A-Za-z0-9._-]+$/);

/** A complete OSS object key used by a Node input manifest. */
export const nodeObjectPathSchema = z.string()
  .min(1)
  .max(512)
  .refine((value) => {
    try {
      normalizeNodeObjectPath(value);
      return true;
    } catch {
      return false;
    }
  }, "must be a safe OSS object path");

export function normalizeNodeObjectPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized.includes("://")
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`OSS object path must be a non-empty object key: ${value}`);
  }
  return normalized;
}

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
  /** Critic feedback is persisted by Runtime and read by reference. */
  feedbackRef?: string;
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
  // schemas. The Node Runtime exposes this as the argument schema of the
  // host-owned submit_output tool. It is not a business-quality gate.
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
  /** The normalized input manifest used by this execution. */
  input: unknown;
  output: Candidate;
  outputRef: string;
  rounds: readonly NodeRound<Candidate, Feedback>[];
  actorSessionIds: readonly string[];
  criticSessionIds: readonly string[];
};

export function defaultAgentInput(input: unknown): string {
  return JSON.stringify(input, null, 2);
}
