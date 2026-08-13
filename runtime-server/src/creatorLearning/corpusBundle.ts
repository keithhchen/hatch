import path from "node:path";
import { AgentCorpusSchema, type AgentCorpus } from "../agentCorpus.js";
import { requireUuidV4 } from "../identity.js";
import { verifyAgentCorpus } from "../registryCorpus.js";
import { FactoryFileStore } from "./fileStore.js";
import type { ArtifactRef, FactoryAgentTool } from "./types.js";

const SYSTEM_PATH = "instructions/system.md";
const SYNTHETIC_QA_PATH = "evals/synthetic-qa.json";
const HELD_OUT_PATH = "evals/held-out.json";
const SAFE_CANDIDATE_ROOT = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const TOOL_IDENTIFIER = /^(?:hatch|creator)\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const LOCAL_TOOL_IDENTIFIER = /^hatch\.local\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CREATOR_TOOL_IDENTIFIER = /^creator\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const REFERENCE_KINDS = new Set<AgentCorpusBundleReferenceKind>(["method", "style", "example", "few_shots"]);
const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;
const CANONICAL_TOOLS: readonly FactoryAgentTool[] = [
  { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
  { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" }
];

export type AgentCorpusBundleProduct = {
  id: string;
  name: string;
  description?: string;
  promise?: string;
  boundaries?: string[];
  offer?: AgentCorpus["product"]["offer"];
  presentation?: Record<string, unknown>;
};

export type AgentCorpusBundleReferenceKind = "method" | "style" | "example" | "few_shots";

export type AgentCorpusBundleReferenceInput = {
  id: string;
  kind: AgentCorpusBundleReferenceKind;
  content: string;
  description?: string;
};

export type AgentCorpusBundleSkillInput = {
  id: string;
  name: string;
  whenToUse: string;
  instruction: string;
  allowedToolIds?: string[];
  references?: AgentCorpusBundleReferenceInput[];
};

export type AgentCorpusBundleKnowledgeInput = {
  id: string;
  content: string;
  sourceSummary: string;
  description?: string;
};

export type AgentCorpusBundleInput = {
  /** Relative to FactoryFileStore's candidate/ namespace. */
  candidateRoot: string;
  creator: AgentCorpus["creator"];
  agentId: string;
  product: AgentCorpusBundleProduct;
  systemInstructions: string;
  skills?: AgentCorpusBundleSkillInput[];
  knowledge?: AgentCorpusBundleKnowledgeInput[];
  /** Complete caller declaration. The two canonical Hatch built-ins are added when absent. */
  tools?: FactoryAgentTool[];
  syntheticQa: unknown;
  heldOut: unknown;
};

export type MaterializedAgentCorpusBundle = {
  /** Relative to FactoryFileStore.directory and suitable for verification. */
  bundleRoot: string;
  manifestRef: ArtifactRef;
  assets: {
    system: ArtifactRef;
    skills: Array<{
      id: string;
      instruction: ArtifactRef;
      references: Array<{ id: string; kind: AgentCorpusBundleReferenceKind; asset: ArtifactRef }>;
    }>;
    knowledge: Array<{ id: string; asset: ArtifactRef }>;
    syntheticQa: ArtifactRef;
    heldOut: ArtifactRef;
  };
  /** Digest of the whole verified Corpus, including agent.json. */
  digest: string;
};

type ValidatedProduct = AgentCorpusBundleProduct;

type ValidatedSkill = {
  id: string;
  name: string;
  whenToUse: string;
  instruction: string;
  allowedToolIds: string[];
  references: AgentCorpusBundleReferenceInput[];
};

type BundlePlan = {
  candidateRoot: string;
  creator: AgentCorpus["creator"];
  agentId: string;
  product: ValidatedProduct;
  systemInstructions: string;
  skills: ValidatedSkill[];
  knowledge: AgentCorpusBundleKnowledgeInput[];
  tools: FactoryAgentTool[];
  syntheticQaDocument: string;
  heldOutDocument: string;
};

type PlannedAsset = {
  relativePath: string;
  content: string;
};

/**
 * Materialize a canonical, complete Agent Corpus. All model-authored layers are
 * data only: callers provide semantic identifiers and Markdown, while this
 * boundary owns every path, manifest field, digest, and canonical built-in.
 */
export async function materializeAgentCorpusBundle(
  store: FactoryFileStore,
  input: AgentCorpusBundleInput
): Promise<MaterializedAgentCorpusBundle> {
  // Validation deliberately finishes before the first durable write. In
  // particular, tool configuration and LLM-provided ids never get a chance to
  // become paths or leave a half-materialized invalid Corpus behind.
  const plan = validateBundleInput(input);
  const candidatePath = (relative: string) => path.posix.join(plan.candidateRoot, relative);
  const plannedAssets = buildPlannedAssets(plan);

  // Every asset must commit and yield its exact byte digest before agent.json
  // is constructed. Artifact timestamps are never copied into the manifest.
  const written = await Promise.all(plannedAssets.map(async (asset) => ({
    relativePath: asset.relativePath,
    ref: await store.writeCandidate(candidatePath(asset.relativePath), asset.content)
  })));
  const refsByPath = new Map(written.map((item) => [item.relativePath, item.ref]));
  const assetRef = (relativePath: string): ArtifactRef => {
    const ref = refsByPath.get(relativePath);
    if (!ref) throw new Error(`Agent Corpus asset was not materialized: ${relativePath}`);
    return ref;
  };

  const manifest = buildManifest(plan, (relativePath) => assetRef(relativePath).sha256);
  const manifestRef = await store.writeCandidate(candidatePath("agent.json"), jsonDocument(manifest, "manifest"));

  const bundleRoot = path.posix.join("candidate", plan.candidateRoot);
  const verified = await verifyAgentCorpus(
    path.join(store.directory, ...bundleRoot.split("/")),
    plan.creator.id,
    plan.agentId
  );
  return {
    bundleRoot,
    manifestRef,
    assets: {
      system: assetRef(SYSTEM_PATH),
      skills: plan.skills.map((skill) => ({
        id: skill.id,
        instruction: assetRef(skillInstructionPath(skill.id)),
        references: skill.references.map((reference) => ({
          id: reference.id,
          kind: reference.kind,
          asset: assetRef(skillReferencePath(skill.id, reference.id))
        }))
      })),
      knowledge: plan.knowledge.map((document) => ({
        id: document.id,
        asset: assetRef(knowledgePath(document.id))
      })),
      syntheticQa: assetRef(SYNTHETIC_QA_PATH),
      heldOut: assetRef(HELD_OUT_PATH)
    },
    digest: verified.digest
  };
}

function validateBundleInput(input: AgentCorpusBundleInput): BundlePlan {
  const candidateRoot = safeCandidateRoot(input.candidateRoot);
  const creator = {
    id: requireUuidV4(input.creator?.id, "creator.id"),
    name: requiredText(input.creator?.name, "creator name")
  };
  const product = validateProduct(input.product);
  const agentId = requireUuidV4(input.agentId || product.id, "product.id");
  if (agentId !== product.id) {
    throw new Error("agentId and product.id must identify the same Product UUID");
  }
  const systemInstructions = markdown(input.systemInstructions, "system instructions");
  const tools = validateTools(input.tools);
  const toolIds = new Set(tools.map((tool) => tool.id));
  const logicalAssetIds = new Map<string, string>([
    ["system", "system instructions"],
    ["synthetic-qa", "synthetic QA"],
    ["held-out", "held-out evaluation"]
  ]);

  const skills = validateArray(input.skills, "skills").map((rawSkill, skillIndex): ValidatedSkill => {
    const label = `skills[${skillIndex}]`;
    const record = strictRecord(rawSkill, label, ["id", "name", "whenToUse", "instruction", "allowedToolIds", "references"]);
    const id = canonicalIdentifier(record.id, `${label}.id`);
    claimUnique(logicalAssetIds, id, `Skill ${id}`);
    const references = validateArray(record.references, `${label}.references`).map((rawReference, referenceIndex) => {
      const referenceLabel = `${label}.references[${referenceIndex}]`;
      const referenceRecord = strictRecord(rawReference, referenceLabel, ["id", "kind", "content", "description"]);
      const referenceId = canonicalIdentifier(referenceRecord.id, `${referenceLabel}.id`);
      claimUnique(logicalAssetIds, referenceId, `Skill reference ${id}/${referenceId}`);
      if (typeof referenceRecord.kind !== "string" || !REFERENCE_KINDS.has(referenceRecord.kind as AgentCorpusBundleReferenceKind)) {
        throw new Error(`Agent Corpus ${referenceLabel}.kind must be method, style, example, or few_shots`);
      }
      const relativePath = skillReferencePath(id, referenceId);
      assertCanonicalAssetPath(relativePath, `Skill reference ${id}/${referenceId}`);
      if (!relativePath.startsWith(`skills/${id}/references/`)) {
        throw new Error(`Agent Corpus Skill reference ${referenceId} must belong to parent Skill ${id}`);
      }
      return {
        id: referenceId,
        kind: referenceRecord.kind as AgentCorpusBundleReferenceKind,
        content: markdown(referenceRecord.content, `${referenceLabel}.content`),
        ...optionalTextProperty(referenceRecord, "description", referenceLabel)
      };
    });
    const allowedToolIds = validateArray(record.allowedToolIds, `${label}.allowedToolIds`).map((rawToolId, toolIndex) => {
      const toolId = canonicalToolIdentifier(rawToolId, `${label}.allowedToolIds[${toolIndex}]`);
      if (!toolIds.has(toolId)) {
        throw new Error(`Agent Corpus Skill ${id} allows unknown tool id: ${toolId}`);
      }
      return toolId;
    });
    assertUnique(allowedToolIds, `${label}.allowedToolIds`);
    assertCanonicalAssetPath(skillInstructionPath(id), `Skill ${id}`);
    return {
      id,
      name: requiredText(record.name, `${label}.name`),
      whenToUse: requiredText(record.whenToUse, `${label}.whenToUse`),
      instruction: markdown(record.instruction, `${label}.instruction`),
      allowedToolIds,
      references
    };
  });

  const knowledge = validateArray(input.knowledge, "knowledge").map((rawDocument, documentIndex) => {
    const label = `knowledge[${documentIndex}]`;
    const record = strictRecord(rawDocument, label, ["id", "content", "sourceSummary", "description"]);
    const id = canonicalIdentifier(record.id, `${label}.id`);
    claimUnique(logicalAssetIds, id, `Knowledge document ${id}`);
    assertCanonicalAssetPath(knowledgePath(id), `Knowledge document ${id}`);
    return {
      id,
      content: markdown(record.content, `${label}.content`),
      sourceSummary: requiredText(record.sourceSummary, `${label}.sourceSummary`),
      ...optionalTextProperty(record, "description", label)
    };
  });

  const syntheticQaDocument = jsonDocument(input.syntheticQa, "synthetic QA");
  const heldOutDocument = jsonDocument(input.heldOut, "held-out evaluation");
  const plan = {
    candidateRoot,
    creator,
    agentId,
    product,
    systemInstructions,
    skills,
    knowledge,
    tools,
    syntheticQaDocument,
    heldOutDocument
  };

  // A placeholder manifest exercises the Runtime's actual strict object shape
  // before any writes. Digest equality is checked later against real bytes.
  const preview = buildManifest(plan, () => PLACEHOLDER_DIGEST);
  assertNoForbiddenFields(preview, "manifest");
  const parsed = AgentCorpusSchema.safeParse(preview);
  if (!parsed.success) {
    throw new Error(`Agent Corpus manifest input is invalid: ${parsed.error.message}`);
  }
  return plan;
}

function validateProduct(value: AgentCorpusBundleProduct): ValidatedProduct {
  const record = strictRecord(value, "product", ["id", "name", "description", "promise", "boundaries", "offer", "presentation"]);
  const boundaries = validateArray(record.boundaries, "product.boundaries").map((boundary, index) => (
    requiredText(boundary, `product.boundaries[${index}]`)
  ));
  const product: ValidatedProduct = {
    id: requireUuidV4(record.id, "product.id"),
    name: requiredText(record.name, "product.name"),
    ...(record.description === undefined ? {} : { description: requiredText(record.description, "product.description") }),
    ...(record.promise === undefined ? {} : { promise: requiredText(record.promise, "product.promise") }),
    ...(record.boundaries === undefined ? {} : { boundaries }),
    ...(record.offer === undefined ? {} : { offer: validateOffer(record.offer) }),
    ...(record.presentation === undefined ? {} : {
      presentation: cloneJsonRecord(record.presentation, "product.presentation")
    })
  };
  assertNoForbiddenFields(product, "product");
  return product;
}

function validateOffer(value: unknown): NonNullable<AgentCorpusBundleProduct["offer"]> {
  const record = strictRecord(value, "product.offer", ["model", "amount_minor", "currency", "unit"]);
  if (record.model !== undefined && record.model !== "per_delivery" && record.model !== "subscription") {
    throw new Error("Agent Corpus product.offer.model must be per_delivery or subscription");
  }
  if (typeof record.amount_minor !== "number" || !Number.isInteger(record.amount_minor) || record.amount_minor < 0) {
    throw new Error("Agent Corpus product.offer.amount_minor must be a non-negative integer");
  }
  if (typeof record.currency !== "string" || !/^[A-Z]{3}$/.test(record.currency)) {
    throw new Error("Agent Corpus product.offer.currency must be a three-letter uppercase currency code");
  }
  return {
    ...(record.model === undefined ? {} : { model: record.model }),
    amount_minor: record.amount_minor,
    currency: record.currency,
    ...(record.unit === undefined ? {} : { unit: requiredText(record.unit, "product.offer.unit") })
  };
}

function validateTools(value: FactoryAgentTool[] | undefined): FactoryAgentTool[] {
  const provided = validateArray(value, "tools").map((tool, index) => validateTool(tool, `tools[${index}]`));
  assertUnique(provided.map((tool) => tool.id), "tools");
  const byId = new Map<string, FactoryAgentTool>(CANONICAL_TOOLS.map((tool) => [tool.id, { ...tool }]));
  const callerOrder: string[] = [];
  for (const tool of provided) {
    byId.set(tool.id, tool);
    if (!CANONICAL_TOOLS.some((canonical) => canonical.id === tool.id)) callerOrder.push(tool.id);
  }
  const tools = [
    requiredMapValue(byId, "hatch.web_search"),
    requiredMapValue(byId, "hatch.file_search"),
    ...callerOrder.map((id) => requiredMapValue(byId, id))
  ];
  if (!tools.some((tool) => tool.id === "hatch.web_search") || !tools.some((tool) => tool.id === "hatch.file_search")) {
    throw new Error("Agent Corpus tools must include canonical hatch.web_search and hatch.file_search");
  }
  return tools;
}

function validateTool(value: unknown, label: string): FactoryAgentTool {
  if (!isPlainRecord(value)) throw new Error(`Agent Corpus ${label} must be an object`);
  rejectForbiddenToolConfiguration(value, label);
  const kind = value.kind;
  if (kind === "hatch_builtin") {
    const record = strictRecord(value, label, ["id", "kind", "capability", "description"]);
    const id = canonicalToolIdentifier(record.id, `${label}.id`);
    const expectedCapability = id === "hatch.web_search"
      ? "web_search"
      : id === "hatch.file_search"
        ? "file_search"
        : undefined;
    if (!expectedCapability) throw new Error(`Agent Corpus ${label} declares unknown Hatch built-in tool: ${id}`);
    if (record.capability !== expectedCapability) {
      throw new Error(`Agent Corpus ${label} must use capability ${expectedCapability}`);
    }
    return {
      id: id as "hatch.web_search" | "hatch.file_search",
      kind,
      capability: expectedCapability,
      ...optionalDescription(record, label)
    } as FactoryAgentTool;
  }
  if (kind === "local_harness") {
    const record = strictRecord(value, label, ["id", "kind", "capability", "description"]);
    const id = canonicalToolIdentifier(record.id, `${label}.id`);
    if (!LOCAL_TOOL_IDENTIFIER.test(id)) {
      throw new Error(`Agent Corpus ${label}.id must be a canonical hatch.local.* tool id`);
    }
    if (record.capability !== "filesystem" && record.capability !== "shell" && record.capability !== "git") {
      throw new Error(`Agent Corpus ${label}.capability is unknown`);
    }
    return { id, kind, capability: record.capability, ...optionalDescription(record, label) };
  }
  if (kind === "http_function") {
    const record = strictRecord(value, label, ["id", "kind", "connection_ref", "operation", "description", "input_schema"]);
    const id = creatorToolId(record.id, `${label}.id`);
    return {
      id,
      kind,
      connection_ref: canonicalIdentifier(record.connection_ref, `${label}.connection_ref`),
      operation: requiredText(record.operation, `${label}.operation`),
      ...optionalDescription(record, label),
      ...(record.input_schema === undefined ? {} : { input_schema: cloneJsonRecord(record.input_schema, `${label}.input_schema`) })
    };
  }
  if (kind === "mcp_tool") {
    const record = strictRecord(value, label, ["id", "kind", "connection_ref", "tool_name", "description", "input_schema"]);
    const id = creatorToolId(record.id, `${label}.id`);
    return {
      id,
      kind,
      connection_ref: canonicalIdentifier(record.connection_ref, `${label}.connection_ref`),
      tool_name: requiredText(record.tool_name, `${label}.tool_name`),
      ...optionalDescription(record, label),
      ...(record.input_schema === undefined ? {} : { input_schema: cloneJsonRecord(record.input_schema, `${label}.input_schema`) })
    };
  }
  throw new Error(`Agent Corpus ${label} declares unknown tool kind: ${String(kind)}`);
}

function buildPlannedAssets(plan: BundlePlan): PlannedAsset[] {
  return [
    { relativePath: SYSTEM_PATH, content: plan.systemInstructions },
    ...plan.skills.flatMap((skill): PlannedAsset[] => [
      { relativePath: skillInstructionPath(skill.id), content: skillDocument(skill) },
      ...skill.references.map((reference) => ({
        relativePath: skillReferencePath(skill.id, reference.id),
        content: reference.content
      }))
    ]),
    ...plan.knowledge.map((document) => ({
      relativePath: knowledgePath(document.id),
      content: document.content
    })),
    { relativePath: SYNTHETIC_QA_PATH, content: plan.syntheticQaDocument },
    { relativePath: HELD_OUT_PATH, content: plan.heldOutDocument }
  ];
}

/**
 * Agent Corpus owns Skill identity and triggering metadata. The LLM supplies
 * only the instruction body; this host boundary emits the canonical Agent
 * Skills frontmatter so every `SKILL.md` is loadable by the same parser used
 * by Hatch Runtime.
 */
function skillDocument(skill: ValidatedSkill): string {
  return [
    "---",
    `name: ${JSON.stringify(skill.id)}`,
    `description: ${JSON.stringify(skill.whenToUse)}`,
    "---",
    "",
    skill.instruction
  ].join("\n");
}

function buildManifest(plan: BundlePlan, digestFor: (relativePath: string) => string) {
  return {
    contract_version: "1" as const,
    creator: { id: plan.creator.id, name: plan.creator.name },
    product: {
      id: plan.product.id,
      name: plan.product.name,
      ...(plan.product.description === undefined ? {} : { description: plan.product.description }),
      ...(plan.product.promise === undefined ? {} : { promise: plan.product.promise }),
      ...(plan.product.boundaries === undefined ? {} : { boundaries: [...plan.product.boundaries] }),
      ...(plan.product.offer === undefined ? {} : { offer: { ...plan.product.offer } }),
      ...(plan.product.presentation === undefined ? {} : { presentation: plan.product.presentation })
    },
    instructions: {
      system: { id: "system", path: SYSTEM_PATH, sha256: digestFor(SYSTEM_PATH) }
    },
    skills: plan.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      when_to_use: skill.whenToUse,
      instruction: {
        id: skill.id,
        path: skillInstructionPath(skill.id),
        sha256: digestFor(skillInstructionPath(skill.id))
      },
      references: skill.references.map((reference) => ({
        asset: {
          id: reference.id,
          path: skillReferencePath(skill.id, reference.id),
          sha256: digestFor(skillReferencePath(skill.id, reference.id)),
          ...(reference.description === undefined ? {} : { description: reference.description })
        },
        kind: reference.kind
      })),
      allowed_tool_ids: [...skill.allowedToolIds]
    })),
    knowledge: {
      documents: plan.knowledge.map((document) => ({
        id: document.id,
        path: knowledgePath(document.id),
        sha256: digestFor(knowledgePath(document.id)),
        ...(document.description === undefined ? {} : { description: document.description }),
        retrieval_only: true as const,
        source_summary: document.sourceSummary
      }))
    },
    tools: plan.tools,
    evaluations: {
      synthetic_qa: [{ id: "synthetic-qa", path: SYNTHETIC_QA_PATH, sha256: digestFor(SYNTHETIC_QA_PATH) }],
      held_out: [{ id: "held-out", path: HELD_OUT_PATH, sha256: digestFor(HELD_OUT_PATH) }]
    }
  };
}

