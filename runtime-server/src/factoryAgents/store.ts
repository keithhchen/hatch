import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import type { Pool } from "pg";
import type { ChannelKind } from "../channels/types.js";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { atomicWrite } from "./files.js";

export const ROLES = ["research", "voice", "generation", "case-generation", "evaluator"] as const;
export type Role = typeof ROLES[number];
/** Account-level Assistant workspace roles. They never appear in a Product workspace or its Factory Agent definitions. */
export const ASSISTANT_ROLES = ["assistant", "content", "profile-research"] as const;
export type AssistantRole = typeof ASSISTANT_ROLES[number];
export type AnyRole = Role | AssistantRole;
export const isAssistantRole = (role: string): role is AssistantRole => (ASSISTANT_ROLES as readonly string[]).includes(role);
export type Todo = { title: string; status: "pending" | "in_progress" | "completed" };
export type FileRecord = { path: string; bytes: number; mimeType: string; origin?: { sessionId: string; path: string }; readonly?: boolean };
export type Comment = { id: string; path: string; start: number; end: number; quote: string; text: string; replacement?: string; createdAt: string };
export type FactoryProductScope = { creatorId: string; productId: string; briefSpec?: unknown };
export type AgentDefinitionSource = { list(): Promise<Array<{ role: AnyRole; systemPrompt: string; tools: string[]; dependencies: { required: Role[]; normal: Role[]; updates: Role[] } }>> };
/** Where a user message in history came from. The model reads its text; the chat shows only what the Expert said. */
export type MessageOrigin = { kind: "expert" | "system"; itemId: string; text?: string; images?: string[];
  /** Assets the client sent with the message. */
  attachments?: Array<{ type: "image" | "file" | "audio"; name: string; assetId: string }> };

export type IngressItem = {
  id: string; at: string;
  source: "web" | ChannelKind | "task" | "tick" | "consumer";
  text: string;
  /** Workspace paths of images that came with this item. */
  images?: string[];
  taskId?: string; eventId?: string; messageRef?: string;
  /** Turns that took this item but ended before it reached the context. */
  attempts?: number;
};
export type AssistantDeskState = {
  ingress: IngressItem[];
  seenEvents: string[];
  interview?: { taskId: string; productId: string; sessionId: string; relayFrom: number };
  lastExpert?: { source: "web" | ChannelKind; at: string; messageRef?: string; };
};
export type Session = {
  id: string; role: AnyRole; title: string; createdAt: string; updatedAt: string;
  revision: number; turn: number; status: "idle" | "running" | "completed" | "failed" | "interrupted";
  outputUpdatedAt?: string; lastRunAt?: string;
  error?: string; activeTool?: string;
  files: FileRecord[]; comments: Comment[];
  messages: AgentMessage[]; context: AgentMessage[]; scribeContext?: AgentMessage[]; todos: Todo[];
  product?: Pick<FactoryProductScope, "creatorId" | "productId">;
  hatch?: { conversationId: string; lastRunId?: string; pending?: boolean };
  voiceLive?: { resumptionHandle?: string };
  /** Set while the Assistant drives this session for one of its tasks. */
  assistantTaskId?: string;
  /** Assistant session only: durable ingress and the interview it is passing through. */
  assistantDesk?: AssistantDeskState;
  knowledge?: Array<{ path: string; id: string; source: string; title: string; productId: string; sha256: string }>;
  corpus?: { product_id: string; corpus_ref: string; corpus_digest: string; release_digest: string; status: "published"; published_at: string; files: string[] };
};

