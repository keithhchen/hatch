import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { atomicWrite } from "./files.js";

export const ROLES = ["research", "voice", "generation", "case-generation", "evaluator"] as const;
export type Role = typeof ROLES[number];
export type Todo = { title: string; status: "pending" | "in_progress" | "completed" };
export type FileRecord = { path: string; bytes: number; mimeType: string; origin?: { sessionId: string; path: string }; readonly?: boolean };
export type Comment = { id: string; path: string; start: number; end: number; quote: string; text: string; replacement?: string; createdAt: string };
export type FactoryProductScope = { creatorId: string; productId: string; briefSpec?: unknown };
export type Session = {
  id: string; role: Role; title: string; createdAt: string; updatedAt: string;
  revision: number; turn: number; status: "idle" | "running" | "completed" | "failed" | "interrupted";
  error?: string; activeTool?: string;
  files: FileRecord[]; comments: Comment[];
  messages: AgentMessage[]; context: AgentMessage[]; scribeContext?: AgentMessage[]; todos: Todo[];
  product?: Pick<FactoryProductScope, "creatorId" | "productId">;
  hatch?: { conversationId: string; lastRunId?: string; pending?: boolean };
  knowledge?: Array<{ path: string; id: string; source: string; title: string; productId: string; sha256: string }>;
  corpus?: { product_id: string; corpus_ref: string; corpus_digest: string; release_digest: string; status: "published"; published_at: string; files: string[] };
};

