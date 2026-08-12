import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentEvent,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult
} from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  CORPUS_ASSET_BEGIN_MARKER,
  CORPUS_ASSET_CONTENT_MARKER,
  CORPUS_ASSET_END_MARKER,
  CORPUS_COMPILATION_END_MARKER,
  parseCorpusCompilation,
  parseEvaluation,
  parseQuestions
} from "./markdown.js";
import type {
  FactoryOutputContract,
  FactoryPromptFailureTelemetry,
  FactoryPromptPurpose,
  FactorySubmissionToolName
} from "./types.js";

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const TOOL_IDENTIFIER = /^(?:hatch|creator)\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const REFERENCE_KINDS = new Set(["method", "style", "example", "few_shots"]);

type QuestionSubmission = {
  id: string;
  question: string;
  intent: string;
  leakageGroup: string;
};

type EvaluationSubmission = {
  pass: boolean;
  diagnosis: string;
  fewShot: string;
  corpusReflection: string;
};

type CorpusSkillSubmission = {
  id: string;
  name: string;
  whenToUse: string;
  allowedToolIds: string[];
  content: string;
};

type CorpusReferenceSubmission = {
  id: string;
  parentSkillId: string;
  referenceKind: "method" | "style" | "example" | "few_shots";
  content: string;
};

type CorpusKnowledgeSubmission = {
  id: string;
  sourceSummary: string;
  content: string;
};

type CorpusSubmission = {
  systemInstructions?: string;
  skills: CorpusSkillSubmission[];
  references: CorpusReferenceSubmission[];
  knowledge: CorpusKnowledgeSubmission[];
  auditSections: Partial<Record<"change_rationale" | "requirements_traceability" | "preservation_audit", string>>;
};

type Draft = {
  evidenceSections: Record<string, string>;
  questions: QuestionSubmission[];
  evaluation?: EvaluationSubmission;
  corpus: CorpusSubmission;
  finalized: boolean;
  output?: string;
};

type TurnState = {
  rawByIndex: Map<number, string>;
  rawByToolCallId: Map<string, string>;
  beforeFingerprint: string;
  hadError: boolean;
  topologyError?: BatchTopologyError;
  working?: Draft;
};

type BatchTopologyError =
  | "BATCH_FINALIZER_REQUIRED"
  | "BATCH_FINALIZER_DUPLICATE"
  | "BATCH_FINALIZER_MUST_BE_LAST"
  | "BATCH_RESTART_MUST_BE_FIRST"
  | "BATCH_RESTART_DUPLICATE"
  | "BATCH_UNKNOWN_TOOL";

type FinalizerOutcome = NonNullable<FactoryPromptFailureTelemetry["lastToolTurn"]>["finalizerOutcome"];

type SubmissionTelemetryState = Omit<FactoryPromptFailureTelemetry,
  "contractVersion" | "code" | "exactCycleKind"> & {
    exactCycleKind?: FactoryPromptFailureTelemetry["exactCycleKind"];
  };

type ToolReceipt = {
  content: Array<{ type: "text"; text: string }>;
  details: { status: "accepted" | "idempotent" | "rejected"; tool: string };
  terminate?: boolean;
};

export type FactorySubmissionProtocol = {
  readonly tools: AgentTool<any>[];
  readonly systemInstructions: string;
  observeAgentEvent(event: AgentEvent): void;
  beforeToolCall(context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined>;
  afterToolCall(context: AfterToolCallContext): Promise<AfterToolCallResult | undefined>;
  sanitizeContext(messages: AgentMessage[]): AgentMessage[];
  failureTelemetry(code: FactoryPromptFailureTelemetry["code"]): FactoryPromptFailureTelemetry;
  finalizedOutput(): string;
};

function emptyDraft(): Draft {
  return {
    evidenceSections: {},
    questions: [],
    corpus: { skills: [], references: [], knowledge: [], auditSections: {} },
    finalized: false
  };
}

function cloneDraft(value: Draft): Draft {
  return structuredClone(value);
}

function metadata(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be non-empty`);
  const normalized = value.trim();
  if (/[\r\n]/.test(normalized)) throw new Error(`${field} must be one line`);
  return normalized;
}

/** Long authored content is validated without normalization. */
function body(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be non-empty`);
  return value;
}

function shortReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\r\n]+/g, " ").slice(0, 180);
}

class SubmissionValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SubmissionValidationError";
  }
}

function validationFailure(error: unknown): { code: string; reason: string } {
  if (error instanceof SubmissionValidationError) {
    return { code: error.code, reason: shortReason(error) };
  }
  return { code: "FINAL_VALIDATION", reason: shortReason(error) };
}

const PRESERVATION_SECTIONS = [
  "Retained",
  "Added or changed",
  "Removed",
  "Merged",
  "Conflict resolutions",
  "Asset identity, path, or layer changes"
] as const;

