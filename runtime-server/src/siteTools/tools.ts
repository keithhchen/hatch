import { z } from "zod";
import type { ProductCapabilities } from "../agentBox/capabilities.js";
import type { ToolDefinition } from "../tools.js";
import { SiteToolError, type SiteLookup, type SiteResult } from "./ports.js";

/** A Product that may research sites and places with the tools below. */
export const SITE_RESEARCH_CAPABILITY = "site_research";

/** The site tools of one conversation. */
export interface SiteToolRunner {
  run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<SiteResult>;
}

type Entry = { description: string; properties: Record<string, unknown>; required: string[]; lookup: SiteLookup<any> };

const definition = (name: string, { description, properties, required }: Entry): ToolDefinition => ({
  name: `site.${name}`, locality: "server", approval: "none", description, readOnly: true, schema: z.object({}).passthrough(),
  model: { name, locality: "server", description, properties, required }
});

/** The lookups that are configured, by tool name. The key of each is its own: a lookup without one is not offered. */
export type SiteLookups = Partial<Record<"page_speed" | "place_search" | "ip_info" | "url_scan", SiteLookup<any>>>;

const ENTRIES = (lookups: SiteLookups): Record<string, Entry | undefined> => ({
  page_speed: lookups.page_speed && { lookup: lookups.page_speed, required: ["url"],
    description: "Measure how fast a web page loads: performance score 0-100, load metrics (LCP, FCP, CLS, TBT, Speed Index) and the five biggest improvements. Takes up to two minutes.",
    properties: { url: { type: "string", description: "The page's full URL." }, strategy: { type: "string", enum: ["mobile", "desktop"], description: "Device to test as; default mobile." } } },
  place_search: lookups.place_search && { lookup: lookups.place_search, required: ["query"],
    description: "Find businesses and places on the map by name or description: name, address, categories, rating, number of ratings, map link and whether it is operating. Up to five matches.",
    properties: { query: { type: "string", description: "What to look for, e.g. a company name and its city." } } },
  ip_info: lookups.ip_info && { lookup: lookups.ip_info, required: ["target"],
    description: "Where a server is hosted: the country, network number and network name of an IP address, or of each address a host name points to.",
    properties: { target: { type: "string", description: "An IP address or a host name." } } },
  url_scan: lookups.url_scan && { lookup: lookups.url_scan, required: ["url"],
    description: "Open a web page in a real browser and report what it loaded: final address, page status, server location and network, certificate issuer and validity, detected technologies, and the other domains it pulls content from. Takes up to a few minutes; the scan is not public.",
    properties: { url: { type: "string", description: "The page's full URL." } } }
});

export class SiteResearchMode {
  private readonly entries: Record<string, Entry>;
  constructor(private readonly capabilities: ProductCapabilities, lookups: SiteLookups) {
    this.entries = Object.fromEntries(Object.entries(ENTRIES(lookups)).filter((pair): pair is [string, Entry] => pair[1] !== undefined));
  }

  definitions(): ToolDefinition[] { return Object.entries(this.entries).map(([name, entry]) => definition(name, entry)); }

  /** The tools of a turn, or undefined when the Product has not switched site research on. They touch no buyer data: a guest has them too. */
  async turnFor(productId: string): Promise<{ extraTools: string[]; tools: SiteToolRunner } | undefined> {
    if (!await this.capabilities.has(productId, SITE_RESEARCH_CAPABILITY)) return undefined;
    const entries = this.entries;
    return {
      extraTools: Object.keys(entries).map(name => `site.${name}`),
      tools: {
        async run(name, args, signal) {
          const entry = entries[name];
          if (!entry) throw new Error(`No site tool: ${name}`);
          try { return await entry.lookup.run(args, signal); }
          catch (error) {
            if (error instanceof SiteToolError) return { status: "error", error: { code: error.code, message: error.message } };
            throw error;
          }
        }
      }
    };
  }
}
