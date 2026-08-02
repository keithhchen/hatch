import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { AgentCorpusSchema, type AgentCorpus } from "./agentCorpus.js";

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_FILES = 1_000;

export class AgentCorpusVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCorpusVerificationError";
  }
}

export type VerifiedAgentCorpus = {
  agentId: string;
  creator: AgentCorpus["creator"];
  product: AgentCorpus["product"];
  path: string;
  digest: string;
  corpus: AgentCorpus;
};

export async function extractAgentCorpusBundle(bundle: Uint8Array, destination: string): Promise<string> {
  if (bundle.byteLength > MAX_BUNDLE_BYTES) throw new AgentCorpusVerificationError("Agent Corpus bundle is too large");
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bundle);
  } catch (error) {
    throw new AgentCorpusVerificationError(`Agent Corpus bundle must be a valid ZIP archive: ${String(error)}`);
  }
  const names = Object.keys(files).filter((name) => !name.endsWith("/"));
  if (names.length === 0 || names.length > MAX_BUNDLE_FILES) {
    throw new AgentCorpusVerificationError("Agent Corpus bundle has an invalid file count");
  }
  await mkdir(destination, { recursive: true });
  let total = 0;
  for (const name of names) {
    if (!isSafeRelativePath(name)) throw new AgentCorpusVerificationError(`Agent Corpus bundle path escapes root: ${name}`);
    const data = files[name]!;
    total += data.byteLength;
    if (total > MAX_BUNDLE_BYTES) throw new AgentCorpusVerificationError("Agent Corpus bundle expands beyond the size limit");
    const target = containedPath(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  if (!names.includes("agent.json")) throw new AgentCorpusVerificationError("Agent Corpus bundle must contain agent.json at its root");
  return destination;
}

export async function verifyAgentCorpus(
  corpusRoot: string,
  expectedCreatorId?: string,
  expectedAgentId?: string,
): Promise<VerifiedAgentCorpus> {
  const root = path.resolve(corpusRoot);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(root, "agent.json"), "utf8"));
  } catch (error) {
    throw new AgentCorpusVerificationError(`Agent Corpus agent.json is not valid JSON: ${String(error)}`);
  }
  const parsed = AgentCorpusSchema.safeParse(raw);
  if (!parsed.success) throw new AgentCorpusVerificationError(`Agent Corpus manifest is invalid: ${parsed.error.message}`);
  const corpus = parsed.data;
  if (!IDENTIFIER.test(corpus.agent_id) || !IDENTIFIER.test(corpus.creator.id)) {
    throw new AgentCorpusVerificationError("Agent Corpus identifiers are invalid");
  }
  if (expectedAgentId && corpus.agent_id !== expectedAgentId) throw new AgentCorpusVerificationError("Agent Corpus agent binding mismatch");
  if (expectedCreatorId && corpus.creator.id !== expectedCreatorId) throw new AgentCorpusVerificationError("Agent Corpus creator binding mismatch");
  if (!corpus.tools.some((tool) => tool.id === "hatch.web_search")) {
    throw new AgentCorpusVerificationError("Agent Corpus must declare hatch.web_search");
  }
  if (corpus.knowledge.documents.length > 0 && !corpus.tools.some((tool) => tool.id === "hatch.file_search")) {
    throw new AgentCorpusVerificationError("Agent Corpus with knowledge documents must declare hatch.file_search");
  }
  const forbidden = new Set(["provider", "api_key", "credential", "credentials", "endpoint", "vector_store_id", "raw_material", "factory_trace"]);
  const leaked: string[] = [];
  findForbiddenKeys(raw, forbidden, "", leaked);
  if (leaked.length) throw new AgentCorpusVerificationError(`Agent Corpus contains forbidden runtime or Factory fields: ${leaked.join(", ")}`);

  const descriptors = assetDescriptors(corpus);
  const rows: Array<[string, string]> = [["agent.json", await sha256File(path.join(root, "agent.json"))]];
  const declared = new Set(["agent.json"]);
  for (const descriptor of descriptors) {
    if (!DIGEST.test(descriptor.sha256)) throw new AgentCorpusVerificationError(`Invalid asset digest: ${descriptor.path}`);
    const relative = descriptor.path;
    if (!isSafeRelativePath(relative) || declared.has(relative)) throw new AgentCorpusVerificationError(`Agent Corpus repeats or invalid asset path: ${relative}`);
    declared.add(relative);
    const actual = await sha256File(containedPath(root, relative));
    if (actual !== descriptor.sha256) throw new AgentCorpusVerificationError(`Agent Corpus asset digest mismatch: ${relative}`);
    rows.push([relative.replaceAll(path.sep, "/"), actual]);
  }
  const actualPaths = await filesUnder(root);
  const unexpected = actualPaths.filter((candidate) => !declared.has(candidate)).sort();
  if (unexpected.length) throw new AgentCorpusVerificationError(`Agent Corpus contains undeclared files: ${unexpected.join(", ")}`);
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
  return { agentId: corpus.agent_id, creator: corpus.creator, product: corpus.product, path: root, digest, corpus };
}

export async function installCurrentCorpus(verified: VerifiedAgentCorpus, destinationRoot: string): Promise<string> {
  const root = path.resolve(destinationRoot);
  const destination = containedPath(root, path.join(verified.creator.id, verified.agentId));
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(verified.path, temporary, { recursive: true, force: true });
  try {
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return destination;
}

export async function listCurrentCorpora(root: string, creatorId: string): Promise<VerifiedAgentCorpus[]> {
  const creatorRoot = containedPath(root, creatorId);
  let entries;
  try { entries = await readdir(creatorRoot, { withFileTypes: true }); } catch { return []; }
  const result: VerifiedAgentCorpus[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { result.push(await verifyAgentCorpus(containedPath(creatorRoot, entry.name), creatorId, entry.name)); } catch { /* ignore incomplete entries */ }
  }
  return result;
}

function assetDescriptors(corpus: AgentCorpus): Array<{ path: string; sha256: string }> {
  const result: Array<{ path: string; sha256: string }> = [{ path: corpus.instructions.system.path, sha256: corpus.instructions.system.sha256 }];
  for (const skill of corpus.skills) {
    result.push({ path: skill.instruction.path, sha256: skill.instruction.sha256 });
    for (const reference of skill.references) result.push({ path: reference.asset.path, sha256: reference.asset.sha256 });
  }
  for (const document of corpus.knowledge.documents) result.push({ path: document.path, sha256: document.sha256 });
  for (const rows of Object.values(corpus.evaluations)) for (const asset of rows) result.push({ path: asset.path, sha256: asset.sha256 });
  return result;
}

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result.push(relative);
      else throw new AgentCorpusVerificationError(`Agent Corpus cannot contain special file: ${relative}`);
    }
  }
  await walk(root);
  return result;
}

function containedPath(root: string, relative: string): string {
  if (!isSafeRelativePath(relative)) throw new AgentCorpusVerificationError(`Agent Corpus path must be relative: ${relative}`);
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new AgentCorpusVerificationError(`Agent Corpus path escapes root: ${relative}`);
  return resolved;
}

function isSafeRelativePath(value: string): boolean {
  return Boolean(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..") && !value.startsWith("/");
}

async function sha256File(filePath: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(filePath)).digest("hex")}`;
}

function findForbiddenKeys(value: unknown, forbidden: Set<string>, prefix: string, output: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) findForbiddenKeys(item, forbidden, prefix, output); return; }
  for (const [key, child] of Object.entries(value)) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (forbidden.has(key)) output.push(current);
    findForbiddenKeys(child, forbidden, current, output);
  }
}
