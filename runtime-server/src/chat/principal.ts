import type { Principal } from "../surfaces/contract.js";

export type ContactPrincipal = Extract<Principal, { kind: "contact" }>;

/** Refusals that pass by themselves: asking again a moment later may be accepted. */
const TRANSIENT_CODES = new Set(["conversation_busy", "connection_unavailable"]);

/** Whether the same request, repeated later, may succeed. A server fault does, except "not implemented"; a refusal of the request itself does not. */
const retryableOf = (code: string, status: number): boolean => TRANSIENT_CODES.has(code) || (status >= 500 && status !== 501 && code !== "unavailable");

/** A failure the caller can show as is. `status` is the HTTP mapping; other transports use `code`. `retryable` tells a channel whether to redeliver the event or answer the sender. */
export class ChatError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: string, message: string, readonly status = 400, retryable?: boolean) {
    super(message);
    this.name = "ChatError";
    this.retryable = retryable ?? retryableOf(code, status);
  }
}

/**
 * The key a conversation is owned by. A contact exists only inside the Connection
 * that met it, so two Connections never share a contact's conversations.
 */
export const principalKey = (principal: Principal): string => principal.kind === "account"
  ? `account:${principal.accountId}`
  : `contact:${principal.connectionId}:${principal.contactId}`;

export const accountPrincipal = (accountId: string): Principal => ({ kind: "account", accountId });
