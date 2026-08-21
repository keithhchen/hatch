import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { isObjectStoreNotFound, type ArtifactObjectStore, type ObjectStoreObject } from "./creatorLearning/objectStore.js";
import { normalizeNodeObjectPath, type NodeScope } from "./node.js";

const MAX_READ_BYTES = 1_000_000;
const objectPathSchema = Type.String({ minLength: 1, maxLength: 512 });

/** The runtime owns the backend. Agents only see scoped read/write tools. */
export type NodeStorage = {
  objectStore: ArtifactObjectStore;
};

export type NodeInput = Record<string, unknown>;

export class NodeOssStore {
  constructor(private readonly storage: NodeStorage) {}

  async readJson(scope: NodeScope, reference: string): Promise<unknown> {
    const { content } = await this.readObject(nodeArtifactReference(scope, reference));
    return JSON.parse(content.toString("utf8")) as unknown;
  }

  async readPath(
    scope: NodeScope,
    input: NodeInput,
    reference: string
  ): Promise<{ path: string; content: string; bytes: number }> {
    const key = resolveDeclaredInputPath(input, reference);
    const object = await this.readObject(key);
    return {
      path: object.key,
      content: object.content.toString("utf8"),
      bytes: object.content.byteLength
    };
  }

  async readCandidate(scope: NodeScope, round: number): Promise<{ key: string; value: unknown } | undefined> {
    if (!Number.isInteger(round) || round < 1) throw new Error(`Node candidate round must be a positive integer: ${round}`);
    const key = nodeKey(scope, `candidate-${round}.json`);
    try {
      return { key, value: await this.readJson(scope, key) };
    } catch (error) {
      if (isNodeOssNotFound(error)) return undefined;
      throw error;
    }
  }

  async write(scope: NodeScope, name: string, value: unknown): Promise<ObjectStoreObject> {
    const normalizedName = validateNodeName(name);
    return this.storage.objectStore.put(
      nodeKey(scope, normalizedName),
      Buffer.from(jsonValue(value, "Node write"), "utf8"),
      { contentType: "application/json; charset=utf-8", immutable: false }
    );
  }

  /** Host-owned immutable artifact, used for hand-offs between Nodes. */
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

  /** Runtime-owned immutable input manifest. The manifest contains refs only. */
  async writeInput(scope: NodeScope, value: unknown): Promise<ObjectStoreObject> {
    return this.storage.objectStore.put(
      nodeKey(scope, "input.json"),
      Buffer.from(jsonValue(value, "Node input"), "utf8"),
      { contentType: "application/json; charset=utf-8", immutable: true }
    );
  }

  /** Runtime-owned candidate persistence; Agents never choose this path. */
  async writeCandidate(scope: NodeScope, round: number, value: unknown): Promise<ObjectStoreObject> {
    if (!Number.isInteger(round) || round < 1) throw new Error(`Node candidate round must be a positive integer: ${round}`);
    return this.storage.objectStore.put(
      nodeKey(scope, `candidate-${round}.json`),
      Buffer.from(jsonValue(value, "Node candidate"), "utf8"),
      { contentType: "application/json; charset=utf-8", immutable: true }
    );
  }

  /** Runtime-owned feedback persistence; Agents only receive its OSS ref. */
  async writeFeedback(scope: NodeScope, round: number, value: unknown): Promise<ObjectStoreObject> {
    if (!Number.isInteger(round) || round < 1) throw new Error(`Node feedback round must be a positive integer: ${round}`);
    return this.storage.objectStore.put(
      nodeKey(scope, `feedback-${round}-${randomUUID()}.json`),
      Buffer.from(jsonValue(value, "Node feedback"), "utf8"),
      { contentType: "application/json; charset=utf-8", immutable: true }
    );
  }

  private async readObject(reference: string): Promise<{ key: string; content: Buffer }> {
    const key = safeObjectKey(reference);
    const content = await this.storage.objectStore.get(key);
    if (content.byteLength > MAX_READ_BYTES) {
      throw new Error(`Node artifact read is limited to ${MAX_READ_BYTES} bytes: ${key}`);
    }
    return { key, content };
  }
}

/**
 * Create the only storage tools exposed to a Node Agent.
 *
 * `input` is the parsed Node input. The model chooses one exact OSS object
 * path from the input manifest; it never chooses a backend or an undeclared
 * object key.
 */
export function createNodeStorageTools(
  storage: NodeStorage,
  scope: NodeScope,
  input: NodeInput,
  access: "read" | "read_write" = "read_write"
): AgentTool[] {
  const nodeStore = new NodeOssStore(storage);
  const read: AgentTool = {
    name: "read",
    label: "read",
    description: "Read one file declared in the current Node input. Use its full OSS object path, or a unique relative path from the input list; do not invent a path.",
    parameters: Type.Object({
      path: objectPathSchema
    }, { additionalProperties: false }),
    execute: async (_toolCallId, args, signal) => {
      signal?.throwIfAborted();
      const value = args as { path: string };
      const result = await nodeStore.readPath(scope, input, value.path);
      signal?.throwIfAborted();
      return toolResult(result);
    }
  };

  if (access === "read") return [read];

  const write: AgentTool = {
    name: "write",
    label: "write",
    description: "Write JSON to this Node's OSS namespace. Provide a relative name such as scratch/draft.json.",
    parameters: Type.Object({
      name: objectPathSchema,
      value: Type.Unknown()
    }, { additionalProperties: false }),
    execute: async (_toolCallId, args, signal) => {
      signal?.throwIfAborted();
      const value = args as { name: string; value: unknown };
      const object = await nodeStore.write(scope, value.name, value.value);
      signal?.throwIfAborted();
      return toolResult({ name: value.name, bytes: object.bytes });
    }
  };

  return [read, write];
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

function nodeArtifactReference(scope: NodeScope, reference: string): string {
  const key = safeObjectKey(reference);
  const prefix = `${safePart(scope.productId)}/${safePart(scope.nodeName)}/${safePart(scope.executionId)}/`;
  if (!key.startsWith(prefix)) {
    throw new Error(`Node artifact reference is outside the current execution: ${reference}`);
  }
  return key;
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

function safeObjectKey(value: string): string {
  return normalizeNodeObjectPath(value);
}

function collectInputReferences(input: NodeInput): Set<string> {
  const references = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) {
      try {
        references.add(safeObjectKey(value));
      } catch {
        // Non-reference scalar input remains part of the Node input but is
        // not readable through the OSS tool.
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(input);
  return references;
}

function resolveDeclaredInputPath(input: NodeInput, requestedPath: string): string {
  const requested = safeObjectKey(requestedPath);
  const declared = [...collectInputReferences(input)];
  const exact = declared.find((reference) => reference === requested);
  if (exact) return exact;

  const suffix = `/${requested}`;
  const matches = declared.filter((reference) => reference.endsWith(suffix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Node read path is ambiguous; use the full OSS object path: ${requestedPath}`);
  }
  throw new Error(`Node read path is not declared in the current input: ${requestedPath}`);
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
