import { MAX_PROTOCOL_ID_CHARS } from "../protocol.js";
import { ChatError } from "./principal.js";

/**
 * The one reading of a client's idempotency key, for every surface that accepts one (Studio's page, Studio's API, the Chat
 * API): it is the message's `client_message_id`, the same length everywhere, and never silently shortened, because two
 * different keys cut to one would be one message. Nothing for a request without a key.
 */
export function messageKey(raw: unknown): string | undefined {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return undefined;
  if (key.length > MAX_PROTOCOL_ID_CHARS) throw new ChatError("invalid_idempotency_key", `The idempotency key is at most ${MAX_PROTOCOL_ID_CHARS} characters.`, 400);
  return key;
}
