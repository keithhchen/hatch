import type { ConnectionRepository } from "./connections.js";
import type { ChannelKind } from "./types.js";

/** Port: the access token of one platform tenant (a Slack workspace, a Page, a WhatsApp business account). Absent means access is gone. */
export type TenantTokens = (tenant: string) => Promise<string | undefined>;

/** Tokens held as sealed credentials on the tenant's Connection, so a tenant is configured without a deploy and revoking its Connection ends its access. */
export const sealedTokens = (connections: Pick<ConnectionRepository, "credentialsOf">, seal: { open<T>(sealed: string): T }, channel: ChannelKind): TenantTokens =>
  async tenant => {
    const sealed = await connections.credentialsOf(channel, tenant);
    return sealed ? seal.open<{ token?: string }>(sealed).token : undefined;
  };
