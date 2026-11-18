import { PostgresProductCapabilities } from "../agentBox/capabilities.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import { IpInfo } from "./ipInfo.js";
import { PageSpeed } from "./pageSpeed.js";
import { PlaceSearch } from "./placeSearch.js";
import type { Fetch } from "./ports.js";
import { SiteResearchMode, type SiteLookups } from "./tools.js";
import { UrlScan } from "./urlScan.js";

/** The lookups whose keys are set: PAGESPEED_API_KEY, GOOGLE_MAPS_API_KEY, CF_API_TOKEN (+ CF_ACCOUNT_ID for scans). */
export function siteLookupsFromEnvironment(environment: NodeJS.ProcessEnv, fetcher: Fetch = fetch): SiteLookups {
  const value = (name: string) => environment[name]?.trim() || undefined;
  const pagespeed = value("PAGESPEED_API_KEY"), maps = value("GOOGLE_MAPS_API_KEY"), cloudflare = value("CF_API_TOKEN"), account = value("CF_ACCOUNT_ID");
  return {
    ...pagespeed ? { page_speed: new PageSpeed(fetcher, pagespeed) } : {},
    ...maps ? { place_search: new PlaceSearch(fetcher, maps) } : {},
    ...cloudflare ? { ip_info: new IpInfo(fetcher, cloudflare) } : {},
    ...cloudflare && account ? { url_scan: new UrlScan(fetcher, cloudflare, account) } : {}
  };
}

/** Site research in production; off (undefined) when no key is configured. */
export async function openSiteResearchMode(options: { pool: PostgresQueryExecutor; environment: NodeJS.ProcessEnv }): Promise<SiteResearchMode | undefined> {
  const lookups = siteLookupsFromEnvironment(options.environment);
  if (Object.keys(lookups).length === 0) return undefined;
  const capabilities = new PostgresProductCapabilities(options.pool);
  await capabilities.initialize();
  return new SiteResearchMode(capabilities, lookups);
}