function safeCorpusParserFailure(error: unknown): SubmissionValidationError {
  const message = error instanceof Error ? error.message : String(error);
  const exactFailures = new Map<string, readonly [string, string]>([
    [
      `Corpus compilation must contain asset blocks delimited by ${CORPUS_ASSET_BEGIN_MARKER}`,
      ["CORPUS_ASSET_BLOCKS_MISSING", "Corpus asset blocks are missing"]
    ],
    [
      "Corpus compilation must start with exactly one # Compiled cognitive assets heading",
      ["CORPUS_ROOT_HEADING_COUNT", "Corpus needs exactly one # Compiled cognitive assets heading"]
    ],
    [
      "Corpus compilation contains content outside asset blocks before # Change rationale",
      ["CORPUS_CONTENT_OUTSIDE_ASSET_BLOCKS", "Content exists outside an asset block before the audit envelope"]
    ],
    [
      `Corpus compilation is incomplete: # Compilation complete must end with ${CORPUS_COMPILATION_END_MARKER}`,
      ["CORPUS_COMPLETION_MARKER_INVALID", "Corpus needs the complete host-owned final marker"]
    ],
    [
      "Corpus compilation must contain exactly one system asset",
      ["CORPUS_SYSTEM_COUNT", "Corpus needs exactly one system asset"]
    ],
    [
      "Corpus compilation contains an incomplete asset marker block",
      ["CORPUS_ASSET_MARKER_INCOMPLETE", "An asset marker block is incomplete"]
    ],
    [
      "Corpus compilation has malformed or nested asset markers",
      ["CORPUS_ASSET_MARKER_NESTED", "Asset markers are malformed or nested inside authored content"]
    ],
    [
      "Corpus compilation contains content outside an asset block before the audit envelope",
      ["CORPUS_CONTENT_OUTSIDE_ASSET_BLOCKS", "Content exists outside an asset block before the audit envelope"]
    ],
    [
      "The first Corpus asset must be the system asset",
      ["CORPUS_SYSTEM_ORDER", "The system asset must be first"]
    ],
    [
      "Corpus assets must be ordered as system, skills, references, then knowledge",
      ["CORPUS_LAYER_ORDER", "Corpus assets must be ordered as system, skills, references, then knowledge"]
    ],
    [
      "Corpus system asset id must be system",
      ["CORPUS_SYSTEM_ID_INVALID", "The system asset ID must be system"]
    ]
  ]);
  const exact = exactFailures.get(message);
  if (exact) return new SubmissionValidationError(exact[0], exact[1]);

  const requiredSectionCount = /^Corpus compilation must contain exactly one # (Change rationale|Requirements traceability|Preservation audit|Compilation complete) section$/.exec(message);
  if (requiredSectionCount) {
    return new SubmissionValidationError(
      "CORPUS_ENVELOPE_SECTION_COUNT",
      `Corpus needs exactly one # ${requiredSectionCount[1]} section`
    );
  }
  const requiredSectionOrder = /^Corpus compilation sections are out of order near # (Change rationale|Requirements traceability|Preservation audit|Compilation complete)$/.exec(message);
  if (requiredSectionOrder) {
    return new SubmissionValidationError(
      "CORPUS_ENVELOPE_SECTION_ORDER",
      `Corpus envelope section is out of order: # ${requiredSectionOrder[1]}`
    );
  }
  const emptyAuditSection = /^Corpus compilation has no content under # (Change rationale|Requirements traceability|Preservation audit)$/.exec(message);
  if (emptyAuditSection) {
    return new SubmissionValidationError(
      "CORPUS_ENVELOPE_SECTION_EMPTY",
      `Corpus envelope section has no content: # ${emptyAuditSection[1]}`
    );
  }
  const emptyAsset = /^Corpus (system|skill|reference|knowledge|unknown) asset has empty content$/.exec(message);
  if (emptyAsset) {
    return new SubmissionValidationError(
      "CORPUS_ASSET_CONTENT_EMPTY",
      `Corpus ${emptyAsset[1]} asset has empty content`
    );
  }
  const duplicateId = /^Corpus compilation repeats asset id: ([a-z][a-z0-9_-]*)$/.exec(message);
  if (duplicateId) {
    return new SubmissionValidationError("CORPUS_ASSET_ID_DUPLICATE", `Corpus repeats asset ID ${duplicateId[1]}`);
  }
  const duplicatePath = /^Corpus compilation repeats asset path: ([A-Za-z0-9_./-]+)$/.exec(message);
  if (duplicatePath) {
    return new SubmissionValidationError("CORPUS_ASSET_PATH_DUPLICATE", `Corpus repeats asset path ${duplicatePath[1]}`);
  }
  const preservationCount = /^Preservation audit must contain exactly one ## (.+) section$/.exec(message);
  if (preservationCount && PRESERVATION_SECTIONS.includes(preservationCount[1] as typeof PRESERVATION_SECTIONS[number])) {
    return new SubmissionValidationError(
      "CORPUS_PRESERVATION_SECTION_COUNT",
      `Preservation audit needs exactly one ## ${preservationCount[1]} section`
    );
  }
  const preservationOrder = /^Preservation audit sections are out of order near ## (.+)$/.exec(message);
  if (preservationOrder && PRESERVATION_SECTIONS.includes(preservationOrder[1] as typeof PRESERVATION_SECTIONS[number])) {
    return new SubmissionValidationError(
      "CORPUS_PRESERVATION_SECTION_ORDER",
      `Preservation audit section is out of order: ## ${preservationOrder[1]}`
    );
  }
  const preservationEmpty = /^Preservation audit has no content under ## (.+)$/.exec(message);
  if (preservationEmpty && PRESERVATION_SECTIONS.includes(preservationEmpty[1] as typeof PRESERVATION_SECTIONS[number])) {
    return new SubmissionValidationError(
      "CORPUS_PRESERVATION_SECTION_EMPTY",
      `Preservation audit section has no content: ## ${preservationEmpty[1]}`
    );
  }
  const unknownParent = /^Corpus reference ([a-z][a-z0-9_-]*) has unknown parent skill: ([a-z][a-z0-9_-]*)$/.exec(message);
  if (unknownParent) {
    return new SubmissionValidationError(
      "CORPUS_REFERENCE_PARENT_UNKNOWN",
      `Reference ${unknownParent[1]} points to missing Skill ${unknownParent[2]}`
    );
  }
  if (/^Corpus asset metadata is malformed:/.test(message)) {
    return new SubmissionValidationError(
      "CORPUS_METADATA_MALFORMED",
      "Corpus asset metadata is malformed; inspect every submitted metadata field without reproducing its value"
    );
  }
  const repeatedMetadata = /^Corpus asset metadata repeats field: ([a-z_]+)$/.exec(message);
  if (repeatedMetadata) {
    return new SubmissionValidationError(
      "CORPUS_METADATA_FIELD_DUPLICATE",
      `Corpus asset metadata repeats field ${repeatedMetadata[1]}`
    );
  }
  const invalidLayer = /^Corpus asset has invalid layer:/.exec(message);
  if (invalidLayer) {
    return new SubmissionValidationError("CORPUS_LAYER_INVALID", "Corpus asset has an invalid layer");
  }
  const invalidReferenceKind = /^Corpus reference ([a-z][a-z0-9_-]*) has invalid reference kind:/.exec(message);
  if (invalidReferenceKind) {
    return new SubmissionValidationError(
      "CORPUS_REFERENCE_KIND_INVALID",
      `Reference ${invalidReferenceKind[1]} has an invalid reference kind`
    );
  }
  const retrievalFlag = /^Corpus knowledge ([a-z][a-z0-9_-]*) must declare retrieval_only: true$/.exec(message);
  if (retrievalFlag) {
    return new SubmissionValidationError(
      "CORPUS_KNOWLEDGE_RETRIEVAL_FLAG",
      `Knowledge ${retrievalFlag[1]} must be retrieval-only`
    );
  }
  const unknownMetadata = /^Corpus asset metadata has unknown field: ([a-z_]+)$/.exec(message);
  if (unknownMetadata) {
    return new SubmissionValidationError(
      "CORPUS_METADATA_FIELD_UNKNOWN",
      `Corpus asset metadata has unknown field ${unknownMetadata[1]}`
    );
  }
  const missingMetadata = /^Corpus asset metadata is missing non-empty field: ([a-z_]+)$/.exec(message);
  if (missingMetadata) {
    return new SubmissionValidationError(
      "CORPUS_METADATA_FIELD_MISSING",
      `Corpus asset metadata is missing field ${missingMetadata[1]}`
    );
  }
  if (/ must be a lowercase Agent Corpus identifier$/.test(message)) {
    return new SubmissionValidationError(
      "CORPUS_IDENTIFIER_INVALID",
      "A Corpus asset or relationship ID is not a lowercase Agent Corpus identifier"
    );
  }
  const malformedTools = /^Corpus skill ([a-z][a-z0-9_-]*) has malformed allowed_tool_ids$/.exec(message);
  if (malformedTools) {
    return new SubmissionValidationError(
      "CORPUS_TOOL_LIST_MALFORMED",
      `Skill ${malformedTools[1]} has malformed allowed tool IDs`
    );
  }
  const invalidTool = /^Corpus skill ([a-z][a-z0-9_-]*) has invalid tool id:/.exec(message);
  if (invalidTool) {
    return new SubmissionValidationError("CORPUS_TOOL_ID_INVALID", `Skill ${invalidTool[1]} has an invalid tool ID`);
  }
  const duplicateTool = /^Corpus skill ([a-z][a-z0-9_-]*) repeats allowed tool id:/.exec(message);
  if (duplicateTool) {
    return new SubmissionValidationError(
      "CORPUS_TOOL_ID_DUPLICATE",
      `Skill ${duplicateTool[1]} repeats an allowed tool ID`
    );
  }
  const unavailableTool = /^Corpus skill ([a-z][a-z0-9_-]*) references unavailable tool id:/.exec(message);
  if (unavailableTool) {
    return new SubmissionValidationError(
      "CORPUS_TOOL_ID_UNAVAILABLE",
      `Skill ${unavailableTool[1]} references an unavailable tool ID`
    );
  }
  return new SubmissionValidationError(
    "CORPUS_CANONICAL_INVALID",
    "Canonical Corpus contract rejected; inspect the complete asset metadata, relationships, and audit envelope"
  );
}