export function filePath(value: string): string {
  if (!/^(input|output)\//.test(value) || value.includes("\\") || value.split("/").some(s => !s || s === "." || s === ".." || s.startsWith("."))) throw new Error("Invalid workspace file path");
  if (value.length > 500 || /[:\x00-\x1f]/.test(value)) throw new Error("Invalid file name");
  return value;
}

/** Same workspace path regardless of Unicode composition (macOS uploads NFD names). */
export const samePath = (a: string, b: string) => a.normalize("NFC") === b.normalize("NFC");

/**
 * Port: where a workspace keeps its sessions and files. Product workspaces use
 * the file adapter Studio has always used; the Assistant workspace uses Postgres.
 */
export interface WorkbenchBackend {
  listIds(): Promise<string[]>;
  load(id: string): Promise<{ session: Omit<Session, "todos">; todos: Todo[] }>;
  insert(session: Session): Promise<void>;
  /** Read-modify-write one session atomically. */
  transact<T>(id: string, change: (session: Session) => T | Promise<T>): Promise<T>;
  readFile(id: string, name: string): Promise<Buffer>;
  writeFile(id: string, name: string, bytes: Buffer): Promise<void>;
  removeFile(id: string, name: string): Promise<void>;
  listManual(): Promise<FileRecord[]>;
  readManual(name: string): Promise<Buffer>;
  writeManual(name: string, bytes: Buffer): Promise<void>;
  removeManual(name: string): Promise<void>;
}

const sessionId = (id: string) => { if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid session ID"); return id; };
const withTodos = (loaded: { session: Omit<Session, "todos">; todos: Todo[] }): Session => {
  const session = loaded.session as Session & { progress?: unknown };
  session.todos = Array.isArray(loaded.todos) ? loaded.todos : [];
  delete session.progress;
  return session;
};
const manualMimeType = (name: string) => name.endsWith(".md") ? "text/markdown" : name.endsWith(".txt") ? "text/plain" : name.endsWith(".json") ? "application/json" : "application/octet-stream";

/** Sessions as directories on disk: session.json, todo.json and the workspace files. */
export class FileWorkbenchBackend implements WorkbenchBackend {
  constructor(readonly root: string) {}
  private directory(id: string): string { return path.join(this.root, sessionId(id)); }
  async listIds(): Promise<string[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return (await readdir(this.root)).filter(s => /^[0-9a-f-]{36}$/.test(s));
  }
  async load(id: string) {
    const session = JSON.parse(await readFile(path.join(this.directory(id), "session.json"), "utf8"));
    const todo = await readFile(path.join(this.directory(id), "todo.json"), "utf8").then(JSON.parse).catch(() => ({ todos: [] }));
    return { session, todos: todo.todos };
  }
  async insert(session: Session): Promise<void> { await mkdir(this.directory(session.id), { recursive: true, mode: 0o700 }); await this.save(session); }
  private async save(session: Session): Promise<void> { const { todos, ...metadata } = session; await Promise.all([atomicWrite(path.join(this.directory(session.id), "session.json"), JSON.stringify(metadata)), atomicWrite(path.join(this.directory(session.id), "todo.json"), JSON.stringify({ todos }))]); }
  async transact<T>(id: string, change: (session: Session) => T | Promise<T>): Promise<T> {
    const session = withTodos(await this.load(id));
    const result = await change(session);
    session.updatedAt = new Date().toISOString();
    await this.save(session);
    return result;
  }
  async readFile(id: string, name: string): Promise<Buffer> { return readFile(await this.materializedPath(id, name)); }
  async writeFile(id: string, name: string, bytes: Buffer): Promise<void> { await atomicWrite(await this.materializedPath(id, name), bytes); }
  async removeFile(id: string, name: string): Promise<void> { await rm(await this.materializedPath(id, name), { force: true }); }
  private async materializedPath(id: string, name: string): Promise<string> {
    let current = this.directory(id);
    for (const part of filePath(name).split("/")) {
      current = path.join(current, part);
      const info = await lstat(current).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
      if (info?.isSymbolicLink()) throw new Error("Workspace symlinks are not allowed");
    }
    await mkdir(path.dirname(current), { recursive: true });
    return current;
  }
  async listManual(): Promise<FileRecord[]> {
    const root = path.join(this.root, "manual");
    const walk = async (directory: string, prefix: string): Promise<FileRecord[]> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      const files: FileRecord[] = [];
      for (const entry of entries) {
        const diskPath = path.join(directory, entry.name);
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory()) files.push(...await walk(diskPath, `${relative}/`));
        else if (entry.isFile()) {
          const info = await lstat(diskPath);
          files.push({ path: `input/manual/${relative}`, bytes: info.size, mimeType: manualMimeType(entry.name) });
        }
      }
      return files;
    };
    return (await walk(root, "")).sort((a, b) => a.path.localeCompare(b.path));
  }
  private async manualPath(name: string): Promise<string> {
    if (!name.startsWith("input/manual/")) throw new Error("Manual files must use input/manual/");
    let current = path.join(this.root, "manual");
    for (const part of name.slice("input/manual/".length).split("/")) { current = path.join(current, part); const info = await lstat(current).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; }); if (info?.isSymbolicLink()) throw new Error("Workspace symlinks are not allowed"); }
    await mkdir(path.dirname(current), { recursive: true }); return current;
  }
  async readManual(name: string): Promise<Buffer> { return readFile(await this.manualPath(name)); }
  async writeManual(name: string, bytes: Buffer): Promise<void> { await atomicWrite(await this.manualPath(name), bytes); }
  async removeManual(name: string): Promise<void> { await rm(await this.manualPath(name), { force: true }); }
}

