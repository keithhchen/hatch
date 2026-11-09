import type { Principal } from "../surfaces/contract.js";

export type ContactPrincipal = Extract<Principal, { kind: "contact" }>;

/** A failure the caller can show as is. `status` is the HTTP mapping; other transports use `code`. */
export class ChatError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "ChatError";
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