function receipt(
  tool: string,
  status: ToolReceipt["details"]["status"],
  message: string,
  terminate = false
): ToolReceipt {
  return {
    content: [{ type: "text", text: message }],
    details: { status, tool },
    ...(terminate ? { terminate: true } : {})
  };
}

function same<T>(left: T, right: T): boolean {
  return isDeepStrictEqual(left, right);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)])
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function addUnique<T>(
  rows: T[],
  candidate: T,
  key: (row: T) => string,
  label: string
): "accepted" | "idempotent" {
  const id = key(candidate);
  const existing = rows.find((row) => key(row) === id);
  if (!existing) {
    rows.push(candidate);
    return "accepted";
  }
  if (same(existing, candidate)) return "idempotent";
  throw new Error(`${label} ${id} conflicts with an earlier submission; finalize/restart with a complete replacement`);
}

function singleton<T>(existing: T | undefined, candidate: T, label: string): "accepted" | "idempotent" {
  if (existing === undefined) return "accepted";
  if (same(existing, candidate)) return "idempotent";
  throw new Error(`${label} conflicts with an earlier submission; finalize/restart with a complete replacement`);
}

function renderQuestions(rows: QuestionSubmission[]): string {
  return [
    "# Generated Creator questions",
    "",
    ...rows.flatMap((row) => [
      `## ${row.id}`,
      "",
      "### Question",
      "",
      row.question,
      "",
      "### Why this question",
      "",
      row.intent,
      "",
      "### Leakage group",
      "",
      row.leakageGroup,
      ""
    ])
  ].join("\n");
}

function renderEvaluation(value: EvaluationSubmission): string {
  return [
    "## Verdict",
    value.pass ? "PASS" : "FAIL",
    "## Diagnosis",
    value.diagnosis,
    "## Few-shot candidate",
    value.fewShot,
    "## Corpus reflection",
    value.corpusReflection
  ].join("\n");
}

function renderAsset(metadata: string[], content: string): string {
  return [
    CORPUS_ASSET_BEGIN_MARKER,
    ...metadata,
    CORPUS_ASSET_CONTENT_MARKER,
    content,
    CORPUS_ASSET_END_MARKER
  ].join("\n");
}

function renderCorpus(value: CorpusSubmission): string {
  const system = renderAsset(["layer: system", "id: system"], value.systemInstructions!);
  const skills = value.skills.map((item) => renderAsset([
    "layer: skill",
    `id: ${item.id}`,
    `name: ${item.name}`,
    `when_to_use: ${item.whenToUse}`,
    `allowed_tool_ids: ${item.allowedToolIds.length > 0 ? item.allowedToolIds.join(", ") : "[]"}`
  ], item.content));
  const references = value.references.map((item) => renderAsset([
    "layer: reference",
    `id: ${item.id}`,
    `parent_skill_id: ${item.parentSkillId}`,
    `reference_kind: ${item.referenceKind}`
  ], item.content));
  const knowledge = value.knowledge.map((item) => renderAsset([
    "layer: knowledge",
    `id: ${item.id}`,
    `source_summary: ${item.sourceSummary}`,
    "retrieval_only: true"
  ], item.content));
  return [
    "# Compiled cognitive assets",
    system,
    ...skills,
    ...references,
    ...knowledge,
    "# Change rationale",
    value.auditSections.change_rationale!,
    "# Requirements traceability",
    value.auditSections.requirements_traceability!,
    "# Preservation audit",
    value.auditSections.preservation_audit!,
    "# Compilation complete",
    CORPUS_COMPILATION_END_MARKER
  ].join("\n");
}