/** Sessions and their files in Postgres, one row per session, keyed by workspace. */
export class PostgresWorkbenchBackend implements WorkbenchBackend {
  constructor(private pool: Pool, readonly workspace: string) {}
  static async ensureSchema(pool: Pool): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_workbench_sessions (
        workspace TEXT NOT NULL,
        id UUID NOT NULL,
        data JSONB NOT NULL,
        todos JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace, id)
      );
      CREATE TABLE IF NOT EXISTS hatch_workbench_files (
        workspace TEXT NOT NULL,
        session_id UUID NOT NULL,
        path TEXT NOT NULL,
        bytes BYTEA NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace, session_id, path)
      );
    `);
  }
  async listIds(): Promise<string[]> { return (await this.pool.query("SELECT id FROM hatch_workbench_sessions WHERE workspace = $1", [this.workspace])).rows.map(row => row.id); }
  async load(id: string) {
    const row = (await this.pool.query("SELECT data, todos FROM hatch_workbench_sessions WHERE workspace = $1 AND id = $2", [this.workspace, sessionId(id)])).rows[0];
    if (!row) throw Object.assign(new Error("Session not found"), { code: "ENOENT" });
    return { session: row.data, todos: row.todos };
  }
  async insert(session: Session): Promise<void> {
    const { todos, ...data } = session;
    await this.pool.query("INSERT INTO hatch_workbench_sessions (workspace, id, data, todos) VALUES ($1, $2, $3::jsonb, $4::jsonb)", [this.workspace, sessionId(session.id), JSON.stringify(data), JSON.stringify(todos)]);
  }
  async transact<T>(id: string, change: (session: Session) => T | Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT data, todos FROM hatch_workbench_sessions WHERE workspace = $1 AND id = $2 FOR UPDATE", [this.workspace, sessionId(id)])).rows[0];
      if (!row) throw Object.assign(new Error("Session not found"), { code: "ENOENT" });
      const session = withTodos({ session: row.data, todos: row.todos });
      const result = await change(session);
      session.updatedAt = new Date().toISOString();
      const { todos, ...data } = session;
      await client.query("UPDATE hatch_workbench_sessions SET data = $3::jsonb, todos = $4::jsonb, updated_at = NOW() WHERE workspace = $1 AND id = $2", [this.workspace, id, JSON.stringify(data), JSON.stringify(todos)]);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
  async readFile(id: string, name: string): Promise<Buffer> {
    const row = (await this.pool.query("SELECT bytes FROM hatch_workbench_files WHERE workspace = $1 AND session_id = $2 AND path = $3", [this.workspace, sessionId(id), filePath(name)])).rows[0];
    if (!row) throw Object.assign(new Error("File not found"), { code: "ENOENT" });
    return row.bytes;
  }
  async writeFile(id: string, name: string, bytes: Buffer): Promise<void> {
    await this.pool.query(`INSERT INTO hatch_workbench_files (workspace, session_id, path, bytes) VALUES ($1, $2, $3, $4)
      ON CONFLICT (workspace, session_id, path) DO UPDATE SET bytes = EXCLUDED.bytes, updated_at = NOW()`, [this.workspace, sessionId(id), filePath(name), bytes]);
  }
  async removeFile(id: string, name: string): Promise<void> { await this.pool.query("DELETE FROM hatch_workbench_files WHERE workspace = $1 AND session_id = $2 AND path = $3", [this.workspace, sessionId(id), filePath(name)]); }
  async listManual(): Promise<FileRecord[]> { return []; }
  async readManual(): Promise<Buffer> { throw new Error("This workspace has no shared input/manual files"); }
  async writeManual(): Promise<void> { throw new Error("This workspace has no shared input/manual files"); }
  async removeManual(): Promise<void> { throw new Error("This workspace has no shared input/manual files"); }
}

/** Each chat owns ordinary files; completed Runtime results retain their own paths. */
export class WorkbenchStore {
  private queues = new Map<string, Promise<unknown>>();
  readonly backend: WorkbenchBackend;
  constructor(root: string | WorkbenchBackend, readonly scope?: FactoryProductScope, private definitions?: AgentDefinitionSource) {
    this.backend = typeof root === "string" ? new FileWorkbenchBackend(root) : root;
  }
  get root(): string | undefined { return this.backend instanceof FileWorkbenchBackend ? this.backend.root : undefined; }
  async definition(role: AnyRole): Promise<Awaited<ReturnType<NonNullable<AgentDefinitionSource>["list"]>>[number]> {
    const definition = (await this.definitions?.list())?.find(candidate => candidate.role === role);
    if (!definition) throw Object.assign(new Error(`Factory Agent definition is missing: ${role}`), { code: "agent_definitions_invalid", status: 503 });
    return definition;
  }
  async dependencies(role: AnyRole): Promise<{ required: Role[]; normal: Role[]; updates: Role[] }> {
    return (await this.definition(role)).dependencies;
  }
  async listManualFiles(): Promise<FileRecord[]> { return this.backend.listManual(); }
  async create(role: AnyRole, title?: string): Promise<Session> {
    if (!(ROLES as readonly string[]).includes(role) && !isAssistantRole(role)) throw new Error("Unknown agent role");
    const id = randomUUID();
    const now = new Date().toISOString();
    const session: Session = { id, role, title: title?.trim() || role, createdAt: now, updatedAt: now, revision: 0, turn: 0, status: "idle", files: [], comments: [], messages: [], context: [], todos: [], ...(this.scope ? { product: { creatorId: this.scope.creatorId, productId: this.scope.productId } } : {}) };
    await this.backend.insert(session);
    if (role === "voice") {
      await this.put(id, "output/CREATOR_PERSONA.md", Buffer.from("# CREATOR_PERSONA\n\n"), { actor: "host", countsAsOutput: false });
      await this.put(id, "output/VOICE.md", Buffer.from("# VOICE\n\n"), { actor: "host", countsAsOutput: false });
      return this.get(id);
    }
    return session;
  }
  private checkScope(session: Session): Session {
    if (this.scope && (!session.product || session.product.creatorId !== this.scope.creatorId || session.product.productId !== this.scope.productId)) throw new Error("Session belongs to a different Product workspace");
    return session;
  }
  async get(id: string): Promise<Session> { return this.checkScope(withTodos(await this.backend.load(id))); }
  async list(): Promise<Session[]> {
    const names = await this.backend.listIds();
    return (await Promise.all(names.map(s => this.get(s)))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private async upstream(id: string): Promise<Array<{ role: Role; session: Session }>> { if (!this.definitions) return []; const current = await this.get(id); const dependencies = await this.dependencies(current.role); const allowed = [...dependencies.required, ...dependencies.normal, ...dependencies.updates]; if (!allowed.length) return []; const sessions = await this.list(); return allowed.flatMap(role => { const session = sessions.filter(candidate => candidate.role === role && candidate.id !== id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]; return session ? [{ role, session }] : []; }); }
  async contextFiles(id: string): Promise<FileRecord[]> { const current = await this.get(id); const manual = await this.backend.listManual(); const inherited = (await this.upstream(id)).flatMap(({ role, session }) => session.files.filter(file => file.path.startsWith("output/")).map(file => ({ ...file, path: `input/${role}/${file.path.slice(7)}`, origin: { sessionId: session.id, path: file.path }, readonly: true }))); return [...current.files.filter(file => !file.path.startsWith("input/manual/") && !file.path.startsWith("input/handoff/")), ...manual, ...inherited]; }
  async update<T>(id: string, change: (session: Session) => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.backend.transact(id, session => change(this.checkScope(session))));
    this.queues.set(id, operation);
    try { return await operation; } finally { if (this.queues.get(id) === operation) this.queues.delete(id); }
  }
  async read(id: string, name: string): Promise<{ record: FileRecord; bytes: Buffer }> {
    filePath(name);
    const record = (await this.contextFiles(id)).find(f => samePath(f.path, name));
    if (!record) throw new Error("File not found");
    if (record.path.startsWith("input/manual/")) return { record, bytes: await this.backend.readManual(record.path) };
    if (record.origin && record.path.startsWith("input/") && record.readonly) return { record, bytes: await this.backend.readFile(record.origin.sessionId, record.origin.path) };
    return { record, bytes: await this.backend.readFile(id, record.path) };
  }
  async put(id: string, name: string, bytes: Buffer, options: { mimeType?: string; actor: "user" | "agent" | "host"; origin?: FileRecord["origin"]; readonly?: boolean; countsAsOutput?: boolean }): Promise<FileRecord> {
    filePath(name);
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("File must contain 1 byte to 20 MiB");
    if (options.actor === "user" && name.startsWith("input/manual/")) { await this.backend.writeManual(name, bytes); return (await this.backend.listManual()).find(file => file.path === name)!; }
    if (options.actor === "agent" && (!name.startsWith("output/") || !name.endsWith(".md"))) throw new Error("Agent may only write output Markdown");
    return this.update(id, async s => {
      const old = s.files.find(f => f.path === name);
      if (options.actor !== "host" && (old?.readonly || (s.role === "generation" && name === "output/CORPUS.md") || (s.role === "evaluator" && /^(output\/RESULT\.md|output\/results\/)/.test(name)))) throw new Error("Runtime result is immutable; save a proposed revision under another name");
      if (options.actor === "user" && s.status === "running") throw new Error("请停止运行后再保存文件；当前编辑草稿可以保留。");
      const record: FileRecord = { path: name, bytes: bytes.length, mimeType: options.mimeType ?? (name.endsWith(".md") ? "text/markdown" : "application/octet-stream"), ...(options.origin ? { origin: options.origin } : {}), ...(options.readonly ? { readonly: true } : {}) };
      await this.backend.writeFile(id, name, bytes);
      s.files = [...s.files.filter(f => f.path !== name), record];
      if (name.startsWith("output/") && options.countsAsOutput !== false) s.outputUpdatedAt = new Date().toISOString();
      s.revision++;
      return record;
    });
  }
  async removeInput(id: string, name: string): Promise<void> {
    filePath(name);
    if (name.startsWith("input/manual/")) { if ((await this.get(id)).status === "running") throw new Error("Only idle input files can be removed"); await this.backend.removeManual(name); return; }
    await this.update(id, async s => { if (!name.startsWith("input/") || s.status === "running") throw new Error("Only idle input files can be removed"); await this.backend.removeFile(id, name); s.files = s.files.filter(f => f.path !== name); s.revision++; });
  }
  async comment(id: string, input: Omit<Comment, "id" | "createdAt">): Promise<Comment> {
    const { bytes, record } = await this.read(id, input.path);
    const text = bytes.toString("utf8");
    if (!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.start < 0 || input.end < input.start || input.end > text.length || text.slice(input.start, input.end) !== input.quote || !input.text.trim()) throw new Error("Comment must reference the selected text");
    const session = await this.get(id);
    // RESULT.md is a convenience link to an immutable response or downloaded asset.
    // Older stored results predate origin metadata; resolve those via their saved run.
    const runPath = input.path === "output/RESULT.md"
      ? (record.origin?.sessionId === id ? record.origin.path : session.hatch?.lastRunId ? `output/results/${session.hatch.lastRunId}.md` : input.path)
      : input.path;
    if (runPath !== input.path && !(await this.read(id, runPath)).bytes.equals(bytes)) throw new Error("Result changed; open the original result file before commenting");
    const comment = { ...input, path: runPath, id: randomUUID(), createdAt: new Date().toISOString() };
    await this.update(id, s => { s.comments.push(comment); });
    return comment;
  }
  async recover(): Promise<void> {
    for (const s of await this.list()) await this.update(s.id, current => {
      // One-time metadata cutover. Current input/output files already exist on disk.
      current.files = current.files.map(f => ({ path: f.path, bytes: f.bytes, mimeType: f.mimeType, ...(f.readonly ? { readonly: true } : {}), ...(f.origin ? { origin: { sessionId: f.origin.sessionId, path: f.origin.path } } : {}) }));
      current.comments = current.comments.map(({ id, path, start, end, quote, text, replacement, createdAt }) => ({ id, path, start, end, quote, text, replacement, createdAt }));
      if (current.status === "running") { current.status = "interrupted"; current.error = "服务已重启；请检查已有结果后继续，未自动重放操作。"; }
    });
  }
}
