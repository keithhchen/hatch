import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { ArtifactObjectStore } from "./objectStore.js";
import type { DistillationGraphStore } from "./distillationGraph.js";
import type {
  FactorySource,
  SourceDocumentRecord,
  SourceProjection,
  SourceSnapshotRecord
} from "./types.js";

export const SOURCE_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
const SAFE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type SourceUploadInput = {
  displayName: string;
  taskId?: string;
  mediaType?: string;
  bytes: Buffer;
};

export class CreatorSourceLibraryError extends Error {
  constructor(
    readonly code:
      | "source_not_found"
      | "snapshot_not_found"
      | "creator_mismatch"
      | "invalid_source"
      | "invalid_snapshot"
      | "projection_failed",
    message: string
  ) {
    super(message);
    this.name = "CreatorSourceLibraryError";
  }
}

export type SourceDocumentView = SourceDocumentRecord & {
  projectionContent?: string;
  projectionBase64?: string;
};

export type SourceSnapshotView = SourceSnapshotRecord & {
  documents: SourceDocumentRecord[];
};

/**
 * Creator-private Source Library. Original bytes and projections live outside
 * the static web root; JSON metadata is the durable index used by the
 * authenticated Registry route. A locked Snapshot is immutable.
 */
export class CreatorSourceLibrary {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly objectStore?: ArtifactObjectStore,
    private readonly graphStore?: DistillationGraphStore
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async createFromUpload(creatorId: string, input: SourceUploadInput): Promise<SourceDocumentView> {
    return this.write(async () => {
      const normalizedCreator = requireText(creatorId, "creatorId");
      const taskId = safeTaskId(input.taskId ?? "default");
      const displayName = safeDisplayName(input.displayName);
      if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) {
        throw invalidSource("Source bytes are required");
      }
      if (input.bytes.length > SOURCE_DOCUMENT_MAX_BYTES) {
        throw invalidSource(`Source exceeds ${SOURCE_DOCUMENT_MAX_BYTES} bytes`);
      }
      const id = `src_${randomUUID().replaceAll("-", "")}`;
      const mediaType = detectMediaType(displayName, input.mediaType, input.bytes);
      const projection = await projectSource(displayName, mediaType, input.bytes);
      const projectionText = projection.kind === "markdown" ? readProjectionText(projection) : undefined;
      const storedProjection: SourceProjection = projection.kind === "image"
        ? projection
        : {
            kind: projection.kind,
            mediaType: projection.mediaType,
            contentRef: "",
            sha256: projection.sha256,
            bytes: projection.bytes
          };
      if (this.objectStore) {
        const base = this.objectBase(normalizedCreator, taskId, id);
        const originalObjectRef = `${base}/original.bin`;
        const projectionObjectRef = `${base}/projection.${projection.kind === "image" ? projection.mediaType.split("/", 2)[1] : "md"}`;
        const record: SourceDocumentRecord = {
          id,
          creatorId: normalizedCreator,
          taskId,
          displayName,
          mediaType,
          originalObjectRef,
          projection: { ...storedProjection, contentRef: projectionObjectRef },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await this.objectStore.put(originalObjectRef, input.bytes, { contentType: mediaType, immutable: true });
        await this.objectStore.put(
          projectionObjectRef,
          projection.kind === "image" ? input.bytes : Buffer.from(await projectionText!, "utf8"),
          { contentType: projection.mediaType, immutable: true }
        );
        await this.objectStore.put(`${base}/document.json`, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"), {
          contentType: "application/json; charset=utf-8",
          immutable: true
        });
        await this.recordUploadedArtifacts(record, input.bytes, projection, originalObjectRef, projectionObjectRef);
        return this.withProjectionContent(record);
      }
      const creatorDirectory = this.creatorDirectory(normalizedCreator);
      await mkdir(path.join(creatorDirectory, "original"), { recursive: true });
      await mkdir(path.join(creatorDirectory, "projections"), { recursive: true });
      await mkdir(path.join(creatorDirectory, "documents"), { recursive: true });
      const originalPath = path.join(creatorDirectory, "original", `${id}.bin`);
      const projectionPath = path.join(creatorDirectory, projection.kind === "image" ? "projections" : "projections", projectionFileName(id, projection));
      await atomicWrite(originalPath, input.bytes);
      await atomicWrite(projectionPath, projection.kind === "image"
        ? input.bytes
        : Buffer.from(await projectionText!, "utf8"));
      const record: SourceDocumentRecord = {
        id,
        creatorId: normalizedCreator,
        taskId,
        displayName,
        mediaType,
        originalObjectRef: this.relativeRef(originalPath, creatorDirectory),
        projection: { ...storedProjection, contentRef: this.relativeRef(projectionPath, creatorDirectory) },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await atomicWrite(path.join(creatorDirectory, "documents", `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
      await this.recordUploadedArtifacts(record, input.bytes, projection, record.originalObjectRef!, record.projection.contentRef);
      return this.withProjectionContent(record);
    });
  }

  async listDocuments(creatorId: string, taskId?: string): Promise<SourceDocumentView[]> {
    await this.writeChain;
    if (this.objectStore) {
      const normalizedCreator = requireText(creatorId, "creatorId");
      const prefix = this.sourcePrefix(normalizedCreator, taskId === undefined ? undefined : safeTaskId(taskId));
      const names = (await this.objectStore.list(prefix)).filter((name) => name.endsWith("/document.json"));
      const records = await Promise.all(names.map(async (name) => this.readDocumentObject(name)));
      return Promise.all(records
        .filter((record) => taskId === undefined || record.taskId === safeTaskId(taskId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((record) => this.withProjectionContent(record)));
    }
    const directory = path.join(this.creatorDirectory(requireText(creatorId, "creatorId")), "documents");
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records = await Promise.all(names.map(async (name) => this.readDocumentFile(path.join(directory, name))));
    const filtered = taskId === undefined ? records : records.filter((record) => record.taskId === safeTaskId(taskId));
    return Promise.all(filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((record) => this.withProjectionContent(record)));
  }

  async getDocument(creatorId: string, documentId: string): Promise<SourceDocumentView> {
    await this.writeChain;
    const record = await this.requireDocument(creatorId, documentId);
    return this.withProjectionContent(record);
  }

  async createSnapshot(creatorId: string, input: { documentIds: string[]; taskId?: string }): Promise<SourceSnapshotView> {
    return this.write(async () => {
      const normalizedCreator = requireText(creatorId, "creatorId");
      const documentIds = [...new Set(input.documentIds.map((id) => requireText(id, "documentId")))];
      if (documentIds.length === 0) throw new CreatorSourceLibraryError("invalid_snapshot", "A Snapshot needs at least one source");
      const documents = await Promise.all(documentIds.map((id) => this.requireDocument(normalizedCreator, id)));
      const taskId = input.taskId === undefined ? documents[0]!.taskId : safeTaskId(input.taskId);
      if (documents.some((document) => document.taskId !== taskId)) {
        throw new CreatorSourceLibraryError("invalid_snapshot", "A Snapshot can contain sources from only one Task");
      }
      const createdAt = new Date().toISOString();
      const version = await this.nextSnapshotVersion(normalizedCreator);
      const manifestSha256 = digestJson({
        contractVersion: "source-snapshot-v1",
        creatorId: normalizedCreator,
        taskId: input.taskId ?? null,
        version,
        documents: documents.map((document) => ({
          id: document.id,
          projection: document.projection
        }))
      });
      const record: SourceSnapshotRecord = {
        id: `snapshot_${randomUUID().replaceAll("-", "")}`,
        creatorId: normalizedCreator,
        taskId,
        version,
        documentIds,
        manifestSha256,
        lockedAt: createdAt,
        createdAt
      };
      const content = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      if (this.objectStore) {
        const objectKey = `${this.sourcePrefix(normalizedCreator, taskId)}/snapshots/${record.id}.json`;
        await this.objectStore.put(objectKey, content, {
          contentType: "application/json; charset=utf-8",
          immutable: true
        });
        await this.recordSnapshotArtifact(record, objectKey, content, normalizedCreator);
      } else {
        const directory = this.creatorDirectory(normalizedCreator);
        await mkdir(path.join(directory, "snapshots"), { recursive: true });
        const file = path.join(directory, "snapshots", `${record.id}.json`);
        await atomicWrite(file, content);
        await this.recordSnapshotArtifact(record, this.relativeRef(file, directory), content, normalizedCreator);
      }
      return { ...record, documents };
    });
  }

  async getSnapshot(creatorId: string, snapshotId: string): Promise<SourceSnapshotView> {
    await this.writeChain;
    const normalizedCreator = requireText(creatorId, "creatorId");
    if (this.objectStore) {
      const names = (await this.objectStore.list(this.sourcePrefix(normalizedCreator))).filter((name) => name.endsWith(`/${safeId(snapshotId)}.json`));
      if (names.length === 0) throw new CreatorSourceLibraryError("snapshot_not_found", `Source Snapshot ${snapshotId} was not found`);
      const snapshot = JSON.parse((await this.objectStore.get(names[0]!)).toString("utf8")) as SourceSnapshotRecord;
      if (snapshot.creatorId !== normalizedCreator) throw new CreatorSourceLibraryError("creator_mismatch", "Source Snapshot belongs to another Creator");
      const documents = await Promise.all(snapshot.documentIds.map((id) => this.requireDocument(normalizedCreator, id)));
      return { ...snapshot, documents };
    }
    const file = path.join(this.creatorDirectory(normalizedCreator), "snapshots", `${safeId(snapshotId)}.json`);
    let snapshot: SourceSnapshotRecord;
    try {
      snapshot = JSON.parse(await readFile(file, "utf8")) as SourceSnapshotRecord;
    } catch (error) {
      if (isMissing(error)) throw new CreatorSourceLibraryError("snapshot_not_found", `Source Snapshot ${snapshotId} was not found`);
      throw error;
    }
    if (snapshot.creatorId !== normalizedCreator) throw new CreatorSourceLibraryError("creator_mismatch", "Source Snapshot belongs to another Creator");
    const documents = await Promise.all(snapshot.documentIds.map((id) => this.requireDocument(normalizedCreator, id)));
    return { ...snapshot, documents };
  }

  async resolveSnapshotSources(creatorId: string, snapshotId: string): Promise<FactorySource[]> {
    const snapshot = await this.getSnapshot(creatorId, snapshotId);
    return Promise.all(snapshot.documents.map(async (document, index) => {
      const sourceId = `S${index + 1}`;
      if (document.projection.kind === "image") {
        const bytes = await this.readRef(creatorId, document.projection.contentRef);
        return {
          id: sourceId,
          authority: "private_material" as const,
          title: document.displayName,
          content: `[Native image source: ${document.displayName}]`,
          image: {
            mediaType: document.projection.mediaType,
            base64: bytes.toString("base64"),
            sha256: document.projection.sha256
          }
        };
      }
      const content = await this.readRef(creatorId, document.projection.contentRef);
      return {
        id: sourceId,
        authority: "private_material" as const,
        title: document.displayName,
        content: content.toString("utf8")
      };
    }));
  }

  private async nextSnapshotVersion(creatorId: string): Promise<number> {
    if (this.objectStore) {
      const names = (await this.objectStore.list(this.sourcePrefix(requireText(creatorId, "creatorId")))).filter((name) => name.includes("/snapshots/") && name.endsWith(".json"));
      const versions = await Promise.all(names.map(async (name) => {
        try {
          const value = JSON.parse((await this.objectStore!.get(name)).toString("utf8")) as { version?: unknown };
          return typeof value.version === "number" ? value.version : 0;
        } catch {
          return 0;
        }
      }));
      return Math.max(0, ...versions) + 1;
    }
    const directory = path.join(this.creatorDirectory(creatorId), "snapshots");
    try {
      const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
      const versions = await Promise.all(names.map(async (name) => {
        try {
          const value = JSON.parse(await readFile(path.join(directory, name), "utf8")) as { version?: unknown };
          return typeof value.version === "number" ? value.version : 0;
        } catch {
          return 0;
        }
      }));
      return Math.max(0, ...versions) + 1;
    } catch (error) {
      if (isMissing(error)) return 1;
      throw error;
    }
  }

  private async requireDocument(creatorId: string, documentId: string): Promise<SourceDocumentRecord> {
    if (this.objectStore) {
      const normalizedCreator = requireText(creatorId, "creatorId");
      const names = (await this.objectStore.list(this.sourcePrefix(normalizedCreator))).filter((name) => name.endsWith("/document.json"));
      for (const name of names) {
        const record = await this.readDocumentObject(name);
        if (record.id !== safeId(documentId)) continue;
        if (record.creatorId !== normalizedCreator) throw new CreatorSourceLibraryError("creator_mismatch", "Source belongs to another Creator");
        return record;
      }
      throw new CreatorSourceLibraryError("source_not_found", `Source ${documentId} was not found`);
    }
    const file = path.join(this.creatorDirectory(requireText(creatorId, "creatorId")), "documents", `${safeId(documentId)}.json`);
    try {
      const record = await this.readDocumentFile(file);
      if (record.creatorId !== creatorId) throw new CreatorSourceLibraryError("creator_mismatch", "Source belongs to another Creator");
      return record;
    } catch (error) {
      if (error instanceof CreatorSourceLibraryError) throw error;
      if (isMissing(error)) throw new CreatorSourceLibraryError("source_not_found", `Source ${documentId} was not found`);
      throw error;
    }
  }

  private async readDocumentFile(file: string): Promise<SourceDocumentRecord> {
    const value = JSON.parse(await readFile(file, "utf8")) as SourceDocumentRecord;
    if (!value || typeof value.id !== "string" || !value.projection) throw invalidSource("Source metadata is invalid");
    return value;
  }

  private async readDocumentObject(key: string): Promise<SourceDocumentRecord> {
    if (!this.objectStore) throw new Error("Object Store is not configured");
    const value = JSON.parse((await this.objectStore.get(key)).toString("utf8")) as SourceDocumentRecord;
    if (!value || typeof value.id !== "string" || !value.projection) throw invalidSource("Source metadata is invalid");
    return value;
  }

  private async recordUploadedArtifacts(
    record: SourceDocumentRecord,
    original: Buffer,
    projection: SourceProjection,
    originalObjectRef: string,
    projectionObjectRef: string
  ): Promise<void> {
    if (!this.graphStore) return;
    await this.graphStore.initialize();
    const originalArtifactId = sourceArtifactId(record.id, "original", digestBytes(original));
    const projectionArtifactId = sourceArtifactId(record.id, "projection", projection.sha256);
    await this.graphStore.registerArtifact({ artifactId: originalArtifactId, taskId: record.taskId, kind: "source_original", objectKey: originalObjectRef, sha256: digestBytes(original), bytes: original.length, mediaType: record.mediaType, createdAt: record.createdAt });
    await this.graphStore.registerArtifact({ artifactId: projectionArtifactId, taskId: record.taskId, kind: "source_projection", objectKey: projectionObjectRef, sha256: projection.sha256, bytes: projection.bytes, mediaType: projection.mediaType, createdAt: record.createdAt });
    const parents = (await this.graphStore.listEvents(record.taskId)).at(-1);
    await this.graphStore.appendEvent({
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      eventKey: `${record.taskId}:source:${record.id}`,
      taskId: record.taskId,
      runId: record.taskId,
      type: "source_uploaded",
      node: "intake",
      actor: "creator",
      parentEventIds: parents ? [parents.id] : [],
      artifactIds: [originalArtifactId, projectionArtifactId],
      payload: { documentId: record.id, mediaType: record.mediaType, projectionKind: projection.kind }
    });
  }

  private async recordSnapshotArtifact(record: SourceSnapshotRecord, objectKey: string, content: Buffer, creatorId: string): Promise<void> {
    if (!this.graphStore) return;
    await this.graphStore.initialize();
    const artifactId = sourceArtifactId(record.id, "snapshot", digestBytes(content));
    await this.graphStore.registerArtifact({ artifactId, taskId: record.taskId ?? creatorId, kind: "source_snapshot", objectKey, sha256: digestBytes(content), bytes: content.length, mediaType: "application/json", createdAt: record.createdAt });
    const taskId = record.taskId ?? creatorId;
    const parents = (await this.graphStore.listEvents(taskId)).at(-1);
    await this.graphStore.appendEvent({
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      eventKey: `${taskId}:snapshot:${record.id}`,
      taskId,
      runId: taskId,
      type: "snapshot_locked",
      node: "intake",
      actor: "system",
      parentEventIds: parents ? [parents.id] : [],
      artifactIds: [artifactId],
      payload: { snapshotId: record.id, version: record.version, manifestSha256: record.manifestSha256 }
    });
  }

  private async withProjectionContent(record: SourceDocumentRecord): Promise<SourceDocumentView> {
    const bytes = await this.readRef(record.creatorId, record.projection.contentRef);
    return record.projection.kind === "image"
      ? { ...record, projectionBase64: bytes.toString("base64") }
      : { ...record, projectionContent: bytes.toString("utf8") };
  }

  private async readRef(creatorId: string, reference: string): Promise<Buffer> {
    if (this.objectStore) return this.objectStore.get(reference);
    const root = this.creatorDirectory(creatorId);
    const resolved = path.resolve(root, reference);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw invalidSource("Source reference escapes Creator storage");
    return readFile(resolved);
  }

  private creatorDirectory(creatorId: string): string {
    return path.join(this.root, hashId(requireText(creatorId, "creatorId")));
  }

  private relativeRef(file: string, creatorDirectory: string): string {
    return path.relative(creatorDirectory, file).replaceAll("\\", "/").replace(/^\.\//, "");
  }

  private sourcePrefix(creatorId: string, taskId?: string): string {
    const creator = hashId(requireText(creatorId, "creatorId"));
    return `source-library/${creator}/tasks${taskId ? `/${safeTaskId(taskId)}` : ""}`;
  }

  private objectBase(creatorId: string, taskId: string, documentId: string): string {
    return `${this.sourcePrefix(creatorId, taskId)}/documents/${safeId(documentId)}`;
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

async function projectSource(displayName: string, mediaType: string, bytes: Buffer): Promise<SourceProjection> {
  if (SAFE_IMAGE_TYPES.has(mediaType)) {
    assertImageMagic(mediaType, bytes);
    return { kind: "image", mediaType: mediaType as "image/jpeg" | "image/png" | "image/webp", contentRef: "", sha256: digestBytes(bytes), bytes: bytes.length };
  }
  let markdown: string;
  try {
    const extension = path.extname(displayName).toLowerCase();
    if (mediaType === "application/pdf" || extension === ".pdf") markdown = await pdfToMarkdown(bytes);
    else if (mediaType.includes("wordprocessingml") || extension === ".docx") markdown = await docxToMarkdown(bytes);
    else if (mediaType.includes("spreadsheet") || extension === ".xlsx" || extension === ".xls" || extension === ".xlsm") markdown = workbookToMarkdown(bytes, displayName);
    else if (mediaType === "text/csv" || extension === ".csv" || extension === ".tsv") markdown = delimitedToMarkdown(bytes.toString("utf8"), extension === ".tsv" ? "\t" : ",", displayName);
    else if (mediaType === "text/html" || extension === ".html" || extension === ".htm") markdown = htmlToMarkdown(bytes.toString("utf8"));
    else if (mediaType === "application/json" || extension === ".json") markdown = jsonToMarkdown(bytes.toString("utf8"));
    else markdown = normalizeMarkdown(decodeText(bytes));
  } catch (error) {
    if (error instanceof CreatorSourceLibraryError) throw error;
    throw new CreatorSourceLibraryError("projection_failed", `Could not project ${displayName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const content = normalizeMarkdown(markdown);
  if (!content.trim()) throw invalidSource(`${displayName} produced an empty Markdown projection`);
  return { kind: "markdown", mediaType: "text/markdown", contentRef: "", sha256: digestText(content), bytes: Buffer.byteLength(content, "utf8"), __content: content } as SourceProjection & { __content: string };
}

async function readProjectionText(projection: SourceProjection): Promise<string> {
  if (projection.kind !== "markdown") throw new Error("Image projection does not have text content");
  return projectionContentPlaceholder(projection);
}

// The projection content is carried through a private symbol-like field while
// creating the metadata record; this helper is replaced by the caller below.
function projectionContentPlaceholder(projection: SourceProjection): string {
  const value = (projection as SourceProjection & { __content?: string }).__content;
  if (typeof value !== "string") throw new Error("Markdown projection content was not retained");
  return value;
}

async function pdfToMarkdown(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    const pages = String(result.text ?? "").split(/\f/g).map((page) => page.trim()).filter(Boolean);
    return pages.map((page, index) => `## Page ${index + 1}\n\n${page}`).join("\n\n");
  } finally {
    await parser.destroy();
  }
}

async function docxToMarkdown(bytes: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer: bytes });
  return htmlToMarkdown(result.value);
}

function workbookToMarkdown(bytes: Buffer, displayName: string): string {
  const workbook = XLSX.read(bytes, { type: "buffer", cellDates: true });
  return [`# ${path.basename(displayName, path.extname(displayName))}`, "", ...workbook.SheetNames.flatMap((name) => {
    const sheet = workbook.Sheets[name]!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
    return [`## Sheet: ${name}`, "", tableMarkdown(rows), ""];
  })].join("\n");
}

function delimitedToMarkdown(text: string, delimiter: string, displayName: string): string {
  const rows = parseDelimited(text, delimiter);
  return [`# ${path.basename(displayName, path.extname(displayName))}`, "", tableMarkdown(rows)].join("\n");
}

function tableMarkdown(rows: unknown[][]): string {
  const normalized = rows.map((row) => row.map((cell) => String(cell ?? "").replaceAll("|", "\\|")));
  if (!normalized.length) return "| |\n|---|";
  const width = Math.max(1, ...normalized.map((row) => row.length));
  const padded = normalized.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")]);
  const header = padded[0]!;
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...padded.slice(1).map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function htmlToMarkdown(html: string): string {
  let value = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");
  value = value
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, body) => `${"#".repeat(Number(level))} ${stripTags(body)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, body) => `- ${stripTags(body)}\n`)
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, body) => `| ${[...body.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => stripTags(match[1]!)).join(" | ")} |\n`)
    .replace(/<p[^>]*>|<div[^>]*>|<br\s*\/?\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeHtml(value);
}

function jsonToMarkdown(text: string): string {
  const parsed = JSON.parse(text) as unknown;
  return `# JSON source\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
}

function normalizeMarkdown(text: string): string {
  return decodeHtml(text).replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim() + "\n";
}

function decodeText(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === delimiter) { row.push(cell); cell = ""; continue; }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = ""; continue;
    }
    cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, "").trim());
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " }[entity.toLowerCase()] ?? entity));
}

