import { PostgresProductCapabilities, type ProductCapabilities } from "./agentBox/capabilities.js";
import type { PostgresQueryExecutor } from "./postgresStore.js";
import { briefAccessCode, type BriefSnapshot } from "./brief.js";
import { ChatError } from "./chat/principal.js";

/** A Product that asks for a single-use access code before its first Run, switched on per Product by a `hatch_product_capabilities` row. */
export const ACCESS_CODE_CAPABILITY = "access_code";

export type RedeemFailure = "not_found" | "not_paid" | "used" | "wrong_product";
export type RedeemResult = { ok: true } | { ok: false; reason: RedeemFailure };

/**
 * Port: spend an access code for one conversation. Atomic, and idempotent per conversation: the conversation that already
 * holds the code gets `ok` again, any other conversation gets `used`.
 */
export interface AccessCodes {
  redeem(input: { code: string; productId: string; conversationId: string }): Promise<RedeemResult>;
  /** What the code is now, without changing it; null for a code that does not exist. `conversationId` is the one it was redeemed for. */
  lookup(code: string): Promise<{ status: "pending" | "active" | "used" | "void"; productId: string; conversationId: string | null } | null>;
}

const REFUSALS: Record<RedeemFailure, string> = {
  not_found: "兑换码不存在", not_paid: "尚未支付", used: "已被使用", wrong_product: "不适用于此产品"
};

/**
 * Before a Run of a Product with the access code capability: the Brief's code is redeemed for the conversation, or the Run is
 * refused. A Product without the capability is not asked. Without a codes adapter the gate refuses: it never lets a Run through unchecked.
 */
export class AccessGate {
  constructor(private readonly capabilities: ProductCapabilities, readonly codes?: AccessCodes) {}

  /** Whether the Product asks for an access code at all. */
  required(productId: string): Promise<boolean> { return this.capabilities.has(productId, ACCESS_CODE_CAPABILITY); }

  /** Whether this session may open the conversation: a Product with an access code opens only the conversation the session's code was used for. */
  async opens(session: { productId: string; only?: { productId: string; conversationId: string } }, publicId: string): Promise<boolean> {
    return !await this.required(session.productId) || (session.only?.productId === session.productId && session.only.conversationId === publicId);
  }

  /** The conversation this Brief's code was already used for, when the Product asks for a code: the code opens it instead of starting another. */
  async usedBy(productId: string, brief: BriefSnapshot | undefined): Promise<string | undefined> {
    const code = briefAccessCode(brief);
    if (!code || !this.codes || !await this.capabilities.has(productId, ACCESS_CODE_CAPABILITY)) return undefined;
    const held = await this.codes.lookup(code);
    return held?.status === "used" && held.productId === productId ? held.conversationId ?? undefined : undefined;
  }

  async admit(productId: string, conversationId: string, brief: BriefSnapshot | undefined): Promise<void> {
    if (!await this.capabilities.has(productId, ACCESS_CODE_CAPABILITY)) return;
    if (!this.codes) throw new ChatError("access_codes_unavailable", "兑换码服务暂不可用", 503);
    const code = briefAccessCode(brief);
    const result: RedeemResult = code ? await this.codes.redeem({ code, productId, conversationId }) : { ok: false, reason: "not_found" };
    if (!result.ok) throw new ChatError(`access_code_${result.reason}`, REFUSALS[result.reason], 403);
  }
}

/** The gate over the Runtime's database. `codes` is the adapter that holds the codes; without one a Product with the capability refuses every Run. */
export async function openAccessGate(pool: PostgresQueryExecutor, codes?: AccessCodes): Promise<AccessGate> {
  const capabilities = new PostgresProductCapabilities(pool);
  await capabilities.initialize();
  return new AccessGate(capabilities, codes);
}
