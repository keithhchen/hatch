/** Port: the access token of one platform tenant (a Slack workspace, a Page, a WhatsApp number). Absent means access is gone. */
export type TenantTokens = (tenant: string) => Promise<string | undefined>;

/** Tokens an operator configured: a JSON object of tenant id to token. Absent when nothing is configured. */
export function configuredTokens(json: string | undefined): TenantTokens | undefined {
  if (!json?.trim()) return undefined;
  const tokens = new Map(Object.entries(JSON.parse(json) as Record<string, string>));
  return async tenant => tokens.get(tenant);
}
