import type { Pool } from "pg";
import { FormClosed, FormConflict, type FormSchema } from "./schema.js";

/** Which conversation published the page, so its submission can continue that conversation. */
export type FormOrigin = { sessionId: string; productId: string; taskId?: string };

export type FormPage = {
  id: string;
  accountId: string;
  title: string;
  /** One per published HTML: the object key of the page is built from it, so a published page is never overwritten. */
  version: number;
  htmlKey: string;
  schema: FormSchema;
  origin: FormOrigin;
  status: "open" | "submitted";
  submittedAt?: string;
  /** Set once the conversation has been told of the submission. */
  notifiedAt?: string;
  createdAt: string;
  updatedAt: string;
};

/** One answer. A cleared answer keeps its row with a null value, so its version keeps counting. */
export type FormAnswer = { formId: string; questionId: string; value: unknown; version: number; updatedAt: string };

export type FormRevision = Pick<FormPage, "title" | "htmlKey" | "schema" | "origin">;

export interface FormRepository {
  create(page: Pick<FormPage, "id" | "accountId" | "title" | "htmlKey" | "schema" | "origin">): Promise<FormPage>;
  get(id: string): Promise<FormPage | undefined>;
  /** Replaces the published HTML and schema of an open page, only if it is still at `version`. The answers stay. */
  revise(id: string, version: number, revision: FormRevision): Promise<FormPage | undefined>;
  answers(id: string): Promise<FormAnswer[]>;
  /**
   * Stores one answer (null clears it) if the caller saw its current version (`base`, 0 for none): FormConflict otherwise.
   * A submitted page takes no more answers: FormClosed. The check and the write are one step.
   */
  save(id: string, questionId: string, value: unknown, base: number): Promise<FormAnswer>;
  /** Closes the page. `first` is true for the call that closed it. */
  submit(id: string): Promise<{ page: FormPage; first: boolean }>;
  notified(id: string): Promise<void>;
}

const now = () => new Date().toISOString();

export class MemoryFormRepository implements FormRepository {
  private pages = new Map<string, FormPage>();
  private stored = new Map<string, FormAnswer>();

  async create(input: Parameters<FormRepository["create"]>[0]): Promise<FormPage> {
    const page: FormPage = { ...input, version: 1, status: "open", createdAt: now(), updatedAt: now() };
    this.pages.set(page.id, page);
    return structuredClone(page);
  }
  async get(id: string) { const page = this.pages.get(id); return page && structuredClone(page); }
  async revise(id: string, version: number, revision: FormRevision) {
    const page = this.pages.get(id);
    if (!page || page.version !== version) return undefined;
    if (page.status === "submitted") throw new FormClosed();
    Object.assign(page, structuredClone(revision), { version: version + 1, updatedAt: now() });
    return structuredClone(page);
  }
  async answers(id: string) { return [...this.stored.values()].filter(answer => answer.formId === id).map(answer => structuredClone(answer)); }
  async save(id: string, questionId: string, value: unknown, base: number) {
    if (this.pages.get(id)?.status !== "open") throw new FormClosed();
    const current = this.stored.get(`${id}/${questionId}`);
    if ((current?.version ?? 0) !== base) throw new FormConflict({ value: current?.value ?? null, version: current?.version ?? 0 });
    const answer: FormAnswer = { formId: id, questionId, value, version: base + 1, updatedAt: now() };
    this.stored.set(`${id}/${questionId}`, answer);
    return structuredClone(answer);
  }
  async submit(id: string) {
    const page = this.pages.get(id)!;
    const first = page.status === "open";
    if (first) Object.assign(page, { status: "submitted", submittedAt: now(), updatedAt: now() });
    return { page: structuredClone(page), first };
  }
  async notified(id: string) { this.pages.get(id)!.notifiedAt ??= now(); }
}

type PageRow = { id: string; account_id: string; title: string; version: number; html_key: string; schema: FormSchema; origin: FormOrigin; status: "open" | "submitted"; submitted_at: Date | null; notified_at: Date | null; created_at: Date; updated_at: Date };
const pageOf = (row: PageRow): FormPage => ({
  id: row.id, accountId: row.account_id, title: row.title, version: row.version, htmlKey: row.html_key, schema: row.schema, origin: row.origin, status: row.status,
  ...(row.submitted_at ? { submittedAt: row.submitted_at.toISOString() } : {}), ...(row.notified_at ? { notifiedAt: row.notified_at.toISOString() } : {}),
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
});
const answerOf = (row: { form_id: string; question_id: string; value: unknown; version: number; updated_at: Date }): FormAnswer => ({ formId: row.form_id, questionId: row.question_id, value: row.value, version: row.version, updatedAt: row.updated_at.toISOString() });

