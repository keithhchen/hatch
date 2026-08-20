import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { isObjectStoreNotFound, type ArtifactObjectStore, type ObjectStoreObject } from "./creatorLearning/objectStore.js";
import type { NodeScope } from "./node.js";

const MAX_READ_BYTES = 1_000_000;
const fileNameSchema = Type.String({ minLength: 1, maxLength: 512 });

/** The runtime owns the backend. Agents only see logical read/write tools. */
export type NodeStorage = {
  objectStore: ArtifactObjectStore;
};

export type NodeInput = Record<string, unknown>;

export class NodeOssStore {
  constructor(private readonly storage: NodeStorage) {}

  async readJson(scope: NodeScope, reference: string): Promise<unknown> {
    const key = safeRelativeReference(reference);
    const content = await this.storage.objectStore.get(key);
    if (content.byteLength > MAX_READ_BYTES) {
      throw new Error(`Node artifact read is limited to ${MAX_READ_BYTES} bytes: ${key}`);
    }
    return JSON.parse(content.toString("utf8")) as unknown;
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

  async readInput(
    scope: NodeScope,
    input: NodeInput,
    inputName: string,
    fileName?: string
  ): Promise<{ name: string; content: string; bytes: number }> {
    const rawReference = input[inputName];
    if (typeof rawReference !== "string" || !rawReference.trim()) {
      throw new Error(`Node input ${inputName} must contain an OSS reference`);
    }

    const reference = safeRelativeReference(rawReference);
    const key = fileName === undefined
      ? reference
      : await this.resolveSnapshotFile(reference, fileName);
    const content = await this.storage.objectStore.get(key);
    if (content.byteLength > MAX_READ_BYTES) {
      throw new Error(`Node read is limited to ${MAX_READ_BYTES} bytes: ${key}`);
    }
    return {
      name: fileName ?? inputName,
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

  async writeOutput(scope: NodeScope, value: unknown): Promise<ObjectStoreObject> {
    return this.storage.objectStore.put(
      nodeKey(scope, "output.json"),
      Buffer.from(jsonValue(value, "Node output"), "utf8"),
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

  private async resolveSnapshotFile(snapshotReference: string, fileName: string): Promise<string> {
    const normalizedFileName = safeRelativeReference(fileName);
    const normalizedSnapshot = safeRelativeReference(snapshotReference);
    const snapshotKey = normalizedSnapshot;
    const snapshot = JSON.parse((await this.storage.objectStore.get(snapshotKey)).toString("utf8")) as unknown;
    const entry = snapshotFileEntry(snapshot, normalizedFileName);
    if (!entry) {
      throw new Error(`File ${normalizedFileName} is not listed by snapshot ${snapshotReference}`);
    }
    if (entry.reference) return safeRelativeReference(entry.reference);
    const parent = parentPath(normalizedSnapshot);
    return parent ? `${parent}/${normalizedFileName}` : normalizedFileName;
  }
}

/**
 * Create the only storage tools exposed to a Node Agent.
 *
 * `input` is the parsed Node input. The model chooses an input slot and an
 * optional file name; it never chooses a backend or an absolute object key.
 */
export function createNodeStorageTools(
  storage: NodeStorage,
  scope: NodeScope,
  input: NodeInput,
  access: "read" | "read_write" = "read_write"
): AgentTool[] {
  const nodeStore = new NodeOssStore(storage);
  const inputNames = Object.keys(input).filter((name) => /^[A-Za-z0-9._-]+$/.test(name));
  const inputSlotSchema = inputNames.length === 1
    ? Type.Literal(inputNames[0]!)
    : Type.Union(inputNames.map((name) => Type.Literal(name)));
  const inputSlotDescription = inputNames.length
    ? `Choose exactly one input slot: ${inputNames.join(", ")}. Do not put an OSS path or URI in input.`
    : "No input slots are available.";
  const read: AgentTool = {
    name: "read",
    label: "read",
    description: `Read a Runtime-provided input reference. ${inputSlotDescription} For a snapshot slot, provide the source file's display name in name; never put the snapshot OSS path in input or name.`,
    parameters: Type.Object({
      input: inputSlotSchema,
      name: Type.Optional(fileNameSchema)
    }, { additionalProperties: false }),
    execute: async (_toolCallId, args, signal) => {
      signal?.throwIfAborted();
      const value = args as { input: string; name?: string };
      const result = await nodeStore.readInput(scope, input, value.input, value.name);
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
      name: fileNameSchema,
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

function snapshotFileEntry(value: unknown, expectedName: string): { reference?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files)) return undefined;
  for (const entry of files) {
    if (typeof entry === "string") {
      if (safeRelativeReference(entry) === expectedName) return {};
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as {
      name?: unknown;
      displayName?: unknown;
      ref?: unknown;
      contentRef?: unknown;
      projection?: { contentRef?: unknown };
    };
    const name = record.name ?? record.displayName;
    if (typeof name !== "string" || safeRelativeReference(name) !== expectedName) continue;
    const reference = record.ref ?? record.contentRef ?? record.projection?.contentRef;
    return typeof reference === "string" ? { reference } : {};
  }
  return undefined;
}

function parentPath(value: string): string {
  const parts = safeRelativeReference(value).split("/");
  parts.pop();
  return parts.join("/");
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