export function filePath(value: string): string {
  if (!/^(input|output)\//.test(value) || value.includes("\\") || value.split("/").some(s => !s || s === "." || s === ".." || s.startsWith("."))) throw new Error("Invalid workspace file path");
  if (value.length > 500 || /[:\x00-\x1f]/.test(value)) throw new Error("Invalid file name");
  return value;
}

/** Each chat owns ordinary files; completed Runtime results retain their own paths. */
export class WorkbenchStore {
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly root: string, readonly scope?: FactoryProductScope) {}
  private directory(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid session ID");
    return path.join(this.root, id);
  }
  private async manualFiles(): Promise<FileRecord[]> { return readFile(path.join(this.root, "manual-files.json"), "utf8").then(value => JSON.parse(value).files ?? []).catch(() => []); }
  private async manualPath(name: string): Promise<string> {
    if (!name.startsWith("input/manual/")) throw new Error("Manual files must use input/manual/");
    let current = path.join(this.root, "manual");
    for (const part of name.slice("input/manual/".length).split("/")) { current = path.join(current, part); const info = await lstat(current).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; }); if (info?.isSymbolicLink()) throw new Error("Workspace symlinks are not allowed"); }
    await mkdir(path.dirname(current), { recursive: true }); return current;
  }
  async create(role: Role, title?: string): Promise<Session> {
    if (!ROLES.includes(role)) throw new Error("Unknown agent role");
    const id = randomUUID();
    await mkdir(this.directory(id), { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const session: Session = { id, role, title: title?.trim() || role, createdAt: now, updatedAt: now, revision: 0, turn: 0, status: "idle", files: [], comments: [], messages: [], context: [], todos: [], ...(this.scope ? { product: { creatorId: this.scope.creatorId, productId: this.scope.productId } } : {}) };
    await this.save(session);
    if (role === "voice") {
      await this.put(id, "output/CREATOR_PERSONA.md", Buffer.from("# CREATOR_PERSONA\n\n"), { actor: "host" });
      return this.get(id);
    }
    return session;
  }
  async get(id: string): Promise<Session> { const session = JSON.parse(await readFile(path.join(this.directory(id), "session.json"), "utf8")) as Session & { progress?: unknown }; const todo = await readFile(path.join(this.directory(id), "todo.json"), "utf8").then(JSON.parse).catch(() => ({ todos: [] })); session.todos = Array.isArray(todo.todos) ? todo.todos : []; delete session.progress; if (this.scope && session.product && (session.product.creatorId !== this.scope.creatorId || session.product.productId !== this.scope.productId)) throw new Error("Session belongs to a different Product workspace"); return session; }
  async list(): Promise<Session[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.root)).filter(s => /^[0-9a-f-]{36}$/.test(s));
    return (await Promise.all(names.map(s => this.get(s)))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private async save(session: Session): Promise<void> { const { todos, ...metadata } = session; await Promise.all([atomicWrite(path.join(this.directory(session.id), "session.json"), JSON.stringify(metadata)), atomicWrite(path.join(this.directory(session.id), "todo.json"), JSON.stringify({ todos }))]); }
  private async upstream(id: string): Promise<Array<{ role: Role; session: Session }>> { const current = await this.get(id); const allowed: Partial<Record<Role, Role[]>> = { voice: ["research"], generation: ["research", "voice", "evaluator"], "case-generation": ["research", "voice", "generation"], evaluator: ["generation", "case-generation"] }; const sessions = await this.list(); return (allowed[current.role] ?? []).flatMap(role => { const session = sessions.filter(candidate => candidate.role === role && candidate.id !== id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]; return session ? [{ role, session }] : []; }); }
  async contextFiles(id: string): Promise<FileRecord[]> { const current = await this.get(id); const manual = await this.manualFiles(); const inherited = (await this.upstream(id)).flatMap(({ role, session }) => session.files.filter(file => file.path.startsWith("output/")).map(file => ({ ...file, path: `input/${role}/${file.path.slice(7)}`, origin: { sessionId: session.id, path: file.path }, readonly: true }))); return [...current.files.filter(file => !file.path.startsWith("input/manual/")), ...manual, ...inherited]; }
  async update<T>(id: string, change: (session: Session) => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const session = await this.get(id);
      const result = await change(session);
      session.updatedAt = new Date().toISOString();
      await this.save(session);
      return result;
    });
    this.queues.set(id, operation);
    try { return await operation; } finally { if (this.queues.get(id) === operation) this.queues.delete(id); }
  }
  async read(id: string, name: string): Promise<{ record: FileRecord; bytes: Buffer }> {
    filePath(name);
    const record = (await this.contextFiles(id)).find(f => f.path === name);
    if (!record) throw new Error("File not found");
    if (record.path.startsWith("input/manual/")) return { record, bytes: await readFile(await this.manualPath(record.path)) };
    if (record.origin && record.path.startsWith("input/") && record.readonly) return { record, bytes: await readFile(await this.materializedPath(record.origin.sessionId, record.origin.path)) };
    return { record, bytes: await readFile(await this.materializedPath(id, name)) };
  }
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
  async put(id: string, name: string, bytes: Buffer, options: { mimeType?: string; actor: "user" | "agent" | "host"; origin?: FileRecord["origin"]; readonly?: boolean }): Promise<FileRecord> {
    filePath(name);
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("File must contain 1 byte to 20 MiB");
    if (options.actor === "user" && name.startsWith("input/manual/")) { const record: FileRecord = { path: name, bytes: bytes.length, mimeType: options.mimeType ?? (name.endsWith(".md") ? "text/markdown" : "application/octet-stream") }; await atomicWrite(await this.manualPath(name), bytes); await atomicWrite(path.join(this.root, "manual-files.json"), JSON.stringify({ files: [...(await this.manualFiles()).filter(file => file.path !== name), record] })); return record; }
    if (options.actor === "agent" && (!name.startsWith("output/") || !name.endsWith(".md"))) throw new Error("Agent may only write output Markdown");
    return this.update(id, async s => {
      const old = s.files.find(f => f.path === name);
      if (options.actor !== "host" && (old?.readonly || (s.role === "generation" && name === "output/CORPUS.md") || (s.role === "evaluator" && /^(output\/RESULT\.md|output\/results\/)/.test(name)))) throw new Error("Runtime result is immutable; save a proposed revision under another name");
      if (options.actor === "user" && s.status === "running") throw new Error("请停止运行后再保存文件；当前编辑草稿可以保留。");
      const record: FileRecord = { path: name, bytes: bytes.length, mimeType: options.mimeType ?? (name.endsWith(".md") ? "text/markdown" : "application/octet-stream"), ...(options.origin ? { origin: options.origin } : {}), ...(options.readonly ? { readonly: true } : {}) };
      await atomicWrite(await this.materializedPath(id, name), bytes);
      s.files = [...s.files.filter(f => f.path !== name), record];
      s.revision++;
      return record;
    });
  }
  async removeInput(id: string, name: string): Promise<void> {
    filePath(name);
    if (name.startsWith("input/manual/")) { if ((await this.get(id)).status === "running") throw new Error("Only idle input files can be removed"); await rm(await this.manualPath(name), { force: true }); await atomicWrite(path.join(this.root, "manual-files.json"), JSON.stringify({ files: (await this.manualFiles()).filter(file => file.path !== name) })); return; }
    await this.update(id, async s => { if (!name.startsWith("input/") || s.status === "running") throw new Error("Only idle input files can be removed"); await rm(await this.materializedPath(id, name), { force: true }); s.files = s.files.filter(f => f.path !== name); s.revision++; });
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
      if (this.scope) current.product = { creatorId: this.scope.creatorId, productId: this.scope.productId };
      // One-time metadata cutover. Current input/output files already exist on disk.
      current.files = current.files.map(f => ({ path: f.path, bytes: f.bytes, mimeType: f.mimeType, ...(f.readonly ? { readonly: true } : {}), ...(f.origin ? { origin: { sessionId: f.origin.sessionId, path: f.origin.path } } : {}) }));
      current.comments = current.comments.map(({ id, path, start, end, quote, text, replacement, createdAt }) => ({ id, path, start, end, quote, text, replacement, createdAt }));
      if (current.status === "running") { current.status = "interrupted"; current.error = "服务已重启；请检查已有结果后继续，未自动重放操作。"; }
    });
  }
}
