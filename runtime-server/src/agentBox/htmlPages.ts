import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { decodeText } from "../assets/sniff.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import { BoxToolError } from "./ports.js";
import type { BuyerFiles, BuyerScope, SavedFile } from "./files.js";

/** A saved HTML file published at a link: the page is the file, so publishing the same file again gives the same page. */
export type HtmlPage = { id: string; productId: string; userId: string; fileId: string; title: string; createdAt: string; pdfFileId?: string };

export interface HtmlPageRepository {
  /** The page of this file, created on the first call: one step, so two calls never make two pages. */
  publish(page: Pick<HtmlPage, "productId" | "userId" | "fileId" | "title" | "pdfFileId">): Promise<HtmlPage>;
  get(id: string): Promise<HtmlPage | undefined>;
  /**
   * Take the right to email this page, in one conditional step: true for exactly one caller. A claim whose send never finished
   * (no message id) can be taken again after `staleSeconds`.
   */
  claimEmail(id: string, recipientHash: string, staleSeconds: number): Promise<boolean>;
  markEmailed(id: string, messageId: string): Promise<void>;
  /** Give a claim back after a failed send. */
  releaseEmail(id: string): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_html_pages (
  id UUID PRIMARY KEY,
  product_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, user_id, file_id)
);
ALTER TABLE hatch_html_pages ADD COLUMN IF NOT EXISTS pdf_file_id TEXT;
ALTER TABLE hatch_html_pages ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ;
ALTER TABLE hatch_html_pages ADD COLUMN IF NOT EXISTS emailed_to TEXT;
ALTER TABLE hatch_html_pages ADD COLUMN IF NOT EXISTS email_message_id TEXT;`;

type Row = { id: string; product_id: string; user_id: string; file_id: string; title: string; created_at: Date; pdf_file_id: string | null };
const pageOf = (row: Row): HtmlPage => ({ id: row.id, productId: row.product_id, userId: row.user_id, fileId: row.file_id, title: row.title, createdAt: row.created_at.toISOString(), ...row.pdf_file_id ? { pdfFileId: row.pdf_file_id } : {} });

export class PostgresHtmlPageRepository implements HtmlPageRepository {
  constructor(private readonly db: PostgresQueryExecutor) {}
  async initialize(): Promise<void> { await this.db.query(SCHEMA); }
  async publish(page: Pick<HtmlPage, "productId" | "userId" | "fileId" | "title" | "pdfFileId">): Promise<HtmlPage> {
    // On a conflict the title stays; a PDF given now is attached, one not given is kept.
    const result = await this.db.query(
      `INSERT INTO hatch_html_pages (id, product_id, user_id, file_id, title, pdf_file_id) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (product_id, user_id, file_id) DO UPDATE SET pdf_file_id = COALESCE(EXCLUDED.pdf_file_id, hatch_html_pages.pdf_file_id) RETURNING *`,
      [randomUUID(), page.productId, page.userId, page.fileId, page.title, page.pdfFileId ?? null]);
    return pageOf(result.rows[0] as Row);
  }
  async claimEmail(id: string, recipientHash: string, staleSeconds: number): Promise<boolean> {
    const claimed = await this.db.query(
      `UPDATE hatch_html_pages SET emailed_at = now(), emailed_to = $2, email_message_id = NULL
       WHERE id = $1 AND (emailed_at IS NULL OR (email_message_id IS NULL AND emailed_at < now() - $3::float8 * interval '1 second')) RETURNING id`,
      [id, recipientHash, staleSeconds]);
    return claimed.rows.length === 1;
  }
  async markEmailed(id: string, messageId: string): Promise<void> {
    await this.db.query("UPDATE hatch_html_pages SET email_message_id = $2 WHERE id = $1", [id, messageId]);
  }
  async releaseEmail(id: string): Promise<void> {
    await this.db.query("UPDATE hatch_html_pages SET emailed_at = NULL, emailed_to = NULL WHERE id = $1 AND email_message_id IS NULL", [id]);
  }
  async get(id: string): Promise<HtmlPage | undefined> {
    const row = (await this.db.query("SELECT * FROM hatch_html_pages WHERE id = $1", [id])).rows[0] as Row | undefined;
    return row && pageOf(row);
  }
}

export class MemoryHtmlPageRepository implements HtmlPageRepository {
  private readonly pages: HtmlPage[] = [];
  private readonly emails = new Map<string, { at: number; messageId?: string }>();
  async publish(page: Pick<HtmlPage, "productId" | "userId" | "fileId" | "title" | "pdfFileId">): Promise<HtmlPage> {
    const found = this.pages.find(p => p.productId === page.productId && p.userId === page.userId && p.fileId === page.fileId);
    if (found) { if (page.pdfFileId) found.pdfFileId = page.pdfFileId; return { ...found }; }
    const created: HtmlPage = { productId: page.productId, userId: page.userId, fileId: page.fileId, title: page.title, ...page.pdfFileId ? { pdfFileId: page.pdfFileId } : {}, id: randomUUID(), createdAt: new Date().toISOString() };
    this.pages.push(created);
    return { ...created };
  }
  async get(id: string) { const page = this.pages.find(p => p.id === id); return page && { ...page }; }
  async claimEmail(id: string, _recipientHash: string, staleSeconds: number) {
    const sent = this.emails.get(id);
    if (sent && (sent.messageId || Date.now() - sent.at < staleSeconds * 1000)) return false;
    this.emails.set(id, { at: Date.now() });
    return true;
  }
  async markEmailed(id: string, messageId: string) { this.emails.set(id, { at: this.emails.get(id)?.at ?? Date.now(), messageId }); }
  async releaseEmail(id: string) { if (!this.emails.get(id)?.messageId) this.emails.delete(id); }
}

/** A page's link is signed for that page and never expires: a buyer may forward it to a colleague. */
export class HtmlLinks {
  private readonly key: Buffer;
  constructor(secret: string, private readonly origin: string) {
    if (!secret.trim()) throw new Error("HTML page links need a signing secret");
    this.key = createHmac("sha256", secret).update("hatch-html-link-v1").digest();
  }
  token(pageId: string): string { return createHmac("sha256", this.key).update(pageId).digest("base64url"); }
  verify(pageId: string, token: string | null): boolean {
    if (!token) return false;
    const expected = Buffer.from(this.token(pageId)), supplied = Buffer.from(token);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }
  url(pageId: string): string { return `${this.origin}/html/${pageId}?t=${this.token(pageId)}`; }
}

const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** What makes a file a page: HTML text, whole, small enough to serve. */
export function checkPage(name: string, mime: string, bytes: Buffer): string {
  if (!mime.startsWith("text/html")) throw new BoxToolError(`${name} is not an .html file.`);
  if (bytes.length > MAX_PAGE_BYTES) throw new BoxToolError(`${name} is ${bytes.length} bytes; a page is at most ${MAX_PAGE_BYTES / 1024 / 1024} MB. Move images out of the HTML or make them smaller.`);
  const text = decodeText(bytes);
  if (text === undefined) throw new BoxToolError(`${name} is not UTF-8 text.`);
  if (!/<html[\s>]/i.test(text) || !/<\/html>/i.test(text)) throw new BoxToolError(`${name} is not a whole HTML document: it needs <html> … </html>.`);
  return text;
}

/** publish_html and the page behind its link. */
export class HtmlPages {
  constructor(private readonly repository: HtmlPageRepository, private readonly files: BuyerFiles, private readonly links: HtmlLinks) {}

  /** `pdfFileId` is a saved PDF of the same report, of the same buyer, kept with the page for its download link. */
  async publish(scope: BuyerScope, fileId: string, title: string, pdfFileId?: string): Promise<{ page_id: string; url: string; pdf_url?: string }> {
    const file = await this.files.find(scope, fileId);
    if (!file) throw new BoxToolError(`No saved file has the id ${fileId}. Save the page with save_file first and pass the id it returns.`);
    checkPage(file.name, file.mime, (await this.files.content(scope, fileId))!);
    let pdf: SavedFile | undefined;
    if (pdfFileId) {
      pdf = await this.files.find(scope, pdfFileId);
      if (!pdf) throw new BoxToolError(`No saved file has the id ${pdfFileId}. Save the PDF with save_file first and pass the id it returns as pdf_file_id.`);
      if (pdf.mime !== "application/pdf" || !(await this.files.content(scope, pdfFileId))?.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        throw new BoxToolError(`${pdf.name} is not a PDF file; pdf_file_id takes the id of a saved .pdf.`);
      }
    }
    const page = await this.repository.publish({ productId: scope.productId, userId: scope.userId, fileId, title: title.trim() || file.name, ...pdf ? { pdfFileId: pdf.id } : {} });
    // The page's own PDF, which may have been attached by an earlier publish of the same file.
    const attached = page.pdfFileId ? await this.files.find(scope, page.pdfFileId) : undefined;
    return { page_id: page.id, url: this.links.url(page.id), ...attached ? { pdf_url: attached.url } : {} };
  }

  /** The page's HTML for a valid link; undefined for anything else, so a wrong link and a missing page look the same. */
  async open(pageId: string, token: string | null): Promise<Buffer | undefined> {
    if (!this.links.verify(pageId, token)) return undefined;
    const page = await this.repository.get(pageId);
    return page && this.files.content({ kind: "buyer", productId: page.productId, userId: page.userId }, page.fileId);
  }
}

const ROUTE = /^\/html\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * GET /html/<id>?t=<signature>. The page is the Agent's writing, so it runs sandboxed: no same-origin, so its scripts
 * cannot read Hatch's cookies or call Hatch as the viewer. Returns false for a path that is not a page.
 */
export async function handleHtmlRoute(request: http.IncomingMessage, response: http.ServerResponse, url: URL, pages: HtmlPages | undefined): Promise<boolean> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return false;
  const html = request.method === "GET" && pages ? await pages.open(match[1]!, url.searchParams.get("t")) : undefined;
  const headers = { "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
  if (!html) {
    response.writeHead(pages ? 404 : 503, { ...headers, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invalid link</title></head><body style="font:16px/1.75 system-ui,sans-serif;margin:0;padding:48px 24px;text-align:center">链接无效 · Invalid link</body></html>');
    return true;
  }
  response.writeHead(200, {
    ...headers,
    "content-type": "text/html; charset=utf-8",
    // A page never changes: its file is content-addressed.
    "cache-control": "private, max-age=3600",
    "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
  });
  response.end(html);
  return true;
}