function normalizeContract(
  purpose: FactoryPromptPurpose,
  contract: FactoryOutputContract | undefined
): FactoryOutputContract {
  const expectedKind: Record<FactoryPromptPurpose, FactoryOutputContract["kind"]> = {
    "evidence.extract": "evidence_ledger",
    "eval.generate_questions": "question_set",
    "eval.judge_result": "evaluation_verdict",
    "eval.audit_corpus": "corpus_audit",
    "corpus.compile": "corpus_compilation"
  };
  if (!contract) {
    if (purpose === "eval.judge_result") return { kind: "evaluation_verdict" };
    if (purpose === "eval.audit_corpus") return { kind: "corpus_audit" };
    throw new Error(`Factory ${purpose} requires an explicit outputContract`);
  }
  if (contract.kind !== expectedKind[purpose]) {
    throw new Error(`Factory ${purpose} cannot use ${contract.kind} outputContract`);
  }
  if (contract.kind === "question_set" && (!Number.isInteger(contract.expectedCount) || contract.expectedCount < 1)) {
    throw new Error("question_set expectedCount must be a positive integer");
  }
  if (contract.kind === "evidence_ledger") {
    const seen = new Set<string>();
    for (const section of contract.requiredSections) {
      if (!section.trim() || /[\r\n]/.test(section) || seen.has(section)) {
        throw new Error(`Invalid or duplicate required Evidence section: ${section}`);
      }
      seen.add(section);
    }
    if (seen.size < 1) throw new Error("evidence_ledger requires at least one section");
  }
  if (contract.kind === "corpus_compilation") {
    const seen = new Set<string>();
    for (const id of contract.availableToolIds) {
      if (!TOOL_IDENTIFIER.test(id) || seen.has(id)) throw new Error(`Invalid or duplicate available tool id: ${id}`);
      seen.add(id);
    }
  }
  return contract;
}

function instructionsFor(contract: FactoryOutputContract): string {
  const shared = `Your output is accepted only through the local submission tools supplied with this call. Tool calls are a typed handoff to the host, not external actions. Do not print the requested artifact as assistant prose and do not wrap tool arguments in code fences. First complete your private reasoning and the entire artifact before emitting any tool call. Every tool-calling assistant turn is one atomic batch and must contain exactly one matching finalize call as its last call; do not wait for receipts between parts. An optional restart_submission may appear at most once and only as the first call. Submit/restart receipts are STAGED, not committed: FINALIZED means the complete batch committed; any tool error means the whole batch rolled back and the previous committed draft was preserved; a rejected finalizer means the whole replacement was rejected and the draft was cleared. Use another tool-calling turn only after rejected or error feedback, and then resubmit the complete replacement plus finalizer in that same batch, never an affected-item patch. After FINALIZED, stop immediately without prose or another tool call.`;
  if (contract.kind === "question_set") return `${shared}\nSubmit exactly ${contract.expectedCount} complete questions, then finalize_questions.`;
  if (contract.kind === "evidence_ledger") {
    return `${shared}\nSubmit every Evidence section separately, then finalize_evidence. Required sections, in host-rendered order: ${contract.requiredSections.join("; ")}.`;
  }
  if (contract.kind === "corpus_compilation") {
    return `${shared}\nPaths, manifests, and digests are host-derived: never submit them. Re-emit the complete System and every retained Skill/reference/knowledge asset. Submit all three audit sections separately, then finalize_corpus. Allowed runtime tool IDs are exactly: ${contract.availableToolIds.length > 0 ? contract.availableToolIds.join(", ") : "none"}.`;
  }
  return shared;
}

/**
 * Build a side-effect-free, turn-transactional submission FSM for one Factory
 * call. Tool execution only mutates a turn-local clone. The clone is committed
 * at turn_end iff every call in that assistant batch succeeded, so a malformed
 * later call cannot leave an earlier submission behind.
 */
