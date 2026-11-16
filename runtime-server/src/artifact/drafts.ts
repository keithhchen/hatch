import type { PostgresQueryExecutor } from "../postgresStore.js";

/**
 * The report's working files, the way a coding agent works: written and edited in small steps under /report/, read back
 * to proofread, then published as one file. Kept per conversation, so a retry continues the draft the last attempt left.
 */
export interface DraftStore {
  read(conversationId: string, path: string): Promise<string | undefined>;
  write(conversationId: string, path: string, content: string): Promise<void>;
  list(conversationId: string): Promise<Array<{ path: string; bytes: number }>>;
}

export const DRAFT_ROOT = "/report/";
export const REPORT_FILE = "/report/report.html";
export const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

export class DraftError extends Error {}

/** A draft path: under /report/, no `..`, a plain file name. Anything else is the model's mistake, told back to it. */
export function draftPath(raw: unknown): string {
  const path = typeof raw === "string" ? raw.trim() : "";
  if (!path.startsWith(DRAFT_ROOT) || path.includes("..") || path.endsWith("/") || path.length > 200) {
    throw new DraftError(`Paths are files under ${DRAFT_ROOT}, for example ${REPORT_FILE} (got ${JSON.stringify(raw)}).`);
  }
  return path;
}

const POSTGRES_ARTIFACT_DRAFT_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_artifact_drafts (
  conversation_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, path)
);`;

export class PostgresDraftStore implements DraftStore {
  constructor(private readonly db: PostgresQueryExecutor) {}
  async initialize() { await this.db.query(POSTGRES_ARTIFACT_DRAFT_SCHEMA); }
  async read(conversationId: string, path: string) {
    return (await this.db.query<{ content: string }>("SELECT content FROM hatch_artifact_drafts WHERE conversation_id = $1 AND path = $2", [conversationId, path])).rows[0]?.content;
  }
  /** One statement: a write replaces the whole file or nothing. */
  async write(conversationId: string, path: string, content: string) {
    await this.db.query(`INSERT INTO hatch_artifact_drafts (conversation_id, path, content) VALUES ($1, $2, $3)
      ON CONFLICT (conversation_id, path) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`, [conversationId, path, content]);
  }
  async list(conversationId: string) {
    return (await this.db.query<{ path: string; bytes: number }>("SELECT path, octet_length(content) AS bytes FROM hatch_artifact_drafts WHERE conversation_id = $1 ORDER BY path", [conversationId])).rows.map((r) => ({ path: r.path, bytes: Number(r.bytes) }));
  }
}

export class InMemoryDraftStore implements DraftStore {
  private readonly files = new Map<string, string>();
  async read(conversationId: string, path: string) { return this.files.get(`${conversationId}\u0000${path}`); }
  async write(conversationId: string, path: string, content: string) { this.files.set(`${conversationId}\u0000${path}`, content); }
  async list(conversationId: string) {
    return [...this.files].filter(([key]) => key.startsWith(`${conversationId}\u0000`)).map(([key, content]) => ({ path: key.split("\u0000")[1]!, bytes: Buffer.byteLength(content) })).sort((a, b) => a.path.localeCompare(b.path));
  }
}

const size = (content: string) => {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_DRAFT_BYTES) throw new DraftError(`A draft file holds at most ${MAX_DRAFT_BYTES / 1024 / 1024} MB.`);
  return bytes;
};

/** write / edit / read over one conversation's drafts, with the exact, short answers a coding agent expects. */
export const draftFiles = (store: DraftStore, conversationId: string) => ({
  async write(args: Record<string, unknown>): Promise<string> {
    const path = draftPath(args.path);
    if (typeof args.content !== "string") throw new DraftError("content is the whole file as a string.");
    const bytes = size(args.content);
    await store.write(conversationId, path, args.content);
    return `Wrote ${path} (${bytes} bytes).`;
  },
  async edit(args: Record<string, unknown>): Promise<string> {
    const path = draftPath(args.path);
    const current = await store.read(conversationId, path);
    if (current === undefined) throw new DraftError(`${path} does not exist yet; create it with write_file.`);
    const { old_string: oldString, new_string: newString } = args;
    if (typeof oldString !== "string" || !oldString || typeof newString !== "string") throw new DraftError("old_string (non-empty) and new_string are strings.");
    const count = current.split(oldString).length - 1;
    if (!count) throw new DraftError(`old_string was not found in ${path}. Read the file and copy the text exactly.`);
    if (count > 1 && args.replace_all !== true) throw new DraftError(`old_string appears ${count} times in ${path}; add surrounding text to make it unique, or set replace_all.`);
    const next = args.replace_all === true ? current.split(oldString).join(newString) : current.replace(oldString, () => newString);
    const bytes = size(next);
    await store.write(conversationId, path, next);
    return `Edited ${path} (${count > 1 ? `${count} places, ` : ""}${bytes} bytes).`;
  },
  async read(args: Record<string, unknown>): Promise<string> {
    if (args.path === undefined || args.path === DRAFT_ROOT) {
      const files = await store.list(conversationId);
      return files.length ? files.map((f) => `${f.path}  ${f.bytes} bytes`).join("\n") : `No files under ${DRAFT_ROOT} yet.`;
    }
    const path = draftPath(args.path);
    const content = await store.read(conversationId, path);
    if (content === undefined) throw new DraftError(`${path} does not exist.`);
    return content;
  }
});
