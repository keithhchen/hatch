import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import {
  AGENT_CORPUS_MANIFEST_MAX_BYTES,
  AgentCorpusSchema,
  loadAgentCorpus,
  type AgentCorpus,
} from "./agentCorpus.js";

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
export const MAX_AGENT_CORPUS_BUNDLE_BYTES = 16 * 1024 * 1024;
export const MAX_AGENT_CORPUS_FILES = 256;

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
  totalBytes: number;
  totalFiles: number;
};

type CorpusOperationOptions = { signal?: AbortSignal };

export type CurrentCorpusInstallTransaction = {
  currentPath: string;
  preparedPath: string;
  backupPath: string;
  commit(): Promise<string>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
};

export async function extractAgentCorpusBundle(
  bundle: Uint8Array,
  destination: string,
  options: CorpusOperationOptions = {},
): Promise<string> {
  throwIfAborted(options.signal);
  if (bundle.byteLength > MAX_AGENT_CORPUS_BUNDLE_BYTES) throw new AgentCorpusVerificationError("Agent Corpus bundle is too large");
  let files: Record<string, Uint8Array>;
  let declaredEntries = 0;
  let declaredExpandedBytes = 0;
  try {
    files = unzipSync(bundle, {
      // fflate invokes this from ZIP metadata before allocating each expanded
      // output. Enforce the declared limits here so a small compressed ZIP bomb
      // never reaches the decompressor or creates a giant output buffer.
      filter(file) {
        declaredEntries += 1;
        if (declaredEntries > MAX_AGENT_CORPUS_FILES) {
          throw new AgentCorpusVerificationError("Agent Corpus bundle has an invalid file count");
        }
        if (!isSafeRelativePath(file.name)) {
          throw new AgentCorpusVerificationError(`Agent Corpus bundle path escapes root: ${file.name}`);
        }
        if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) {
          throw new AgentCorpusVerificationError("Agent Corpus bundle has an invalid expanded size");
        }
        if (file.name === "agent.json" && file.originalSize > AGENT_CORPUS_MANIFEST_MAX_BYTES) {
          throw new AgentCorpusVerificationError("Agent Corpus manifest is too large");
        }
        declaredExpandedBytes += file.originalSize;
        if (declaredExpandedBytes > MAX_AGENT_CORPUS_BUNDLE_BYTES) {
          throw new AgentCorpusVerificationError("Agent Corpus bundle expands beyond the size limit");
        }
        return true;
      }
    });
  } catch (error) {
    if (error instanceof AgentCorpusVerificationError) throw error;
    throw new AgentCorpusVerificationError(`Agent Corpus bundle must be a valid ZIP archive: ${String(error)}`);
  }
  const names = Object.keys(files).filter((name) => !name.endsWith("/"));
  if (names.length === 0 || names.length > MAX_AGENT_CORPUS_FILES) {
    throw new AgentCorpusVerificationError("Agent Corpus bundle has an invalid file count");
  }
  await mkdir(destination, { recursive: true });
  let total = 0;
  for (const name of names) {
    throwIfAborted(options.signal);
    if (!isSafeRelativePath(name)) throw new AgentCorpusVerificationError(`Agent Corpus bundle path escapes root: ${name}`);
    const data = files[name]!;
    total += data.byteLength;
    if (total > MAX_AGENT_CORPUS_BUNDLE_BYTES) throw new AgentCorpusVerificationError("Agent Corpus bundle expands beyond the size limit");
    const target = containedPath(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { signal: options.signal });
  }
  throwIfAborted(options.signal);
  if (!names.includes("agent.json")) throw new AgentCorpusVerificationError("Agent Corpus bundle must contain agent.json at its root");
  return destination;
}