export function createFactorySubmissionProtocol(
  purpose: FactoryPromptPurpose,
  requestedContract?: FactoryOutputContract
): FactorySubmissionProtocol {
  const contract = normalizeContract(purpose, requestedContract);
  const finalizerName = contract.kind === "evidence_ledger"
    ? "finalize_evidence"
    : contract.kind === "question_set"
      ? "finalize_questions"
      : contract.kind === "evaluation_verdict"
        ? "finalize_evaluation"
      : contract.kind === "corpus_audit"
          ? "finalize_corpus_audit"
          : "finalize_corpus";
  let committed = emptyDraft();
  let turn: TurnState | undefined;
  const seenTransitions = new Set<string>();
  const telemetry: SubmissionTelemetryState = {
    turnsObserved: 0,
    toolTurnsObserved: 0,
    toolCallsRequested: 0,
    toolResultsObserved: 0,
    toolErrorsObserved: 0
  };
  const tools: AgentTool<any>[] = [];

  const inventory = (draft: Draft): string => {
    if (contract.kind === "evidence_ledger") {
      return `evidence_sections=${Object.keys(draft.evidenceSections).length}/${contract.requiredSections.length}; next=${finalizerName}`;
    }
    if (contract.kind === "question_set") {
      return `questions=${draft.questions.length}/${contract.expectedCount}; next=${finalizerName}`;
    }
    if (contract.kind === "evaluation_verdict" || contract.kind === "corpus_audit") {
      return `evaluation=${draft.evaluation ? 1 : 0}/1; next=${finalizerName}`;
    }
    const auditCount = Object.keys(draft.corpus.auditSections).length;
    return [
      `system=${draft.corpus.systemInstructions ? 1 : 0}/1`,
      `skills=${draft.corpus.skills.length}`,
      `references=${draft.corpus.references.length}`,
      `knowledge=${draft.corpus.knowledge.length}`,
      `audit_sections=${auditCount}/3`,
      `next=${finalizerName}`
    ].join("; ");
  };

  const staged = (
    tool: string,
    status: "accepted" | "idempotent",
    label: string,
    draft: Draft
  ): ToolReceipt => receipt(
    tool,
    status,
    `STAGED status=${status.toUpperCase()} ${label}; ${inventory(draft)}; pending atomic batch commit`
  );

  const knownToolName = (value: string): value is FactorySubmissionToolName => (
    tools.some((tool) => tool.name === value)
  );

  const topologyError = (names: string[]): BatchTopologyError | undefined => {
    if (names.some((name) => !knownToolName(name))) return "BATCH_UNKNOWN_TOOL";
    const finalizers = names.reduce<number[]>((rows, name, index) => (
      name === finalizerName ? [...rows, index] : rows
    ), []);
    if (finalizers.length === 0) return "BATCH_FINALIZER_REQUIRED";
    if (finalizers.length > 1) return "BATCH_FINALIZER_DUPLICATE";
    if (finalizers[0] !== names.length - 1) return "BATCH_FINALIZER_MUST_BE_LAST";
    const restarts = names.reduce<number[]>((rows, name, index) => (
      name === "restart_submission" ? [...rows, index] : rows
    ), []);
    if (restarts.length > 1) return "BATCH_RESTART_DUPLICATE";
    if (restarts.length === 1 && restarts[0] !== 0) return "BATCH_RESTART_MUST_BE_FIRST";
    return undefined;
  };

  const safeToolError = (code: string): string => (
    `BATCH_REJECTED code=${code}; whole turn rolled back; previous committed draft preserved; resubmit complete replacement and ${finalizerName}`
  );

  const working = (): Draft => {
    if (!turn) throw new Error("Submission tool called outside an active Agent turn");
    turn.working ??= cloneDraft(committed);
    if (turn.working.finalized) throw new Error("Submission is FINALIZED and frozen");
    return turn.working;
  };

  const makeTool = (
    name: string,
    description: string,
    parameters: ReturnType<typeof Type.Object>,
    apply: (draft: Draft, params: Record<string, unknown>) => ToolReceipt
  ): AgentTool<any> => ({
    name,
    label: name,
    description,
    parameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => apply(working(), params as Record<string, unknown>)
  });

  const noArgs = Type.Object({}, { additionalProperties: false });
  const text = Type.String();

  tools.push(makeTool(
    "restart_submission",
    "Discard the current non-finalized draft before submitting a complete replacement. Never use this as a patch operation.",
    noArgs,
    (_draft) => {
      turn!.working = emptyDraft();
      return staged(
        "restart_submission",
        "accepted",
        `restart requested; submit complete replacement then ${finalizerName}`,
        turn!.working
      );
    }
  ));

  const finalize = (tool: string, validate: (draft: Draft) => string): ToolReceipt => {
    const draft = working();
    if (turn!.hadError) {
      return receipt(
        tool,
        "rejected",
        safeToolError("BATCH_PRIOR_TOOL_ERROR")
      );
    }
    try {
      const output = validate(draft);
      draft.finalized = true;
      draft.output = output;
      return receipt(tool, "accepted", `FINALIZED; atomic batch accepted; ${inventory(draft)}`, true);
    } catch (error) {
      const failure = validationFailure(error);
      // A rejected finalization starts a new attempt. This is deliberately a
      // successful tool receipt so the turn can atomically commit the reset.
      turn!.working = emptyDraft();
      return receipt(
        tool,
        "rejected",
        `REJECTED code=${failure.code}; draft cleared; resubmit complete replacement and ${finalizerName}. ${failure.reason}`
      );
    }
  };

  if (contract.kind === "evidence_ledger") {
    tools.push(makeTool(
      "submit_evidence_section",
      "Submit one complete required Evidence section as readable Markdown. Repeat for every required section.",
      Type.Object({ section: Type.Union(contract.requiredSections.map((section) => Type.Literal(section))), markdown: text }, { additionalProperties: false }),
      (draft, params) => {
        const section = metadata(params.section, "section");
        const markdown = body(params.markdown, "markdown");
        const status = singleton(draft.evidenceSections[section], markdown, `Evidence section ${section}`);
        if (status === "accepted") draft.evidenceSections[section] = markdown;
        return staged("submit_evidence_section", status, "evidence section", draft);
      }
    ));
    tools.push(makeTool(
      "finalize_evidence",
      "Finalize only after the complete evidence ledger has been submitted.",
      noArgs,
      () => finalize("finalize_evidence", (candidate) => {
        const missing = contract.requiredSections.filter((section) => !candidate.evidenceSections[section]);
        const extra = Object.keys(candidate.evidenceSections).filter((section) => !contract.requiredSections.includes(section));
        if (missing.length > 0 || extra.length > 0) {
          throw new SubmissionValidationError(
            "EVIDENCE_SECTION_COUNT",
            `Evidence sections mismatch; missing=${missing.length}; extra=${extra.length}`
          );
        }
        return [
          "# Evidence ledger",
          "",
          ...contract.requiredSections.flatMap((section) => [
            `## ${section}`,
            "",
            candidate.evidenceSections[section]!,
            ""
          ])
        ].join("\n");
      })
    ));
  }

  if (contract.kind === "question_set") {
    tools.push(makeTool(
      "submit_question",
      "Submit one complete generated Creator question. Repeat for every question before finalizing.",
      Type.Object({
        id: text,
        question: text,
        intent: text,
        leakage_group: text
      }, { additionalProperties: false }),
      (draft, params) => {
        const candidate: QuestionSubmission = {
          id: metadata(params.id, "id"),
          question: body(params.question, "question"),
          intent: body(params.intent, "intent"),
          leakageGroup: metadata(params.leakage_group, "leakage_group")
        };
        const status = addUnique(draft.questions, candidate, (item) => item.id, "Question");
        return staged("submit_question", status, "question", draft);
      }
    ));
    tools.push(makeTool(
      "finalize_questions",
      `Finalize only after exactly ${contract.expectedCount} complete questions have been submitted.`,
      noArgs,
      () => finalize("finalize_questions", (draft) => {
        if (draft.questions.length !== contract.expectedCount) {
          throw new SubmissionValidationError(
            "QUESTION_COUNT_MISMATCH",
            `Expected ${contract.expectedCount} questions; received ${draft.questions.length}`
          );
        }
        const output = renderQuestions(draft.questions);
        try {
          if (parseQuestions(output).length !== contract.expectedCount) throw new Error("count mismatch");
        } catch {
          throw new SubmissionValidationError(
            "QUESTION_CANONICAL_INVALID",
            "Canonical question contract rejected; check IDs and required fields"
          );
        }
        return output;
      })
    ));
  }

  if (contract.kind === "evaluation_verdict" || contract.kind === "corpus_audit") {
    const audit = contract.kind === "corpus_audit";
    tools.push(makeTool(
      audit ? "submit_corpus_audit" : "submit_evaluation",
      audit
        ? "Submit the complete Corpus audit verdict, diagnosis, and durable corpus reflection."
        : "Submit the complete result evaluation verdict and reflection.",
      audit
        ? Type.Object({ pass: Type.Boolean(), diagnosis: text, corpus_reflection: text }, { additionalProperties: false })
        : Type.Object({
            pass: Type.Boolean(),
            diagnosis: text,
            few_shot: text,
            corpus_reflection: text
          }, { additionalProperties: false }),
      (draft, params) => {
        const candidate: EvaluationSubmission = {
          pass: params.pass === true,
          diagnosis: body(params.diagnosis, "diagnosis"),
          fewShot: audit ? "None — this audit does not create a runtime few-shot." : body(params.few_shot, "few_shot"),
          corpusReflection: body(params.corpus_reflection, "corpus_reflection")
        };
        const status = singleton(draft.evaluation, candidate, "Evaluation");
        if (status === "accepted") draft.evaluation = candidate;
        const name = audit ? "submit_corpus_audit" : "submit_evaluation";
        return staged(name, status, "evaluation", draft);
      }
    ));
    const finalizer = audit ? "finalize_corpus_audit" : "finalize_evaluation";
    tools.push(makeTool(
      finalizer,
      "Finalize only after the complete verdict has been submitted.",
      noArgs,
      () => finalize(finalizer, (draft) => {
        if (!draft.evaluation) {
          throw new SubmissionValidationError("EVALUATION_MISSING", "Evaluation verdict is missing");
        }
        const output = renderEvaluation(draft.evaluation);
        try {
          parseEvaluation(output);
        } catch {
          throw new SubmissionValidationError(
            "EVALUATION_CANONICAL_INVALID",
            "Canonical evaluation contract rejected; check every required field"
          );
        }
        return output;
      })
    ));
  }

  if (contract.kind === "corpus_compilation") {
    const available = new Set(contract.availableToolIds);
    tools.push(makeTool(
      "submit_system_instructions",
      "Submit the complete replacement for instructions/system.md. The host derives its path.",
      Type.Object({ content: text }, { additionalProperties: false }),
      (draft, params) => {
        const content = body(params.content, "content");
        const status = singleton(draft.corpus.systemInstructions, content, "System instructions");
        if (status === "accepted") draft.corpus.systemInstructions = content;
        return staged("submit_system_instructions", status, "system", draft);
      }
    ));
    tools.push(makeTool(
      "submit_skill",
      "Submit one complete Skill. id determines skills/<id>/SKILL.md; never submit a path.",
      Type.Object({
        id: text,
        name: text,
        when_to_use: text,
        allowed_tool_ids: Type.Array(text),
        content: text
      }, { additionalProperties: false }),
      (draft, params) => {
        const id = metadata(params.id, "id");
        if (!IDENTIFIER.test(id)) throw new Error(`Invalid Skill id: ${id}`);
        const allowedToolIds = (params.allowed_tool_ids as unknown[]).map((value) => metadata(value, "allowed_tool_ids item"));
        if (new Set(allowedToolIds).size !== allowedToolIds.length) throw new Error(`Skill ${id} repeats an allowed tool id`);
        for (const toolId of allowedToolIds) {
          if (!available.has(toolId)) throw new Error(`Skill ${id} references unavailable tool id: ${toolId}`);
        }
        const candidate: CorpusSkillSubmission = {
          id,
          name: metadata(params.name, "name"),
          whenToUse: metadata(params.when_to_use, "when_to_use"),
          allowedToolIds,
          content: body(params.content, "content")
        };
        const status = addUnique(draft.corpus.skills, candidate, (item) => item.id, "Skill");
        return staged("submit_skill", status, "skill", draft);
      }
    ));
    tools.push(makeTool(
      "submit_reference",
      "Submit one complete Skill-local reference. The host derives its path from parent_skill_id and id.",
      Type.Object({
        id: text,
        parent_skill_id: text,
        reference_kind: Type.Union([
          Type.Literal("method"),
          Type.Literal("style"),
          Type.Literal("example"),
          Type.Literal("few_shots")
        ]),
        content: text
      }, { additionalProperties: false }),
      (draft, params) => {
        const id = metadata(params.id, "id");
        const parentSkillId = metadata(params.parent_skill_id, "parent_skill_id");
        const referenceKind = metadata(params.reference_kind, "reference_kind");
        if (!IDENTIFIER.test(id) || !IDENTIFIER.test(parentSkillId) || !REFERENCE_KINDS.has(referenceKind)) {
          throw new Error(`Invalid reference metadata for ${id}`);
        }
        const candidate: CorpusReferenceSubmission = {
          id,
          parentSkillId,
          referenceKind: referenceKind as CorpusReferenceSubmission["referenceKind"],
          content: body(params.content, "content")
        };
        const status = addUnique(draft.corpus.references, candidate, (item) => item.id, "Reference");
        return staged("submit_reference", status, "reference", draft);
      }
    ));
    tools.push(makeTool(
      "submit_knowledge",
      "Submit one complete purified retrieval-only knowledge document. The host derives knowledge/<id>.md.",
      Type.Object({ id: text, source_summary: text, content: text }, { additionalProperties: false }),
      (draft, params) => {
        const id = metadata(params.id, "id");
        if (!IDENTIFIER.test(id)) throw new Error(`Invalid knowledge id: ${id}`);
        const candidate: CorpusKnowledgeSubmission = {
          id,
          sourceSummary: metadata(params.source_summary, "source_summary"),
          content: body(params.content, "content")
        };
        const status = addUnique(draft.corpus.knowledge, candidate, (item) => item.id, "Knowledge");
        return staged("submit_knowledge", status, "knowledge", draft);
      }
    ));
    tools.push(makeTool(
      "submit_corpus_audit_section",
      "Submit one complete compiler audit section. Submit all three sections before finalizing.",
      Type.Object({
        section: Type.Union([
          Type.Literal("change_rationale"),
          Type.Literal("requirements_traceability"),
          Type.Literal("preservation_audit")
        ]),
        markdown: text
      }, { additionalProperties: false }),
      (draft, params) => {
        const section = params.section as keyof CorpusSubmission["auditSections"];
        const markdown = body(params.markdown, "markdown");
        const status = singleton(draft.corpus.auditSections[section], markdown, `Audit section ${section}`);
        if (status === "accepted") draft.corpus.auditSections[section] = markdown;
        return staged("submit_corpus_audit_section", status, `audit section=${section}`, draft);
      }
    ));
    tools.push(makeTool(
      "finalize_corpus",
      "Finalize only after the complete replacement asset set and all audit sections have been submitted.",
      noArgs,
      () => finalize("finalize_corpus", (draft) => {
        if (!draft.corpus.systemInstructions) {
          throw new SubmissionValidationError("CORPUS_SYSTEM_MISSING", "System instructions are missing");
        }
        for (const section of ["change_rationale", "requirements_traceability", "preservation_audit"] as const) {
          if (!draft.corpus.auditSections[section]) {
            throw new SubmissionValidationError(
              "CORPUS_AUDIT_SECTION_MISSING",
              `Corpus audit section is missing: ${section}`
            );
          }
        }
        const ids = [
          ...draft.corpus.skills.map((item) => item.id),
          ...draft.corpus.references.map((item) => item.id),
          ...draft.corpus.knowledge.map((item) => item.id)
        ];
        if (new Set(ids).size !== ids.length) {
          throw new SubmissionValidationError(
            "CORPUS_ASSET_ID_DUPLICATE",
            "Corpus asset IDs must be globally unique"
          );
        }
        const output = renderCorpus(draft.corpus);
        try {
          parseCorpusCompilation(output, { availableToolIds: contract.availableToolIds });
        } catch (error) {
          throw safeCorpusParserFailure(error);
        }
        return output;
      })
    ));
  }

  return {
    tools,
    systemInstructions: instructionsFor(contract),
    observeAgentEvent(event): void {
      if (event.type === "turn_start") {
        turn = {
          rawByIndex: new Map(),
          rawByToolCallId: new Map(),
          beforeFingerprint: fingerprint(committed),
          hadError: false
        };
        return;
      }
      if (!turn) return;
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "toolcall_start") {
          turn.rawByIndex.set(update.contentIndex, "");
        } else if (update.type === "toolcall_delta") {
          turn.rawByIndex.set(update.contentIndex, (turn.rawByIndex.get(update.contentIndex) ?? "") + update.delta);
        } else if (update.type === "toolcall_end") {
          turn.rawByToolCallId.set(update.toolCall.id, turn.rawByIndex.get(update.contentIndex) ?? "");
        }
        return;
      }
      if (event.type === "message_end") {
        if (event.message.role === "assistant") {
          const names = event.message.content.flatMap((item) => item.type === "toolCall" ? [item.name] : []);
          if (names.length > 0) turn.topologyError = topologyError(names);
        } else if (event.message.role === "toolResult" && event.message.isError) {
          // Immediate framework/preflight failures bypass afterToolCall. This
          // event is still emitted before the next sequential tool executes, so
          // it is the authoritative transaction error latch for the finalizer.
          turn.hadError = true;
        }
        return;
      }
      if (event.type === "turn_end") {
        const activeTurn = turn;
        const failed = event.toolResults.some((result) => result.isError);
        const candidate = !failed && activeTurn.working ? activeTurn.working : committed;
        const toolCalls = event.message.role === "assistant"
          ? event.message.content.flatMap((item) => item.type === "toolCall"
            ? [{ name: item.name, arguments: item.arguments }]
            : [])
          : [];
        telemetry.turnsObserved += 1;
        if (toolCalls.length > 0) {
          telemetry.toolTurnsObserved += 1;
          telemetry.toolCallsRequested += toolCalls.length;
          telemetry.toolResultsObserved += event.toolResults.length;
          telemetry.toolErrorsObserved += event.toolResults.filter((result) => result.isError).length;
          const statuses = event.toolResults.map((result) => {
            const details = result.details;
            if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
            const status = (details as Record<string, unknown>).status;
            return status === "accepted" || status === "idempotent" || status === "rejected"
              ? status
              : undefined;
          });
          const finalizerIndexes = toolCalls.reduce<number[]>((rows, call, index) => (
            call.name === finalizerName ? [...rows, index] : rows
          ), []);
          let finalizerOutcome: FinalizerOutcome = "absent";
          if (finalizerIndexes.length === 1) {
            const result = event.toolResults[finalizerIndexes[0]!];
            const status = statuses[finalizerIndexes[0]!];
            finalizerOutcome = result?.isError
              ? "error"
              : status === "accepted" || status === "rejected"
                ? status
                : "error";
          } else if (finalizerIndexes.length > 1) {
            finalizerOutcome = "error";
          }
          const lastToolTurn: NonNullable<FactoryPromptFailureTelemetry["lastToolTurn"]> = {
            callsRequested: toolCalls.length,
            results: event.toolResults.length,
            errors: event.toolResults.filter((result) => result.isError).length,
            accepted: statuses.filter((status) => status === "accepted").length,
            idempotent: statuses.filter((status) => status === "idempotent").length,
            rejected: statuses.filter((status) => status === "rejected").length,
            toolNames: [...new Set(toolCalls.flatMap((call) => knownToolName(call.name) ? [call.name] : []))],
            finalizerOutcome,
            finalizerPosition: finalizerIndexes.length === 0
              ? "absent"
              : finalizerIndexes.length > 1
                ? "multiple"
                : finalizerIndexes[0] === toolCalls.length - 1
                  ? "last"
                  : "not_last",
            transaction: failed
              ? "rolled_back"
              : candidate.finalized
                ? "finalized"
                : activeTurn.working
                  ? "cleared"
                  : "no_draft"
          };
          telemetry.lastToolTurn = lastToolTurn;
        }
        if (toolCalls.length > 0 && !candidate.finalized) {
          const transition = fingerprint({
            before: activeTurn.beforeFingerprint,
            calls: toolCalls,
            results: event.toolResults.map((result) => ({
              toolName: knownToolName(result.toolName) ? result.toolName : "unknown",
              isError: result.isError,
              status: result.details && typeof result.details === "object" && !Array.isArray(result.details)
                ? (result.details as Record<string, unknown>).status
                : undefined
            })),
            after: fingerprint(candidate)
          });
          if (seenTransitions.has(transition)) {
            const last = telemetry.lastToolTurn;
            telemetry.exactCycleKind = last?.finalizerOutcome === "absent"
              ? "missing_finalizer"
              : (last?.errors ?? 0) > 0 || last?.finalizerOutcome === "error"
                ? "repeated_batch_error"
                : last?.finalizerOutcome === "rejected"
                  ? "repeated_final_validation"
                  : "repeated_no_progress";
            turn = undefined;
            throw new Error(
              `Factory ${purpose} detected an exact submission tool cycle before FINALIZED`
            );
          }
          seenTransitions.add(transition);
        }
        if (!failed && activeTurn.working) committed = activeTurn.working;
        turn = undefined;
      }
    },
    async beforeToolCall(context): Promise<BeforeToolCallResult | undefined> {
      if (!turn) return { block: true, reason: safeToolError("TURN_STATE_MISSING") };
      if (turn.topologyError) {
        return { block: true, reason: safeToolError(turn.topologyError) };
      }
      const raw = turn?.rawByToolCallId.get(context.toolCall.id);
      if (raw === undefined || !raw.trim()) {
        return { block: true, reason: safeToolError("RAW_ARGUMENTS_MISSING") };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { block: true, reason: safeToolError("RAW_ARGUMENTS_INVALID_JSON") };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { block: true, reason: safeToolError("RAW_ARGUMENTS_NOT_OBJECT") };
      }
      if (!isDeepStrictEqual(parsed, context.args) || !isDeepStrictEqual(parsed, context.toolCall.arguments)) {
        return { block: true, reason: safeToolError("RAW_ARGUMENTS_MISMATCH") };
      }
      return undefined;
    },
    async afterToolCall(context): Promise<AfterToolCallResult | undefined> {
      if (context.isError) {
        if (turn) turn.hadError = true;
        const raw = context.result.content
          .flatMap((item) => item.type === "text" ? [item.text] : [])
          .join(" ");
        const code = /conflicts with an earlier submission/i.test(raw)
          ? "SUBMISSION_CONFLICT"
          : "TOOL_EXECUTION_ERROR";
        return {
          content: [{ type: "text", text: safeToolError(code) }],
          details: { status: "error" },
          isError: true,
          terminate: false
        };
      }
      const batchHasFinalizer = context.assistantMessage.content.some(
        (item) => item.type === "toolCall" && item.name === finalizerName
      );
      if (!batchHasFinalizer) return undefined;
      const details = context.result.details;
      if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
      const status = (details as Record<string, unknown>).status;
      // Pi stops a tool batch only when every result terminates. Mark each
      // successful sibling of an included finalizer so an accepted mixed batch
      // ends immediately. Rejected finalizers and error results remain false,
      // preserving the repair turn and the transactional rollback semantics.
      return status === "accepted" || status === "idempotent"
        ? { terminate: true }
        : undefined;
    },
    sanitizeContext(messages): AgentMessage[] {
      return messages.map((message) => {
        if (message.role !== "toolResult" || !message.isError) return message;
        const raw = message.content
          .flatMap((item) => item.type === "text" ? [item.text] : [])
          .join(" ");
        const explicit = /BATCH_REJECTED code=([A-Z][A-Z0-9_]*)/.exec(raw)?.[1];
        const code = explicit
          ?? (/output token limit/i.test(raw)
            ? "PROVIDER_OUTPUT_TRUNCATED"
            : /Validation failed for tool/i.test(raw)
              ? "TOOL_ARGUMENT_INVALID"
              : /not found/i.test(raw)
                ? "BATCH_UNKNOWN_TOOL"
                : "TOOL_ERROR");
        return {
          ...message,
          content: [{ type: "text", text: safeToolError(code) }],
          details: { status: "error" }
        };
      });
    },
    failureTelemetry(code): FactoryPromptFailureTelemetry {
      return {
        contractVersion: "1",
        code,
        turnsObserved: telemetry.turnsObserved,
        toolTurnsObserved: telemetry.toolTurnsObserved,
        toolCallsRequested: telemetry.toolCallsRequested,
        toolResultsObserved: telemetry.toolResultsObserved,
        toolErrorsObserved: telemetry.toolErrorsObserved,
        ...(telemetry.exactCycleKind ? { exactCycleKind: telemetry.exactCycleKind } : {}),
        ...(telemetry.lastToolTurn ? { lastToolTurn: structuredClone(telemetry.lastToolTurn) } : {})
      };
    },
    finalizedOutput(): string {
      if (!committed.finalized || !committed.output) {
        throw new Error(`Factory ${purpose} ended without an accepted finalize tool call`);
      }
      return committed.output;
    }
  };
}
