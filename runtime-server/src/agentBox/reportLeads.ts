import type http from "node:http";
import type { AccessCodes } from "../accessCodes/accessCodes.js";
import { briefAnswer, briefEmail } from "../brief.js";
import type { ConversationRepository } from "../conversationRepository.js";
import { readJsonObject, setCorsHeaders } from "../http/httpSupport.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import type { HtmlLinks, HtmlPage, HtmlPageRepository } from "./htmlPages.js";

/** A buyer's click on one price tier of a report; who they are is what the conversation's Brief says. */
export type Tier = { tierIndex: number; tierName: string; tierPrice: string };
export type Contact = { conversationId: string | null; accessCode: string | null; name: string | null; phone: string | null; email: string | null };
export type Lead = Contact & Tier & { pageId: string; productId: string };

export interface LeadRepository {
  /** One lead per page and tier, in one conditional step: true for the first click, false for every repeat. */
  record(lead: Lead): Promise<boolean>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_report_leads (
  page_id UUID NOT NULL,
  tier_index INT NOT NULL,
  tier_name TEXT NOT NULL,
  tier_price TEXT NOT NULL,
  product_id TEXT NOT NULL,
  conversation_id TEXT,
  access_code TEXT,
  buyer_name TEXT,
  buyer_phone TEXT,
  buyer_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, tier_index)
);`;

export class PostgresLeadRepository implements LeadRepository {
  constructor(private readonly db: PostgresQueryExecutor) {}
  async initialize(): Promise<void> { await this.db.query(SCHEMA); }
  async record(l: Lead): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO hatch_report_leads (page_id, tier_index, tier_name, tier_price, product_id, conversation_id, access_code, buyer_name, buyer_phone, buyer_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (page_id, tier_index) DO NOTHING RETURNING page_id`,
      [l.pageId, l.tierIndex, l.tierName, l.tierPrice, l.productId, l.conversationId, l.accessCode, l.name, l.phone, l.email]);
    return result.rows.length === 1;
  }
}

export class MemoryLeadRepository implements LeadRepository {
  readonly leads: Lead[] = [];
  async record(lead: Lead): Promise<boolean> {
    if (this.leads.some(l => l.pageId === lead.pageId && l.tierIndex === lead.tierIndex)) return false;
    this.leads.push(lead);
    return true;
  }
}

/** The buyer behind a page: for a code's page, the Brief of the conversation the code opened; for any other page, nobody known. */
export type ContactOf = (page: HtmlPage) => Promise<Contact>;
const NOBODY: Contact = { conversationId: null, accessCode: null, name: null, phone: null, email: null };

export const briefContactOf = (codes: Pick<AccessCodes, "lookup">, repository: Pick<ConversationRepository, "getConversation">): ContactOf => async page => {
  if (!page.userId.startsWith("code:")) return NOBODY;
  const accessCode = page.userId.slice("code:".length);
  const conversationId = (await codes.lookup(accessCode))?.conversationId ?? null;
  const brief = conversationId ? (await repository.getConversation(conversationId))?.briefSnapshot : undefined;
  const phone = brief?.fields.find(field => field.type === "tel");
  return { conversationId, accessCode, name: briefAnswer(brief, "name") ?? null, phone: (phone && briefAnswer(brief, phone.id)) ?? null, email: briefEmail(brief) ?? null };
};

export type LeadOutcome = "recorded" | "duplicate" | "forbidden" | "not_found" | "rate_limited";

/** A tiny fixed-window counter per key, in memory: enough to stop a loop in a page, and gone on restart. */
export class WindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  allow(key: string): boolean {
    const now = this.now(), w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) { this.windows.set(key, { start: now, count: 1 }); return true; }
    return ++w.count <= this.max;
  }
}

/** POST /html/<id>/lead: the signature of the page is the credential, and a page's tier is recorded once. */
export class ReportLeads {
  constructor(
    private readonly pages: Pick<HtmlPageRepository, "get">, private readonly links: Pick<HtmlLinks, "verify">, private readonly repository: LeadRepository,
    private readonly contactOf: ContactOf, private readonly limiter = new WindowLimiter(30, 60_000)) {}

  async record(pageId: string, token: string | null, tier: Tier): Promise<LeadOutcome> {
    if (!this.links.verify(pageId, token)) return "forbidden";
    const page = await this.pages.get(pageId);
    if (!page) return "not_found";
    if (!this.limiter.allow(pageId)) return "rate_limited";
    const first = await this.repository.record({ ...await this.contactOf(page), ...tier, pageId, productId: page.productId });
    return first ? "recorded" : "duplicate";
  }
}

const STATUS = { recorded: 200, duplicate: 200, forbidden: 403, not_found: 404, rate_limited: 429 } as const;

/**
 * POST /html/<id>/lead?t=<signature> `{ tier_index, tier_name, tier_price }`. The sandboxed page has an opaque origin and no cookies, so any
 * origin may call it (and its preflight) and the page's signature is the credential.
 */
export async function handleLead(request: http.IncomingMessage, response: http.ServerResponse, pageId: string, token: string | null, leads: ReportLeads | undefined): Promise<void> {
  setCorsHeaders(response);
  const reply = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  if (request.method !== "POST" || !leads) return reply(leads ? 405 : 503, { error: "unavailable" });
  let body: Record<string, unknown>;
  try { body = await readJsonObject(request); } catch { return reply(400, { error: "invalid_body" }); }
  const { tier_index: index, tier_name: name, tier_price: price } = body;
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 9 || typeof name !== "string" || typeof price !== "string" || !name.trim() || name.length > 200 || price.length > 40) return reply(400, { error: "invalid_tier" });
  const outcome = await leads.record(pageId, token, { tierIndex: index as number, tierName: name.trim(), tierPrice: price.trim() });
  reply(STATUS[outcome], { ok: outcome === "recorded" || outcome === "duplicate", outcome });
}