export async function verifyAgentCorpus(
  corpusRoot: string,
  expectedCreatorId?: string,
  expectedAgentId?: string,
  options: CorpusOperationOptions = {},
): Promise<VerifiedAgentCorpus> {
  throwIfAborted(options.signal);
  const root = path.resolve(corpusRoot);
  let raw: unknown;
  try {
    const metadata = await stat(path.join(root, "agent.json"));
    if (metadata.size > AGENT_CORPUS_MANIFEST_MAX_BYTES) {
      throw new AgentCorpusVerificationError("Agent Corpus manifest is too large");
    }
    raw = JSON.parse(await readFile(path.join(root, "agent.json"), { encoding: "utf8", signal: options.signal }));
  } catch (error) {
    if (error instanceof AgentCorpusVerificationError) throw error;
    throw new AgentCorpusVerificationError(`Agent Corpus agent.json is not valid JSON: ${String(error)}`);
  }
  const parsed = AgentCorpusSchema.safeParse(raw);
  if (!parsed.success) throw new AgentCorpusVerificationError(`Agent Corpus manifest is invalid: ${parsed.error.message}`);
  let corpus: AgentCorpus;
  try {
    // Registry acceptance must be at least as strict as Runtime loading. This
    // shared validator carries Runtime-only path, per-asset, and future
    // execution invariants into the publish boundary.
    corpus = await loadAgentCorpus(root, options.signal);
  } catch (error) {
    throw new AgentCorpusVerificationError(`Agent Corpus is not runtime-loadable: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    throwIfAborted(options.signal);
    if (!DIGEST.test(descriptor.sha256)) throw new AgentCorpusVerificationError(`Invalid asset digest: ${descriptor.path}`);
    const relative = descriptor.path;
    if (!isSafeRelativePath(relative) || declared.has(relative)) throw new AgentCorpusVerificationError(`Agent Corpus repeats or invalid asset path: ${relative}`);
    declared.add(relative);
    const actual = await sha256File(containedPath(root, relative), options.signal);
    if (actual !== descriptor.sha256) throw new AgentCorpusVerificationError(`Agent Corpus asset digest mismatch: ${relative}`);
    rows.push([relative.replaceAll(path.sep, "/"), actual]);
  }
  const actualPaths = await filesUnder(root, options.signal);
  const unexpected = actualPaths.filter((candidate) => !declared.has(candidate)).sort();
  if (unexpected.length) throw new AgentCorpusVerificationError(`Agent Corpus contains undeclared files: ${unexpected.join(", ")}`);
  let totalBytes = 0;
  for (const candidate of actualPaths) {
    throwIfAborted(options.signal);
    totalBytes += (await stat(containedPath(root, candidate))).size;
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
  return { agentId: corpus.agent_id, creator: corpus.creator, product: corpus.product, path: root, digest, corpus, totalBytes, totalFiles: actualPaths.length };
}

export async function prepareCurrentCorpusInstall(
  verified: VerifiedAgentCorpus,
  destinationRoot: string,
  options: CorpusOperationOptions = {},
): Promise<CurrentCorpusInstallTransaction> {
  const root = path.resolve(destinationRoot);
  const destination = containedPath(root, path.join(verified.creator.id, verified.agentId));
  const transactionId = randomUUID();
  const temporary = path.join(path.dirname(destination), `.${verified.agentId}.${transactionId}.prepared`);
  const backup = path.join(path.dirname(destination), `.${verified.agentId}.${transactionId}.backup`);
  let state: "prepared" | "committed" | "rolled_back" | "finalized" | "recovery_needed" = "prepared";
  let hadCurrent = false;

  throwIfAborted(options.signal);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await cp(verified.path, temporary, { recursive: true, force: false, errorOnExist: true });
    throwIfAborted(options.signal);
    const copied = await verifyAgentCorpus(temporary, verified.creator.id, verified.agentId, options);
    if (copied.digest !== verified.digest) {
      throw new AgentCorpusVerificationError("Prepared Agent Corpus digest changed during installation");
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const rollback = async (): Promise<void> => {
    if (state === "rolled_back" || state === "finalized") return;
    if (state === "prepared") {
      await rm(temporary, { recursive: true, force: true });
      state = "rolled_back";
      return;
    }

    const failedCurrent = path.join(path.dirname(destination), `.${verified.agentId}.${transactionId}.failed`);
    if (hadCurrent) {
      if (!(await pathExists(backup))) {
        throw new Error(`Cannot roll back Agent Corpus install because backup is missing: ${backup}`);
      }
      let displacedCurrent = false;
      if (await pathExists(destination)) {
        await rename(destination, failedCurrent);
        displacedCurrent = true;
      }
      try {
        await rename(backup, destination);
      } catch (error) {
        if (displacedCurrent) await rename(failedCurrent, destination).catch(() => undefined);
        throw error;
      }
      if (displacedCurrent) await rm(failedCurrent, { recursive: true, force: true });
    } else {
      await rm(destination, { recursive: true, force: true });
    }
    await rm(temporary, { recursive: true, force: true });
    state = "rolled_back";
  };

  return {
    currentPath: destination,
    preparedPath: temporary,
    backupPath: backup,
    async commit(): Promise<string> {
      if (state !== "prepared") throw new Error(`Agent Corpus install cannot commit from state ${state}`);
      throwIfAborted(options.signal);
      hadCurrent = await pathExists(destination);
      if (hadCurrent) await rename(destination, backup);
      try {
        await rename(temporary, destination);
        state = "committed";
        return destination;
      } catch (error) {
        if (hadCurrent) {
          try {
            await rename(backup, destination);
          } catch (restoreError) {
            state = "recovery_needed";
            throw new AggregateError([error, restoreError], "Agent Corpus commit failed and its previous current version could not be restored");
          }
        }
        await rm(temporary, { recursive: true, force: true });
        state = "rolled_back";
        throw error;
      }
    },
    rollback,
    async finalize(): Promise<void> {
      if (state === "finalized") return;
      if (state !== "committed") throw new Error(`Agent Corpus install cannot finalize from state ${state}`);
      await rm(backup, { recursive: true, force: true });
      await rm(temporary, { recursive: true, force: true });
      state = "finalized";
    },
  };
}

export async function installCurrentCorpus(verified: VerifiedAgentCorpus, destinationRoot: string): Promise<string> {
  const transaction = await prepareCurrentCorpusInstall(verified, destinationRoot);
  try {
    const destination = await transaction.commit();
    await transaction.finalize();
    return destination;
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  }
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

async function filesUnder(root: string, signal?: AbortSignal): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    throwIfAborted(signal);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      throwIfAborted(signal);
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

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(filePath, { signal })).digest("hex")}`;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Agent Corpus operation was aborted");
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
