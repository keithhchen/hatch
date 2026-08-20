import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { isObjectStoreNotFound, type ArtifactObjectStore, type ObjectStoreObject } from "./creatorLearning/objectStore.js";
import type { NodeScope } from "./node.js";

const MAX_READ_BYTES = 1_000_000;
const pathSchema = Type.String({ minLength: 1, maxLength: 512 });

/** The runtime owns the backend. Agents only see logical read tools. */
export type NodeStorage = {
  objectStore: ArtifactObjectStore;
};

export type NodeInput = Record<string, unknown>;

export class NodeOssStore {
  constructor(private readonly storage: NodeStorage) {}

  async readReference(scope: NodeScope, reference: string): Promise<string> {
    const key = objectReference(scope.productId, reference);
    const content = await this.storage.objectStore.get(key);
    if (content.byteLength > MAX_READ_BYTES) {
      throw new Error(`Node read is limited to ${MAX_READ_BYTES} bytes: ${key}`);
    }
    return content.toString("utf8");
  }

  async readInput(
    input: NodeInput,
    requestedPath: string
  ): Promise<{ name: string; path: string; content: string; bytes: number }> {
    const manifest = buildInputManifest(input);
    const key = resolveInputPath(manifest, requestedPath);
    const content = await this.storage.objectStore.get(key);
    if (content.byteLength > MAX_READ_BYTES) {
      throw new Error(`Node read is limited to ${MAX_READ_BYTES} bytes: ${key}`);
    }
    return {
      name: requestedPath,
      path: key,
      content: content.toString("utf8"),
      bytes: content.byteLength
    };
  }

  async write(scope: NodeScope, name: string, value: unknown): Promise<ObjectStoreObject> {
    const normalizedName = validateNodeName(name);
    return this.storage.objectStore.put(
      nodeKey(scope, normalizedName),
      Buffer.from(jsonValue(value, "Node write"), "utf8"),
      { contentType: "application/json; charset=utf-8", immutable: false }
    );
  }

  async writeImmutable(scope: NodeScope, name: string, value: unknown): Promise<ObjectStoreObject> {
    const normalizedName = validateNodeName(name);
    return this.storage.objectStore.put(
      nodeKey(scope, normalizedName),
      Buffer.from(jsonValue(value, "Node artifact"), "utf8"),
      { contentType: "application/json; charset=utf-8", immutable: true }
    );
  }

  async writeOutput(scope: NodeScope, value: unknown): Promise<ObjectStoreObject> {
    return this.storage.objectStore.put(
      nodeKey(scope, "output.json"),
      Buffer.from(jsonValue(value, "Node output"), "utf8"),
      { contentType: "application/json; charset=utf-8", immutable: true }
    );
  }

  async writeInput(scope: NodeScope, value: unknown): Promise<ObjectStoreObject> {
    return this.storage.objectStore.put(
      nodeKey(scope, "input.json"),
      Buffer.from(jsonValue(value, "Node input"), "utf8"),
      { contentType: "application/json; charset=utf-8", immutable: true }
    );
  }

}

/**
 * Create the only storage tools exposed to a Node Agent.
 *
 * `input` is the parsed Node input. The Runtime expands it into an immutable
 * allow-list before the Agent starts. The model can use an exact declared OSS
 * key or a deterministic relative alias; it never chooses a backend or reads
 * an undeclared object.
 */
export function createNodeStorageTools(
  storage: NodeStorage,
  scope: NodeScope,
  input: NodeInput
): AgentTool[] {
  const nodeStore = new NodeOssStore(storage);
  const manifest = buildInputManifest(input);
  const read: AgentTool = {
    name: "read",
    label: "read",
    description: `Read one declared input object. Pass its complete OSS object path, or a listed relative alias. Allowed paths: ${manifest.keys.sort().join(", ") || "none"}. Aliases: ${[...manifest.aliases.keys()].sort().join(", ") || "none"}.`,
    parameters: Type.Object({
      path: pathSchema
    }, { additionalProperties: false }),
    execute: async (_toolCallId, args, signal) => {
      signal?.throwIfAborted();
      const value = args as { path: string };
      const result = await nodeStore.readInput(input, value.path);
      signal?.throwIfAborted();
      return toolResult(result);
    }
  };

  return [read];
}

function toolResult(details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details
  };
}

function nodeKey(scope: NodeScope, name: string): string {
  return [
    safePart(scope.productId),
    safePart(scope.nodeName),
    safePart(scope.executionId),
    safeRelativeReference(name)
  ].join("/");
}

/** Stable OSS object path used inside Node prompts. */
export function nodeObjectReference(scope: NodeScope, name: string): string {
  return [safePart(scope.productId), safePart(scope.nodeName), safePart(scope.executionId), safeRelativeReference(name)].join("/");
}

function objectReference(productId: string, reference: string): string {
  const normalized = safeRelativeReference(reference);
  if (!normalized.split("/").includes(safePart(productId))) {
    throw new Error(`OSS reference does not belong to product ${productId}: ${reference}`);
  }
  return normalized;
}

function jsonValue(value: unknown, label: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${label} must be JSON serializable`);
  return serialized;
}

function validateNodeName(value: string): string {
  const normalized = safeRelativeReference(value);
  if (normalized === "output.json") {
    throw new Error("output.json is reserved for the Node result");
  }
  return normalized;
}

function safeRelativeReference(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`OSS reference must be a non-empty relative path: ${value}`);
  }
  return normalized;
}

type NodeInputManifest = {
  keys: string[];
  aliases: Map<string, string>;
};

function buildInputManifest(input: NodeInput): NodeInputManifest {
  const keys = new Set<string>();
  const aliasCandidates = new Map<string, Set<string>>();
  for (const value of Object.values(input)) {
    const references = Array.isArray(value) ? value : [value];
    for (const reference of references) {
      if (typeof reference !== "string" || !reference.trim()) continue;
      const key = safeRelativeReference(reference);
      keys.add(key);
      const basename = key.split("/").at(-1);
      if (basename) addAlias(aliasCandidates, basename, key);
    }
  }
  const aliases = new Map<string, string>();
  for (const [alias, candidates] of aliasCandidates) {
    if (candidates.size === 1) aliases.set(alias, [...candidates][0]!);
  }
  return { keys: [...keys], aliases };
}

function addAlias(candidates: Map<string, Set<string>>, alias: string, key: string): void {
  const normalized = safeRelativeReference(alias);
  const values = candidates.get(normalized) ?? new Set<string>();
  values.add(key);
  candidates.set(normalized, values);
}

function resolveInputPath(manifest: NodeInputManifest, requestedPath: string): string {
  const normalized = safeRelativeReference(requestedPath);
  if (manifest.keys.includes(normalized)) return normalized;
  const resolved = manifest.aliases.get(normalized);
  if (resolved) return resolved;
  throw new Error(`Node read path is not declared in input manifest: ${requestedPath}`);
}

function safePart(value: string): string {
  const normalized = value.trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Node OSS scope value is not safe: ${value}`);
  }
  return normalized;
}

export function isNodeOssNotFound(error: unknown): boolean {
  return isObjectStoreNotFound(error)
    || Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT");
}
