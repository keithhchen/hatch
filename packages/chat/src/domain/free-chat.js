/**
 * Free-chat access derived from a Product's expert-set pricing and the
 * customer's sent-message count. Without a free-message limit chat is open.
 */
export function freeChatAccess(pricing, sentMessageCount) {
  const limit = Number.isSafeInteger(pricing?.free_messages) ? pricing.free_messages : null;
  const options = [
    Number.isSafeInteger(pricing?.human_hourly_minor) ? { id: "human", amount_minor: pricing.human_hourly_minor } : null,
    Number.isSafeInteger(pricing?.agent_monthly_minor) ? { id: "agent", amount_minor: pricing.agent_monthly_minor } : null
  ].filter(Boolean);
  const currency = pricing?.currency ?? "USD";
  if (limit === null) return Object.freeze({ locked: false, remaining: null, limit: null, options, currency });
  const used = Math.max(0, Number(sentMessageCount) || 0);
  return Object.freeze({ locked: used >= limit, remaining: Math.max(0, limit - used), limit, options, currency });
}

/**
 * One Agent's free-chat meter, shared by every conversation with that Agent.
 * Runtime's conversation list sets the count; each accepted message adds one.
 * An owned Agent has no pricing and is never locked.
 */
export class FreeChatMeter {
  constructor(pricing = null) {
    this.pricing = pricing;
    this.count = 0;
    this.snapshot = freeChatAccess(pricing, 0);
    this.listeners = new Set();
  }

  subscribe = listener => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  sync(count) {
    if (Number.isSafeInteger(count)) this.#set(count);
  }

  record() {
    this.#set(this.count + 1);
  }

  #set(count) {
    this.count = count;
    this.snapshot = freeChatAccess(this.pricing, count);
    for (const listener of this.listeners) listener();
  }
}

/** Shared default for Agents without a free-message limit. */
export const OPEN_FREE_CHAT = new FreeChatMeter(null);
