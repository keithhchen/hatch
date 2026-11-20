/**
 * An access code lets one conversation of one Product start. It is bought (pending until paid) or issued free by an operator (inserted
 * active). An event code (source `event`, inserted active by an operator) is never spent: each intake under it issues a new free code
 * of its own, and voiding it ends the event.
 */
export type AccessCodeStatus = "pending" | "active" | "used" | "void";
export type AccessCodeSource = "free" | "paid" | "event";
export type PayChannel = "jsapi" | "h5";

/** How a spent code's conversation ended: a published report, or a visible failure. Absent while it is still being worked on. */
export type CodeOutcome = "ready" | "failed";
/** A spent code whose conversation is not finished and whose next attempt is due. `attempts` is how many actions were claimed so far. */
export type DueCode = { code: string; productId: string; conversationId: string; attempts: number };

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
  /** A new active free code for the Product (an event code's intake draws one per person). */
  issueFree(productId: string): Promise<string>;
  /** active -> used by this conversation, in one step. An event code is never spent. The same conversation redeeming again is ok. */
  redeem(input: { code: string; productId: string; conversationId: string }): Promise<RedeemResult>;
  /** Where a code stands and, once used, the conversation it opened: opening the chat with a used code lands back in that conversation. Null when unknown. */
  lookup(code: string): Promise<{ status: AccessCodeStatus; source: AccessCodeSource; productId: string; conversationId: string | null; outcome: CodeOutcome | null } | null>;
  /** Spent codes with a conversation and no outcome whose next attempt is due at `now` (a fresh spend waits a few seconds for its own intake), oldest first. */
  due(now: Date, limit: number): Promise<DueCode[]>;
  /** Takes attempt number `attempts` (the value read from `due`) and schedules the next one at `nextAt`: true for exactly one caller, whatever the instance. */
  claim(code: string, attempts: number, nextAt: Date): Promise<boolean>;
  /** The code's conversation is finished, once. */
  conclude(code: string, outcome: CodeOutcome): Promise<void>;
  peek(code: string): Promise<AccessCodeView | undefined>;
  order(outTradeNo: string): Promise<AccessCodeOrder | undefined>;
}
