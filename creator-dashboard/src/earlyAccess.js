/** Early access is an account-level flag: it gates unfinished Studio surfaces and is saved on the account. */
export const isEarlyAccess = (profile) => profile?.early_access === true;

export const studioNavItems = (items, earlyAccess) => earlyAccess ? items : items.filter((item) => item.section !== "assistant");

export class EarlyAccessClient {
  constructor(request) { this.request = request; }
  async set(enabled) {
    const account = await this.request("/v1/auth/me", { method: "PATCH", body: JSON.stringify({ early_access: enabled }) });
    return account.early_access === true;
  }
}
