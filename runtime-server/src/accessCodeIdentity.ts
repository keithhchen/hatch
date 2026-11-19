import type { AccessCodes } from "./accessGate.js";
import type { AuthIdentity, AuthIdentityResolver, AuthorizationRequestOptions } from "./entitlements.js";

const TOKEN_PREFIX = "hatch_code.";

/**
 * A used access code is a bearer credential for the one conversation it was spent on. It travels with the visitor's ordinary token as
 * `hatch_code.<code>~<token>`: the ordinary token is resolved as always, and a used code turns it into the owner of the conversation the
 * code was spent on, limited (`only`) to that one conversation of that Product. Any other code changes nothing.
 */
export class AccessCodeIdentityResolver implements AuthIdentityResolver {
  constructor(
    private readonly inner: AuthIdentityResolver | undefined,
    private readonly codes: Pick<AccessCodes, "lookup"> | undefined,
    private readonly conversationOf: (conversationId: string) => Promise<{ ownerAccountId: string; publicId: string } | undefined>
  ) {}

  async resolveIdentity(authToken?: string, options?: AuthorizationRequestOptions): Promise<AuthIdentity | undefined> {
    if (!authToken?.startsWith(TOKEN_PREFIX)) return this.inner?.resolveIdentity(authToken, options);
    const rest = authToken.slice(TOKEN_PREFIX.length);
    const split = rest.indexOf("~");
    const code = split < 0 ? rest : rest.slice(0, split);
    const own = await this.inner?.resolveIdentity(split < 0 ? undefined : rest.slice(split + 1), options);
    const held = code && this.codes ? await this.codes.lookup(code) : null;
    if (held?.status !== "used" || !held.conversationId) return own;
    const conversation = await this.conversationOf(held.conversationId);
    if (!conversation) return own;
    return { sub: conversation.ownerAccountId, only: { productId: held.productId, conversationId: conversation.publicId } };
  }
}