function safeCandidateRoot(value: unknown): string {
  if (typeof value !== "string") throw new Error("Agent Corpus candidate root must be a string");
  const normalized = value.replaceAll("\\", "/");
  if (
    !SAFE_CANDIDATE_ROOT.test(normalized)
    || path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Agent Corpus candidate root must be a safe relative path: ${value}`);
  }
  return normalized;
}

function canonicalIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 128 || !IDENTIFIER.test(value)) {
    throw new Error(`Agent Corpus ${label} must be a canonical identifier`);
  }
  return value;
}

function canonicalToolIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !TOOL_IDENTIFIER.test(value)) {
    throw new Error(`Agent Corpus ${label} must be a canonical tool identifier`);
  }
  return value;
}

function creatorToolId(value: unknown, label: string): string {
  const id = canonicalToolIdentifier(value, label);
  if (!CREATOR_TOOL_IDENTIFIER.test(id)) {
    throw new Error(`Agent Corpus ${label} must be a canonical creator.* tool id`);
  }
  return id;
}

function skillInstructionPath(skillId: string): string {
  return `skills/${skillId}/SKILL.md`;
}

function skillReferencePath(skillId: string, referenceId: string): string {
  return `skills/${skillId}/references/${referenceId}.md`;
}

function knowledgePath(documentId: string): string {
  return `knowledge/${documentId}.md`;
}

function assertCanonicalAssetPath(value: string, label: string): void {
  if (
    !value
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)
  ) {
    throw new Error(`Agent Corpus ${label} generated a non-canonical asset path`);
  }
}

function validateArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Agent Corpus ${label} must be an array`);
  return value;
}

