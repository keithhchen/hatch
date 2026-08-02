import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ClientToolName } from "./protocol.js";

const Identifier = z.string().min(1).max(128).regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const RelativeAsset = z.string().min(1).refine((value) => !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."));

const AssetSchema = z.object({
  id: Identifier,
  path: RelativeAsset,
  sha256: Digest,
  description: z.string().min(1).optional()
}).strict();

const FunctionSchema = z.record(z.string(), z.unknown());

const HatchWebSearchToolSchema = z.object({
  id: z.literal("hatch.web_search"),
  kind: z.literal("hatch_builtin"),
  capability: z.literal("web_search"),
  description: z.string().min(1).optional()
}).strict();

const HatchFileSearchToolSchema = z.object({
  id: z.literal("hatch.file_search"),
  kind: z.literal("hatch_builtin"),
  capability: z.literal("file_search"),
  description: z.string().min(1).optional()
}).strict();

const HatchLocalToolSchema = z.object({
  id: z.string().regex(/^hatch\.local\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
  kind: z.literal("local_harness"),
  capability: z.enum(["filesystem", "shell", "git"]),
  description: z.string().min(1).optional()
}).strict();

const CreatorHttpToolSchema = z.object({
  id: z.string().regex(/^creator\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
  kind: z.literal("http_function"),
  connection_ref: Identifier,
  operation: z.string().min(1),
  description: z.string().min(1).optional(),
  input_schema: FunctionSchema.optional()
}).strict();

const CreatorMcpToolSchema = z.object({
  id: z.string().regex(/^creator\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
  kind: z.literal("mcp_tool"),
  connection_ref: Identifier,
  tool_name: z.string().min(1),
  description: z.string().min(1).optional(),
  input_schema: FunctionSchema.optional()
}).strict();

// Multiple Hatch built-ins intentionally share `kind: hatch_builtin`; `kind`
// therefore is not a unique discriminator once file search is present.
const ToolSchema = z.union([
  HatchWebSearchToolSchema,
  HatchFileSearchToolSchema,
  HatchLocalToolSchema,
  CreatorHttpToolSchema,
  CreatorMcpToolSchema
]);

const SkillReferenceSchema = z.object({
  asset: AssetSchema,
  kind: z.enum(["method", "style", "example", "few_shots"])
}).strict();

const SkillSchema = z.object({
  id: Identifier,
  name: z.string().min(1),
  when_to_use: z.string().min(1),
  instruction: AssetSchema,
  references: z.array(SkillReferenceSchema).default([]),
  allowed_tool_ids: z.array(z.string().regex(/^(?:hatch|creator)\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)).default([])
}).strict().superRefine((skill, ctx) => {
  if (skill.instruction.path !== `skills/${skill.id}/SKILL.md`) {
    ctx.addIssue({ code: "custom", path: ["instruction", "path"], message: "Skill instruction must be skills/<skill-id>/SKILL.md" });
  }
  for (const reference of skill.references) {
    if (!reference.asset.path.startsWith(`skills/${skill.id}/references/`) || !reference.asset.path.endsWith(".md")) {
      ctx.addIssue({ code: "custom", path: ["references"], message: "Skill references must live under this Skill's references/ directory" });
    }
  }
});

const KnowledgeDocumentSchema = z.object({
  id: Identifier,
  path: RelativeAsset,
  sha256: Digest,
  description: z.string().min(1).optional(),
  retrieval_only: z.literal(true),
  source_summary: z.string().min(1)
}).strict().superRefine((document, ctx) => {
  if (!document.path.startsWith("knowledge/") || !document.path.endsWith(".md")) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "Knowledge documents must be markdown files under knowledge/" });
  }
});

const ProductSchema = z.object({
  id: Identifier,
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  promise: z.string().min(1).optional(),
  inputs: z.array(z.string().min(1)).min(1).optional(),
  outputs: z.array(z.string().min(1)).min(1).optional(),
  boundaries: z.array(z.string().min(1)).min(1).optional(),
  offer: z.object({
    model: z.enum(["per_delivery", "subscription"]),
    unit: z.string().min(1),
    amount_minor: z.number().int().nonnegative().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional()
  }).strict().superRefine((offer, ctx) => {
    if ((offer.amount_minor === undefined) !== (offer.currency === undefined)) {
      ctx.addIssue({ code: "custom", message: "Offer amount_minor and currency must be supplied together" });
    }
  }).optional()
}).strict();

/**
 * The runtime representation of the public Agent Corpus v1 contract.
 * It deliberately excludes runtime provider, deployment, credentials, and
 * retrieval-index bindings. Those belong to the Registry / Control Plane.
 */
export const AgentCorpusSchema = z.object({
  contract_version: z.literal("1"),
  agent_id: Identifier,
  creator: z.object({ id: Identifier, name: z.string().min(1) }).strict(),
  product: ProductSchema,
  instructions: z.object({
    system: AssetSchema
  }).strict().superRefine((instructions, ctx) => {
    if (instructions.system.path !== "instructions/system.md") {
      ctx.addIssue({ code: "custom", path: ["system", "path"], message: "The always-loaded system instruction must be instructions/system.md" });
    }
  }),
  skills: z.array(SkillSchema).default([]),
  // Every Agent has an isolated Registry/RAG namespace. An Agent with no
  // long-tail material declares it explicitly as `documents: []`; absence is
  // not an implicit alternative execution path.
  knowledge: z.object({ documents: z.array(KnowledgeDocumentSchema) }).strict(),
  tools: z.array(ToolSchema).min(1),
  evaluations: z.object({
    synthetic_qa: z.array(AssetSchema).min(1),
    held_out: z.array(AssetSchema).min(1)
  }).strict()
}).strict();

export type AgentCorpus = z.infer<typeof AgentCorpusSchema>;
export type AgentCorpusTool = z.infer<typeof ToolSchema>;
export type CreatorCorpusTool = Extract<AgentCorpusTool, { kind: "http_function" | "mcp_tool" }>;
export type ResolvedAgentCorpus = {
  corpus: AgentCorpus;
  corpusDirectory: string;
  /** The only Creator-authored instruction loaded for every run. */
  systemPrompt: string;
  corpusDigest: string;
};

/**
 * Provider-free publication gate. It validates an exact current Corpus before
 * Registry promotion. Evaluation assets are checked for integrity but are
 * never read into a live Runtime context.
 */
export async function validateAgentCorpusPackage(corpusDirectory: string): Promise<AgentCorpus> {
  const root = await realpath(corpusDirectory);
  const corpus = AgentCorpusSchema.parse(JSON.parse(await readFile(path.join(root, "agent.json"), "utf8")));
  const assets = corpusAssets(corpus);
  await Promise.all(assets.map(async (asset) => {
    const assetPath = await containedRealpath(root, asset.path);
    if (!(await lstat(assetPath)).isFile()) throw new Error(`Agent Corpus asset is not a file: ${asset.path}`);
    const actual = `sha256:${createHash("sha256").update(await readFile(assetPath)).digest("hex")}`;
    if (actual !== asset.sha256) throw new Error(`Agent Corpus asset hash does not match manifest: ${asset.path}`);
  }));
  const expected = new Set(["agent.json", ...assets.map((asset) => asset.path)]);
  const actual = await packageFiles(root);
  if (actual.size !== expected.size || [...actual].some((item) => !expected.has(item))) {
    const missing = [...expected].filter((item) => !actual.has(item));
    const unexpected = [...actual].filter((item) => !expected.has(item));
    throw new Error(`Agent Corpus assets do not match agent.json; missing=${missing.join(",")} unexpected=${unexpected.join(",")}`);
  }
  const knownTools = new Set(corpus.tools.map((tool) => tool.id));
  if (knownTools.size !== corpus.tools.length) throw new Error("Agent Corpus cannot declare the same tool ID more than once");
  for (const skill of corpus.skills) {
    const unknown = skill.allowed_tool_ids.filter((toolId) => !knownTools.has(toolId));
    if (unknown.length) throw new Error(`Skill ${skill.id} references unknown tools: ${unknown.join(", ")}`);
  }
  if (!corpusHasWebSearch(corpus)) throw new Error("Agent Corpus must declare hatch.web_search");
  if (!corpusHasFileSearch(corpus)) throw new Error("Agent Corpus must declare hatch.file_search");
  return corpus;
}

/** Resolves the Registry-owned current Corpus; never reads Factory workspaces. */
export class AgentCorpusResolver {
  constructor(
    private readonly corpusRoot: string,
    // Retained as an ignored constructor argument while callers migrate from
    // the retired local lexical index. Corpus knowledge is now Registry/RAG
    // infrastructure, not a file the Runtime resolves itself.
    _retiredKnowledgeRoot?: string
  ) {}

  async resolve(creatorId: string, agentId: string): Promise<ResolvedAgentCorpus> {
    Identifier.parse(creatorId);
    Identifier.parse(agentId);
    const corpusDirectory = await containedRealpath(this.corpusRoot, path.join(creatorId, agentId));
    const corpus = AgentCorpusSchema.parse(JSON.parse(await readFile(path.join(corpusDirectory, "agent.json"), "utf8")));
    if (corpus.agent_id !== agentId) {
      throw new Error("Agent Corpus identity does not match its Registry path");
    }
    if (corpus.creator.id !== creatorId) throw new Error("Agent Corpus creator identity does not match its Registry path");
    await Promise.all(corpusAssets(corpus).map((asset) => containedRealpath(corpusDirectory, asset.path)));
    return {
      corpus,
      corpusDirectory,
      systemPrompt: await readFile(path.join(corpusDirectory, corpus.instructions.system.path), "utf8"),
      corpusDigest: await hashTree(corpusDirectory)
    };
  }
}

/** Hatch local capabilities are narrowed by both the Corpus and Desktop hello. */
export function permittedCorpusLocalTools(corpus: AgentCorpus, advertised: ClientToolName[]): ClientToolName[] {
  const requested = new Set(corpus.tools
    .filter((tool): tool is Extract<AgentCorpusTool, { kind: "local_harness" }> => tool.kind === "local_harness")
    .flatMap((tool) => localToolsForCapability(tool.capability)));
  return advertised.filter((tool) => requested.has(tool));
}

/** Hatch built-ins visible to this Corpus. Creator tools resolve separately through the Control Plane. */
export function corpusRuntimeToolNames(corpus: AgentCorpus): string[] {
  const names = new Set<string>();
  if (corpusHasWebSearch(corpus)) names.add("web.search");
  if (corpusHasFileSearch(corpus)) names.add("knowledge.search");
  return [...names];
}

export function corpusHasWebSearch(corpus: AgentCorpus): boolean {
  return corpus.tools.some((tool) => tool.id === "hatch.web_search" && tool.kind === "hatch_builtin" && tool.capability === "web_search");
}

export function corpusHasFileSearch(corpus: AgentCorpus): boolean {
  return corpus.tools.some((tool) => tool.id === "hatch.file_search" && tool.kind === "hatch_builtin" && tool.capability === "file_search");
}

function corpusAssets(corpus: AgentCorpus): z.infer<typeof AssetSchema>[] {
  return [
    corpus.instructions.system,
    ...corpus.skills.flatMap((skill) => [skill.instruction, ...skill.references.map((reference) => reference.asset)]),
    ...corpus.knowledge.documents,
    ...corpus.evaluations.synthetic_qa,
    ...corpus.evaluations.held_out
  ];
}

function localToolsForCapability(capability: Extract<AgentCorpusTool, { kind: "local_harness" }> ["capability"]): ClientToolName[] {
  if (capability === "filesystem") return ["fs.list", "fs.search", "fs.read", "fs.write", "fs.patch"];
  if (capability === "shell") return ["shell.exec"];
  if (capability === "git") return ["git.diff"];
  return [];
}

async function packageFiles(root: string): Promise<Set<string>> {
  const files = new Set<string>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const relative = path.relative(root, child).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Agent Corpus cannot contain symlinks: ${relative}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.add(relative);
      else throw new Error(`Agent Corpus contains an unsupported entry: ${relative}`);
    }
  }
  await visit(root);
  return files;
}

async function containedRealpath(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative)) throw new Error(`Agent Corpus path must be relative: ${relative}`);
  const realRoot = await realpath(root);
  const resolved = await realpath(path.resolve(realRoot, relative));
  if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Agent Corpus path escapes its root: ${relative}`);
  }
  return resolved;
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        hash.update(path.relative(root, child));
        hash.update("\0");
        hash.update(await readFile(child));
      } else throw new Error(`Agent Corpus contains unsupported entry: ${path.relative(root, child)}`);
    }
  }
  await visit(root);
  return `sha256:${hash.digest("hex")}`;
}
