/** Who is paying, inside WeChat: the openid of the Official Account's follower-or-not visitor (scope snsapi_base, no consent page). */
export interface OpenIdResolver {
  authorizeUrl(redirectUri: string): string;
  openidFor(code: string): Promise<string>;
}

export class WeChatOAuth implements OpenIdResolver {
  constructor(
    private readonly appid: string,
    private readonly secret: string,
    private readonly options: { apiBase?: string; fetch?: typeof fetch } = {}
  ) {}

  authorizeUrl(redirectUri: string): string {
    return `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${this.appid}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_base&state=hatchpay#wechat_redirect`;
  }

  async openidFor(code: string): Promise<string> {
    const url = `${this.options.apiBase ?? "https://api.weixin.qq.com"}/sns/oauth2/access_token?appid=${this.appid}&secret=${this.secret}&code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const response = await (this.options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
    // The URL holds the AppSecret: it is never logged or put in an error.
    const body = await response.json().catch(() => ({})) as { openid?: string; errcode?: number; errmsg?: string };
    if (!response.ok || !body.openid) throw new Error(`WeChat OAuth failed: ${body.errcode ?? response.status} ${body.errmsg ?? ""}`.trim());
    return body.openid;
  }
}
