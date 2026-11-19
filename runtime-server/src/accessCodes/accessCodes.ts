/** An access code lets one conversation of one Product start. It is bought (pending until paid) or issued free by an operator (inserted active). */
export type AccessCodeStatus = "pending" | "active" | "used" | "void";
export type AccessCodeSource = "free" | "paid";
export type PayChannel = "jsapi" | "h5";

export type AccessCodeView = { code: string; productId: string; status: AccessCodeStatus; source: AccessCodeSource; usedByConversationId: string | null };

/** The order behind a bought code, as the payment flow needs it. */
export type AccessCodeOrder = { code: string; productId: string; email: string | null; name: string | null; status: AccessCodeStatus; source: AccessCodeSource };

export type Activation = AccessCodeOrder & {
  /** True only for the call that moved the code from pending to active: that caller sends the email. */
  activated: boolean;
};

export type RedeemResult = { ok: true } | { ok: false; reason: "not_found" | "not_paid" | "used" | "wrong_product" };

export interface AccessCodes {
  /** A pending code for a payment about to be started. */
  createPending(input: { productId: string; email: string; name?: string; payChannel?: PayChannel }): Promise<{ code: string; outTradeNo: string }>;
  /**
   * pending -> active, once. A repeat (or a concurrent twin) is a no-op that reports `activated: false`. A payment of another amount
   * than the order's activates nothing. Undefined when no order has this number.
   */
  activatePaid(input: { outTradeNo: string; transactionId: string; amountFen: number }): Promise<Activation | undefined>;
  /** active -> used by this conversation, in one step. The same conversation redeeming again is ok. */
  redeem(input: { code: string; productId: string; conversationId: string }): Promise<RedeemResult>;
  /** Where a code stands and, once used, the conversation it opened: opening the chat with a used code lands back in that conversation. Null when unknown. */
  lookup(code: string): Promise<{ status: AccessCodeStatus; source: AccessCodeSource; productId: string; conversationId: string | null } | null>;
  peek(code: string): Promise<AccessCodeView | undefined>;
  order(outTradeNo: string): Promise<AccessCodeOrder | undefined>;
}
