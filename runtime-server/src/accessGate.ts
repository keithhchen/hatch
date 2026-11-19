import type http from "node:http";
import type { AccessCodes } from "./accessCodes/accessCodes.js";
import { TooManyAttempts } from "./accessCodes/rateLimit.js";
import type { ProductCapabilities } from "./agentBox/capabilities.js";
import { briefAccessCode, type BriefSnapshot } from "./brief.js";
import { ChatError } from "./chat/principal.js";

/** A Product whose buyers come in by an access code and a page of their own (/c/<code>), never the chat: switched on per Product by a `hatch_product_capabilities` row. */
export const ACCESS_CODE_CAPABILITY = "access_code";

/** What the gate needs of the codes (see accessCodes/accessCodes.ts): spend one for a conversation, and read where one stands. */
export type GateCodes = Pick<AccessCodes, "redeem" | "lookup">;
/** The codes as one client sees them: the adapter limits failed attempts per client address, so the client's request headers pick it. */
export type GateCodesFor = (headers: http.IncomingHttpHeaders | undefined) => GateCodes | undefined;

export const REFUSALS = {
  not_found: "兑换码不存在", not_paid: "尚未支付", used: "已被使用", wrong_product: "不适用于此产品"
} as const;

/** TooManyAttempts is the limiter's own 429: it leaves as a ChatError, which every path already shows. */
export const limited = <T>(attempt: Promise<T>): Promise<T> => attempt.catch((error) => {
  throw error instanceof TooManyAttempts ? new ChatError("too_many_attempts", error.message, 429) : error;
});

/**
 * What is special about a Product with the access code capability, in one place. Every question asks the capability first, so a
 * Product without it is never touched.
 */
export class AccessGate {
  constructor(private readonly capabilities: ProductCapabilities, readonly codesFor?: GateCodesFor) {}

  /** Whether the Product's buyers come in by access code. Such a Product has no chat for them: its conversations are not theirs to open. */
  required(productId: string): Promise<boolean> { return this.capabilities.has(productId, ACCESS_CODE_CAPABILITY); }

  /** The codes as this client sees them; a Runtime without the codes adapter has none, and nothing starts. */
  codes(headers?: http.IncomingHttpHeaders): GateCodes {
    const codes = this.codesFor?.(headers);
    if (!codes) throw new ChatError("access_codes_unavailable", "兑换码服务暂不可用", 503);
    return codes;
  }

  /** Spends the Brief's code for the conversation before anything runs, or refuses with the reason. The same conversation again is ok. */
  async admit(productId: string, conversationId: string, brief: BriefSnapshot | undefined, headers?: http.IncomingHttpHeaders): Promise<void> {
    const codes = this.codes(headers);
    const code = briefAccessCode(brief);
    const result = code ? await limited(codes.redeem({ code, productId, conversationId })) : { ok: false as const, reason: "not_found" as const };
    if (!result.ok) throw new ChatError(`access_code_${result.reason}`, REFUSALS[result.reason], 403);
  }
}
