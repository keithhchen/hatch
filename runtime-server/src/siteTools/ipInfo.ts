import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
import { callJson, requireString, SiteToolError, type Fetch, type SiteLookup } from "./ports.js";

/** Where an IP address, or a host name's addresses, sit: country, network number and network name. */
export class IpInfo implements SiteLookup<{ target?: unknown }> {
  constructor(private readonly fetcher: Fetch, private readonly token: string, private readonly resolve: (host: string) => Promise<string[]> = resolve4) {}

  async run(args: { target?: unknown }, signal?: AbortSignal) {
    const target = requireString(args.target, "target");
    let addresses: string[];
    if (isIP(target)) addresses = [target];
    else {
      try { addresses = await this.resolve(target); } catch { throw new SiteToolError("not_found", `${target} has no IPv4 address.`); }
    }
    const ips = await Promise.all(addresses.slice(0, 10).map(async ip => {
      const body = await callJson(this.fetcher, `https://api.cloudflare.com/client/v4/radar/entities/ip?ip=${encodeURIComponent(ip)}`, { headers: { Authorization: `Bearer ${this.token}` } }, 30_000, signal) as
        { result?: { ip?: { location?: string; locationName?: string; asn?: string; asnName?: string; asnOrgName?: string } } };
      const found = body?.result?.ip;
      return { ip, country: found?.locationName ?? found?.location, country_code: found?.location, asn: found?.asn, asn_name: found?.asnName, organization: found?.asnOrgName };
    }));
    return { target, ips };
  }
}