function detectMediaType(displayName: string, supplied: string | undefined, bytes: Buffer): string {
  if (supplied?.trim()) return supplied.split(";", 1)[0]!.trim().toLowerCase();
  const extension = path.extname(displayName).toLowerCase();
  const byExtension: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".json": "application/json",
    ".html": "text/html",
    ".htm": "text/html",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
  };
  if (bytes.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return byExtension[extension] ?? "text/plain";
}

function assertImageMagic(mediaType: string, bytes: Buffer): void {
  const valid = mediaType === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mediaType === "image/jpeg"
      ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw invalidSource(`Image bytes do not match declared ${mediaType}`);
}

function projectionFileName(id: string, projection: SourceProjection): string {
  return `${id}.${projection.kind === "image" ? projection.mediaType.split("/", 2)[1] : "md"}`;
}

function safeDisplayName(value: string): string {
  const name = requireText(value, "displayName").replace(/[\\/\u0000-\u001F]/g, " ").trim();
  if (!name || name.length > 240) throw invalidSource("displayName must be 1-240 characters");
  return name;
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw invalidSource("Invalid Source Library id");
  return value;
}

function safeTaskId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw invalidSource("Invalid taskId");
  return value;
}

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestBytes(value: Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function digestText(value: string): string { return digestBytes(Buffer.from(value, "utf8")); }
function digestJson(value: unknown): string { return digestText(JSON.stringify(value)); }
function sourceArtifactId(sourceId: string, role: string, digest: string): string {
  return `art_${createHash("sha256").update(`${sourceId}\u0000${role}\u0000${digest}`).digest("hex").slice(0, 32)}`;
}
function requireText(value: string, label: string): string { if (typeof value !== "string" || !value.trim()) throw invalidSource(`${label} is required`); return value.trim(); }
function invalidSource(message: string): CreatorSourceLibraryError { return new CreatorSourceLibraryError("invalid_source", message); }
function isMissing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT"; }

async function atomicWrite(destination: string, bytes: Buffer | string): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
}
