import type http from "node:http";
import type { GuestCarryOver } from "../chat/library.js";
import { GUEST_PREFIX } from "../chat/principal.js";
import { resolveAuthIdentity } from "../chat/sessionBinding.js";
import { ConversationError as ConversationHttpError } from "../conversations/conversation.js";
import type { AuthIdentityResolver } from "../entitlements.js";
import type { GuestTokens } from "../guestToken.js";
import { bearerToken, readJsonObject, requiredString, writeJsonBounded } from "./httpSupport.js";
import { requireAllowedOrigin } from "./requestBinding.js";

export type GuestRouteDeps = {
  guests?: GuestTokens;
  carryOver?: Pick<GuestCarryOver, "carry">;
  authIdentityResolver?: AuthIdentityResolver;
  allowedOrigins: readonly string[];
  maxHttpResponseBytes: number;
};

/**
 * `POST /v1/guest/carry-over`: a signed-in account (the bearer) names the guest it was a moment ago (`guest_token`, the token the dashboard
 * issued for that browser). Both are verified, so nobody can take another visitor's conversations. Repeating it moves nothing more.
 */
export async function handleGuestRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: GuestRouteDeps, signal?: AbortSignal): Promise<boolean> {
  if (url.pathname !== "/v1/guest/carry-over") return false;
  if (req.method !== "POST") throw new ConversationHttpError(405, "method_not_allowed", "Use POST.");
  requireAllowedOrigin(req, deps.allowedOrigins);
  if (!deps.guests || !deps.carryOver) throw new ConversationHttpError(503, "guest_unavailable", "Guest chat is not configured on this Runtime.");
  const account = await resolveAuthIdentity(bearerToken(req), deps.authIdentityResolver, signal);
  if (!account || account.sub.startsWith(GUEST_PREFIX)) throw new ConversationHttpError(401, "authentication_required", "Sign in to keep your conversations.");
  const body = await readJsonObject(req);
  const guestId = deps.guests.idOf(requiredString(body, "guest_token", 512));
  if (!guestId) throw new ConversationHttpError(400, "invalid_guest", "That guest token is not valid.");
  writeJsonBounded(res, 200, await deps.carryOver.carry(`${GUEST_PREFIX}${guestId}`, account.sub), deps.maxHttpResponseBytes);
  return true;
}
