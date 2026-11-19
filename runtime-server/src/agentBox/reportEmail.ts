import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Resend } from "resend";
import type { Prompts } from "../prompts.js";
import type { HtmlPageRepository } from "./htmlPages.js";

/** One email out. `idempotencyKey` makes a repeat of the same send a no-op at the provider. */
export type EmailMessage = { from: string; to: string; replyTo?: string; subject: string; html: string; text: string; idempotencyKey: string };

export interface EmailSender {
  /** Returns the provider's message id; throws TransientEmailError for what is worth another try. */
  send(message: EmailMessage): Promise<{ id: string }>;
}

export class TransientEmailError extends Error {}

/** Resend, by its SDK. Network failures, 429 and 5xx are transient; anything else (bad address, bad key) is not. */
export class ResendSender implements EmailSender {
  private readonly client: Resend;
  constructor(apiKey: string) { this.client = new Resend(apiKey); }
  async send(message: EmailMessage) {
    const { idempotencyKey, replyTo, ...mail } = message;
    let result;
    try {
      result = await this.client.emails.send({ ...mail, ...replyTo ? { replyTo } : {} }, { idempotencyKey });
    } catch (error) { throw new TransientEmailError(error instanceof Error ? error.message : "send failed"); }
    if (result.error) {
      const status = result.error.statusCode;
      if (status === null || status === 429 || status >= 500) throw new TransientEmailError(result.error.message);
      throw new Error(`${result.error.name}: ${result.error.message}`);
    }
    return { id: result.data!.id };
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ESCAPES[c]!);

/**
 * `{{name}}` is the value (HTML-escaped unless `plain`); `{{#name}}…{{/name}}` stays only when the value is not empty. Unknown
 * names are empty. Blocks do not nest.
 */
export function renderTemplate(source: string, values: Record<string, string | undefined>, plain = false): string {
  const value = (name: string) => values[name]?.trim() ?? "";
  return source
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, name: string, body: string) => value(name) ? body : "")
    .replace(/\{\{(\w+)\}\}/g, (_, name: string) => plain ? value(name) : escapeHtml(value(name)));
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** The plain-text alternative of any template: links kept as "text (url)", blocks on their own lines. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => `${text.replace(/<[^>]*>/g, "")} (${href})`)
    .replace(/<br\s*\/?>|<\/(p|tr|div|h\d|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, entity => ENTITIES[entity]!)
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** An Expert's own template, in the Product Corpus beside the system prompt; either file may be absent. */
export type ReportEmailTemplate = { html?: string; subject?: string };
export async function readCorpusEmailTemplate(corpusRoot: string | undefined): Promise<ReportEmailTemplate | undefined> {
  if (!corpusRoot) return undefined;
  const read = (name: string) => readFile(path.join(corpusRoot, "runtime", "email", name), "utf8").then(text => text.trim() || undefined, () => undefined);
  const [html, subject] = await Promise.all([read("report.html"), read("report.subject.txt")]);
  return html || subject ? { ...html ? { html } : {}, ...subject ? { subject } : {} } : undefined;
}

export type ReportEmailJob = {
  pageId: string;
  recipient: string;
  reportUrl: string;
  chatUrl: string;
  productName: string;
  expertName?: string;
  website?: string;
  /** The access code of a code-gated Product and the page of it (/c/<code>). */
  code?: string;
  codeUrl?: string;
  template?: ReportEmailTemplate;
};

export type ReportEmailLog = (event: string, fields: Record<string, unknown>) => void;
const stdoutLog: ReportEmailLog = (event, fields) => { process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`); };

/** A claim whose send never finished (the process died) is taken over after this long; the provider's idempotency key covers the overlap. */
const STALE_CLAIM_SECONDS = 600;

export type ReportEmailOptions = {
  pages: HtmlPageRepository;
  prompts: Prompts;
  /** Without a sender (no RESEND_API_KEY) sending is off: logged, never faked. */
  sender?: EmailSender;
  from: string;
  replyTo?: string;
  retryDelaysMs?: number[];
  log?: ReportEmailLog;
};

/**
 * The report email of a published page. At most one per page: the page row is claimed with a conditional update before
 * anything is sent, and the page id is the provider's idempotency key. Never throws: a failed email is logged, not a failed publish.
 */
export class ReportEmails {
  private readonly retryDelaysMs: number[];
  private readonly log: ReportEmailLog;
  constructor(private readonly options: ReportEmailOptions) {
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 5_000, 20_000];
    this.log = options.log ?? stdoutLog;
  }

  /** Callers do not await it: it resolves when the work is done and never rejects. */
  notify(job: ReportEmailJob): Promise<void> {
    return this.deliver(job).catch(error => this.log("report_email_error", { page_id: job.pageId, error: error instanceof Error ? error.name : "unknown" }));
  }

  private async deliver(job: ReportEmailJob): Promise<void> {
    const { sender, pages, prompts } = this.options;
    const to = createHash("sha256").update(job.recipient.toLowerCase()).digest("hex").slice(0, 12);
    if (!sender) return this.log("report_email_off", { page_id: job.pageId, reason: "RESEND_API_KEY is not set" });
    if (!await pages.claimEmail(job.pageId, to, STALE_CLAIM_SECONDS)) return this.log("report_email_skipped", { page_id: job.pageId, to });
    try {
      const values = { report_url: job.reportUrl, chat_url: job.chatUrl, product_name: job.productName, expert_name: job.expertName, website: job.website, code: job.code, code_url: job.codeUrl };
      const [html, subject] = await Promise.all([
        job.template?.html ?? prompts.get("report-email-default"),
        job.template?.subject ?? prompts.get("report-email-default-subject")
      ]);
      const rendered = renderTemplate(html, values);
      const message: EmailMessage = {
        from: this.options.from, to: job.recipient, ...this.options.replyTo ? { replyTo: this.options.replyTo } : {},
        subject: renderTemplate(subject, values, true).replace(/\s+/g, " ").trim(), html: rendered, text: htmlToText(rendered), idempotencyKey: job.pageId
      };
      for (let attempt = 0; ; attempt++) {
        try {
          const { id } = await sender.send(message);
          await pages.markEmailed(job.pageId, id);
          return this.log("report_email_sent", { page_id: job.pageId, to, message_id: id, attempts: attempt + 1 });
        } catch (error) {
          const delay = this.retryDelaysMs[attempt];
          if (!(error instanceof TransientEmailError) || delay === undefined) throw error;
          this.log("report_email_retry", { page_id: job.pageId, to, attempt: attempt + 1 });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    } catch (error) {
      // Not sent: give the claim back, so publishing the page again tries again.
      await pages.releaseEmail(job.pageId).catch(() => undefined);
      this.log("report_email_failed", { page_id: job.pageId, to, error: error instanceof Error ? error.name : "unknown" });
    }
  }
}