function strictRecord(value: unknown, label: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`Agent Corpus ${label} must be an object`);
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Agent Corpus ${label} contains unsupported fields: ${unexpected.join(", ")}`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Agent Corpus ${label} must be a non-empty string`);
  }
  return value;
}

function markdown(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Agent Corpus ${label} must be non-empty Markdown`);
  }
  return value;
}

function optionalTextProperty(
  record: Record<string, unknown>,
  key: "description",
  label: string
): { description?: string } {
  return record[key] === undefined ? {} : { description: requiredText(record[key], `${label}.${key}`) };
}

function optionalDescription(record: Record<string, unknown>, label: string): { description?: string } {
  return optionalTextProperty(record, "description", label);
}

function claimUnique(seen: Map<string, string>, id: string, owner: string): void {
  const previous = seen.get(id);
  if (previous) throw new Error(`Agent Corpus id ${id} is duplicated by ${previous} and ${owner}`);
  seen.set(id, owner);
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Agent Corpus ${label} contains duplicate id: ${value}`);
    seen.add(value);
  }
}

function requiredMapValue<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Agent Corpus internal tool union lost ${String(key)}`);
  return value;
}

function rejectForbiddenToolConfiguration(tool: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(tool)) {
    if (isForbiddenFieldName(key)) {
      throw new Error(`Agent Corpus ${label} contains forbidden tool configuration field: ${key}`);
    }
  }
}

function assertNoForbiddenFields(value: unknown, label: string): void {
  const leaked: string[] = [];
  findForbiddenFields(value, "", leaked, new Set<object>());
  if (leaked.length > 0) {
    throw new Error(`Agent Corpus ${label} contains forbidden secret, URL, provider, raw, or trace fields: ${leaked.join(", ")}`);
  }
}

function findForbiddenFields(value: unknown, prefix: string, output: string[], seen: Set<object>): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`Agent Corpus ${prefix || "manifest"} must not contain circular JSON`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenFields(item, `${prefix}[${index}]`, output, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      const current = prefix ? `${prefix}.${key}` : key;
      if (isForbiddenFieldName(key)) output.push(current);
      findForbiddenFields(child, current, output, seen);
    }
  }
  seen.delete(value);
}

function isForbiddenFieldName(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized === "raw"
    || normalized.endsWith("_raw")
    || normalized === "trace"
    || normalized.endsWith("_trace")
    || normalized === "provider"
    || normalized.endsWith("_provider")
    || normalized === "provider_config"
    || normalized === "url"
    || normalized.endsWith("_url")
    || normalized === "endpoint"
    || normalized.endsWith("_endpoint")
    || normalized === "secret"
    || normalized.endsWith("_secret")
    || normalized === "secret_ref"
    || normalized === "api_key"
    || normalized === "credential"
    || normalized === "credentials"
    || normalized.endsWith("_credential")
    || normalized === "access_token"
    || normalized === "oauth_token"
    || normalized === "bearer_token"
    || normalized === "password"
    || normalized === "vector_store_id"
    || normalized === "raw_material"
    || normalized === "factory_trace";
}

function cloneJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`Agent Corpus ${label} must be a JSON object`);
  const cloned = cloneJsonValue(value, label, new Set<object>());
  if (!isPlainRecord(cloned)) throw new Error(`Agent Corpus ${label} must be a JSON object`);
  assertNoForbiddenFields(cloned, label);
  return cloned;
}

function cloneJsonValue(value: unknown, label: string, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Agent Corpus ${label} must contain finite JSON numbers`);
    return value;
  }
  if (typeof value !== "object") throw new Error(`Agent Corpus ${label} is not JSON-compatible`);
  if (seen.has(value)) throw new Error(`Agent Corpus ${label} must not contain circular JSON`);
  seen.add(value);
  let cloned: unknown;
  if (Array.isArray(value)) {
    cloned = value.map((item, index) => cloneJsonValue(item, `${label}[${index}]`, seen));
  } else if (isPlainRecord(value)) {
    const record: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      record[key] = cloneJsonValue(child, `${label}.${key}`, seen);
    }
    cloned = record;
  } else {
    throw new Error(`Agent Corpus ${label} must contain only plain JSON objects`);
  }
  seen.delete(value);
  return cloned;
}

function jsonDocument(value: unknown, label: string): string {
  try {
    const cloned = cloneJsonValue(value, label, new Set<object>());
    const serialized = JSON.stringify(cloned, null, 2);
    if (serialized === undefined) throw new Error("top-level value is not JSON-compatible");
    return `${serialized}\n`;
  } catch (error) {
    throw new Error(`Agent Corpus ${label} must be JSON-compatible: ${String(error)}`);
  }
}
