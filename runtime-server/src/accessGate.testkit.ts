import type { AccessCodes, CodeOutcome, DueCode, RedeemResult } from "./accessCodes/accessCodes.js";
import { ACCESS_CODE_CAPABILITY, AccessGate } from "./accessGate.js";
import { InMemoryProductCapabilities } from "./agentBox/capabilities.js";
import { createBriefSnapshot } from "./brief.js";

/** Test-only: the Brief of the website audit, and AccessCodes in memory. Never imported by product code. */
export const PRODUCT = "159c0f12-6e23-4512-af7b-928833d199d7";
export const AUDIT_SPEC = {
  contract_version: "1",
  fields: [
    { id: "name", label: "姓名", required: true, type: "line" },
    { id: "phone", label: "电话", required: true, type: "tel" },
    { id: "email", label: "邮箱", required: true, type: "email" },
    { id: "code", label: "兑换码", required: true, type: "access_code" },
    { id: "website", label: "网址", required: true, type: "line" },
    { id: "markets", label: "出海的国家和地区", required: false, type: "line" }
  ]
} as const;
export const auditBrief = (code: string) => createBriefSnapshot(AUDIT_SPEC, [
  { field_id: "name", value: "A" }, { field_id: "phone", value: "1" }, { field_id: "email", value: "a@b.co" },
  { field_id: "code", value: code }, { field_id: "website", value: "example.com" }
]);

type Row = { status: "pending" | "active" | "used" | "void"; source?: "free" | "paid" | "event"; productId: string; conversationId: string | null; attempts?: number; nextAttemptAt?: number; outcome?: CodeOutcome };
/** Test-only AccessCodes with the real adapter's rules: the Postgres one lives in accessCodes/postgresAccessCodes.ts. */
export class MemoryAccessCodes implements Pick<AccessCodes, "redeem" | "lookup" | "due" | "claim" | "conclude" | "issueFree"> {
  redeems = 0;
  private readonly usedAt = new Map<string, number>();
  constructor(readonly rows: Record<string, Row>) {}
  async redeem({ code, productId, conversationId }: { code: string; productId: string; conversationId: string }): Promise<RedeemResult> {
    this.redeems++;
    const row = this.rows[code.trim().toUpperCase()];
    if (!row) return { ok: false, reason: "not_found" };
    if (row.productId !== productId) return { ok: false, reason: "wrong_product" };
    if (row.status === "pending" || row.status === "void") return { ok: false, reason: "not_paid" };
    if (row.status === "used") return row.conversationId === conversationId ? { ok: true } : { ok: false, reason: "used" };
    if (row.source === "event") return { ok: false, reason: "used" };
    row.status = "used"; row.conversationId = conversationId; this.usedAt.set(code.trim().toUpperCase(), Date.now());
    return { ok: true };
  }
  async lookup(code: string) { const row = this.rows[code.trim().toUpperCase()]; return row ? { status: row.status, productId: row.productId, conversationId: row.conversationId, outcome: row.outcome ?? null, source: row.source ?? "paid" } : null; }
  issued = 0;
  async issueFree(productId: string) { const code = `MSCFREE${++this.issued}`; this.rows[code] = { status: "active", source: "free", productId, conversationId: null }; return code; }
  /** The real adapter's rules, in memory: one claim per (code, attempts), a fresh spend waits 15 s for its own intake. */
  async due(now: Date, limit: number): Promise<DueCode[]> {
    return Object.entries(this.rows)
      .filter(([code, row]) => row.status === "used" && !row.outcome && row.conversationId && (row.nextAttemptAt ?? (this.usedAt.get(code) ?? 0) + 15_000) <= now.getTime())
      .sort((a, b) => (this.usedAt.get(a[0]) ?? 0) - (this.usedAt.get(b[0]) ?? 0)).slice(0, limit)
      .map(([code, row]) => ({ code, productId: row.productId, conversationId: row.conversationId!, attempts: row.attempts ?? 0 }));
  }
  async claim(code: string, attempts: number, nextAt: Date): Promise<boolean> {
    const row = this.rows[code.trim().toUpperCase()];
    if (!row || row.outcome || (row.attempts ?? 0) !== attempts) return false;
    row.attempts = attempts + 1; row.nextAttemptAt = nextAt.getTime();
    return true;
  }
  async conclude(code: string, outcome: CodeOutcome) { const row = this.rows[code.trim().toUpperCase()]; if (row && !row.outcome) row.outcome = outcome; }
}

export const gateOver = (codes?: Pick<AccessCodes, "redeem" | "lookup">, capable = true) =>
  new AccessGate(new InMemoryProductCapabilities(capable ? [[PRODUCT, ACCESS_CODE_CAPABILITY]] : []), codes);