export class PostgresFormRepository implements FormRepository {
  private constructor(private pool: Pool) {}
  static async open(pool: Pool): Promise<PostgresFormRepository> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_form_pages (
        id TEXT PRIMARY KEY,
        account_id UUID NOT NULL,
        title TEXT NOT NULL,
        version INTEGER NOT NULL,
        html_key TEXT NOT NULL,
        schema JSONB NOT NULL,
        origin JSONB NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'submitted')),
        submitted_at TIMESTAMPTZ,
        notified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hatch_form_pages_account_idx ON hatch_form_pages (account_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS hatch_form_answers (
        form_id TEXT NOT NULL REFERENCES hatch_form_pages (id),
        question_id TEXT NOT NULL,
        value JSONB,
        version INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (form_id, question_id)
      );
    `);
    return new PostgresFormRepository(pool);
  }
  async create(input: Parameters<FormRepository["create"]>[0]): Promise<FormPage> {
    const row = (await this.pool.query<PageRow>(
      `INSERT INTO hatch_form_pages (id, account_id, title, version, html_key, schema, origin, status, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6::jsonb, 'open', NOW(), NOW()) RETURNING *`,
      [input.id, input.accountId, input.title, input.htmlKey, JSON.stringify(input.schema), JSON.stringify(input.origin)])).rows[0]!;
    return pageOf(row);
  }
  async get(id: string) {
    const row = (await this.pool.query<PageRow>("SELECT * FROM hatch_form_pages WHERE id = $1", [id])).rows[0];
    return row && pageOf(row);
  }
  async revise(id: string, version: number, revision: FormRevision) {
    const row = (await this.pool.query<PageRow>(
      `UPDATE hatch_form_pages SET title = $3, html_key = $4, schema = $5::jsonb, origin = $6::jsonb, version = version + 1, updated_at = NOW()
       WHERE id = $1 AND version = $2 AND status = 'open' RETURNING *`,
      [id, version, revision.title, revision.htmlKey, JSON.stringify(revision.schema), JSON.stringify(revision.origin)])).rows[0];
    if (row) return pageOf(row);
    if ((await this.get(id))?.status === "submitted") throw new FormClosed();
    return undefined;
  }
  async answers(id: string) {
    return (await this.pool.query("SELECT * FROM hatch_form_answers WHERE form_id = $1", [id])).rows.map(answerOf);
  }
  async save(id: string, questionId: string, value: unknown, base: number) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // A share lock on the page: a submit (which updates it) waits for this save, and a save after the submit sees it closed.
      const status = (await client.query("SELECT status FROM hatch_form_pages WHERE id = $1 FOR SHARE", [id])).rows[0]?.status;
      if (status !== "open") throw new FormClosed();
      const current = (await client.query("SELECT * FROM hatch_form_answers WHERE form_id = $1 AND question_id = $2 FOR UPDATE", [id, questionId])).rows[0];
      if ((current?.version ?? 0) !== base) throw new FormConflict({ value: current?.value ?? null, version: current?.version ?? 0 });
      const row = (await client.query(
        `INSERT INTO hatch_form_answers (form_id, question_id, value, version, updated_at) VALUES ($1, $2, $3::jsonb, $4, NOW())
         ON CONFLICT (form_id, question_id) DO UPDATE SET value = EXCLUDED.value, version = EXCLUDED.version, updated_at = NOW() RETURNING *`,
        [id, questionId, value === null ? null : JSON.stringify(value), base + 1])).rows[0];
      await client.query("COMMIT");
      return answerOf(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  async submit(id: string) {
    const closed = (await this.pool.query<PageRow>("UPDATE hatch_form_pages SET status = 'submitted', submitted_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'open' RETURNING *", [id])).rows[0];
    if (closed) return { page: pageOf(closed), first: true };
    return { page: (await this.get(id))!, first: false };
  }
  async notified(id: string) { await this.pool.query("UPDATE hatch_form_pages SET notified_at = COALESCE(notified_at, NOW()) WHERE id = $1", [id]); }
}
