import type { AccessCodes, RedeemResult } from "./accessCodes/accessCodes.js";
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

type Row = { status: "pending" | "active" | "used" | "void"; productId: string; conversationId: string | null };
/** Test-only AccessCodes with the real adapter's rules: the Postgres one lives in accessCodes/postgresAccessCodes.ts. */
export class MemoryAccessCodes implements Pick<AccessCodes, "redeem" | "lookup"> {
  redeems = 0;
  constructor(readonly rows: Record<string, Row>) {}
  async redeem({ code, productId, conversationId }: { code: string; productId: string; conversationId: string }): Promise<RedeemResult> {
    this.redeems++;
    const row = this.rows[code.trim().toUpperCase()];
    if (!row) return { ok: false, reason: "not_found" };
    if (row.productId !== productId) return { ok: false, reason: "wrong_product" };
    if (row.status === "pending" || row.status === "void") return { ok: false, reason: "not_paid" };
    if (row.status === "used") return row.conversationId === conversationId ? { ok: true } : { ok: false, reason: "used" };
    row.status = "used"; row.conversationId = conversationId;
    return { ok: true };
  }
  async lookup(code: string) { const row = this.rows[code.trim().toUpperCase()]; return row ? { ...row, source: "paid" as const } : null; }
}

export const gateOver = (codes?: Pick<AccessCodes, "redeem" | "lookup">, capable = true) =>
  new AccessGate(new InMemoryProductCapabilities(capable ? [[PRODUCT, ACCESS_CODE_CAPABILITY]] : []), codes && (() => codes));
