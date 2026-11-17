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
  : principal.kind === "guest" ? `guest:${principal.guestId}` : `contact:${principal.connectionId}:${principal.contactId}`;

export const accountPrincipal = (accountId: string): Principal => ({ kind: "account", accountId });

/** A web visitor who has not signed in is identified by `guest:<id>`; no account id has that shape. */
export const GUEST_PREFIX = "guest:";

/** The principal behind a verified user id: an account, or a guest. */
export const userPrincipal = (userId: string): Principal => userId.startsWith(GUEST_PREFIX)
  ? { kind: "guest", guestId: userId.slice(GUEST_PREFIX.length) }
  : accountPrincipal(userId);

/** The Hatch account a principal acts as, when it has one: where its Agents are saved. */
export const accountOf = (principal: Principal): string | undefined => {
  const accountId = principal.kind === "guest" ? undefined : principal.kind === "contact" ? principal.accountId : principal.accountId;
  // A visitor's Run that the system starts (a report) runs as the owner of a guest's conversation: that is no account.
  return accountId?.startsWith(GUEST_PREFIX) ? undefined : accountId;
};
