import { callJson, requireString, SiteToolError, type Fetch, type SiteLookup } from "./ports.js";

type Raw = Record<string, any>;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** Loads a page in a real browser run by the service and reports what it saw. Always unlisted; at most one submit per submitGapMs. */
export class UrlScan implements SiteLookup<{ url?: unknown }> {
  private gate: Promise<void> = Promise.resolve();
  constructor(private readonly fetcher: Fetch, private readonly token: string, private readonly accountId: string,
    private readonly options: { pollMs: number; maxWaitMs: number; submitGapMs: number } = { pollMs: 10_000, maxWaitMs: 150_000, submitGapMs: 10_000 }) {}

  private get base() { return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/urlscanner/v2`; }
  private get headers() { return { Authorization: `Bearer ${this.token}`, "content-type": "application/json" }; }

  /** One submit per gap, in order: each waits for the one before it. */
  private submitted<T>(submit: () => Promise<T>): Promise<T> {
    const turn = this.gate.then(submit);
    this.gate = turn.then(() => sleep(this.options.submitGapMs), () => sleep(this.options.submitGapMs)).catch(() => undefined);
    return turn;
  }

  async run(args: { url?: unknown }, signal?: AbortSignal) {
    const url = requireString(args.url, "url");
    const started = await this.submitted(() => callJson(this.fetcher, `${this.base}/scan`, { method: "POST", headers: this.headers, body: JSON.stringify({ url, visibility: "Unlisted" }) }, 30_000, signal)) as Raw;
    const uuid = started?.uuid;
    if (typeof uuid !== "string") throw new SiteToolError("no_result", "The scan was not accepted.");
    for (let waited = 0; waited <= this.options.maxWaitMs; waited += this.options.pollMs) {
      await sleep(this.options.pollMs, signal);
      try {
        return this.summary(await callJson(this.fetcher, `${this.base}/result/${uuid}`, { headers: this.headers }, 30_000, signal) as Raw);
      } catch (error) {
        if (!(error instanceof SiteToolError && error.code === "http_404")) throw error; // 404: not finished yet
      }
    }
    throw new SiteToolError("timeout", `The scan did not finish within ${this.options.maxWaitMs / 1000} seconds.`);
  }

  private summary(result: Raw) {
    const task = result.task ?? {}, page = result.page ?? {}, lists = result.lists ?? {};
    const certificate = (lists.certificates ?? [])[0];
    const pageHost = (() => { try { return new URL(page.url ?? task.url).hostname; } catch { return ""; } })();
    const registrable = (host: string) => host.split(".").slice(-2).join(".");
    const hosts = [...(lists.domains ?? []) as string[], ...((lists.urls ?? []) as string[]).map(address => { try { return new URL(address).hostname; } catch { return ""; } })];
    const thirdParty = [...new Set(hosts.filter(Boolean))].filter(domain => registrable(domain) !== registrable(pageHost)).slice(0, 50);
    return {
      requested_url: task.url,
      final_url: page.url,
      status: Number(page.status) || (result.data?.requests ?? [])[0]?.response?.response?.status,
      server: { ip: page.ip, country: page.country, asn: page.asn, asn_name: page.asnname },
      certificate: certificate ? { issuer: certificate.issuer || page.tlsIssuer || undefined, valid_from: certificate.validFrom, valid_to: certificate.validTo } : undefined,
      technologies: ((result.meta?.processors?.wappa?.data ?? []) as Array<{ app?: string }>).map(tech => tech.app).filter(Boolean),
      third_party_domains: thirdParty
    };
  }
}
