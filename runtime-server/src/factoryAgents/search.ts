import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { log } from "../observability/log.js";
import { result } from "./files.js";

export type SearchRequest = { query: string; objective: string };
export type SearchHit = { title: string; url: string; publishedAt?: string; excerpts: string[] };
export type SearchResponse = { provider: string; query: string; retrievedAt: string; results: SearchHit[] };

/** Port: a web search that answers a goal with sources and the passages that matter. */
export interface SearchProvider {
  readonly name: string;
  search(input: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
}

/** The configured provider has no key (or is unknown): the node reports it; nothing else answers in its place. */
export class SearchUnavailableError extends Error {
  readonly code = "search_unavailable";
  readonly status = 503;
}

type Fetcher = typeof globalThis.fetch;
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";

async function post(fetcher: Fetcher, provider: string, url: string, key: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify(body), signal });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${provider} search failed (${response.status}): ${raw.slice(0, 500)}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Exa: the recommended request is the query, its objective and highlights. */
export class ExaSearchProvider implements SearchProvider {
  readonly name = "exa";
  constructor(private readonly apiKey: string, private readonly fetcher: Fetcher = globalThis.fetch, private readonly baseUrl = "https://api.exa.ai") {}
  async search({ query, objective }: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    const payload = await post(this.fetcher, "Exa", `${this.baseUrl}/search`, this.apiKey, { query, objective, type: "auto", contents: { highlights: true } }, signal);
    return { provider: this.name, query, retrievedAt: new Date().toISOString(), results: asArray(payload.results).map(item => {
      const hit = item as Record<string, unknown>;
      return { title: text(hit.title), url: text(hit.url), ...(text(hit.publishedDate) ? { publishedAt: text(hit.publishedDate) } : {}), excerpts: asArray(hit.highlights).map(text).filter(Boolean) };
    }) };
  }
}

/** Known mirror/redirect hosts that duplicate a source under another domain. */
const MIRROR_HOSTS = new Set(["pear.autos"]);
const NAVIGATION_NOISE = /^\s*(expand user menu|reply|share|report|save|award|upvote|downvote|skip to content|menu|sign in|log in|\|[-\s|]*\|?)\s*$/i;

/** One URL, one entry: query string and fragment never name a different source. */
export const canonicalUrl = (url: string): string => { try { const u = new URL(url); return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`; } catch { return url; } };
const cleanExcerpt = (excerpt: string): string => excerpt.split("\n").filter(line => !NAVIGATION_NOISE.test(line)).join("\n").trim();

/** Parallel Search, `basic` mode (never fast/turbo: they are weak on Chinese and forums): an objective plus the queries that serve it. */
export class ParallelSearchProvider implements SearchProvider {
  readonly name = "parallel";
  constructor(private readonly apiKey: string, private readonly fetcher: Fetcher = globalThis.fetch, private readonly baseUrl = "https://api.parallel.ai") {}
  async search({ query, objective }: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    const payload = await post(this.fetcher, "Parallel", `${this.baseUrl}/v1/search`, this.apiKey, { objective, search_queries: [query], mode: "basic" }, signal);
    const seen = new Set<string>();
    const results: SearchHit[] = [];
    for (const item of asArray(payload.results)) {
      const hit = item as Record<string, unknown>;
      const url = text(hit.url);
      const key = canonicalUrl(url);
      let host = "";
      try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep an unparsable URL out below */ }
      if (!host || MIRROR_HOSTS.has(host) || seen.has(key)) continue;
      seen.add(key);
      results.push({ title: text(hit.title), url, ...(text(hit.publish_date) ? { publishedAt: text(hit.publish_date) } : {}), excerpts: asArray(hit.excerpts).map(text).map(cleanExcerpt).filter(Boolean) });
    }
    return { provider: this.name, query, retrievedAt: new Date().toISOString(), results };
  }
}

/** HATCH_SEARCH_PROVIDER picks the adapter (default parallel; exa is the alternative, better on competitor and pricing pages). Seam for another (e.g. Chinese search): add a case, nothing else changes. */
export function searchProviderFrom(env: NodeJS.ProcessEnv, fetcher?: Fetcher): SearchProvider {
  const name = (env.HATCH_SEARCH_PROVIDER?.trim() || "parallel").toLowerCase();
  const keyName = name === "exa" ? "EXA_API_KEY" : name === "parallel" ? "PARALLEL_API_KEY" : undefined;
  if (!keyName) { log.error("search_unavailable", { reason: "unknown HATCH_SEARCH_PROVIDER", provider: name }); throw new SearchUnavailableError("Web search is unavailable: it is not configured on this server."); }
  const key = env[keyName]?.trim();
  if (!key) { log.error("search_unavailable", { reason: "missing key", env: keyName }); throw new SearchUnavailableError("Web search is unavailable: it is not configured on this server."); }
  return name === "exa" ? new ExaSearchProvider(key, fetcher) : new ParallelSearchProvider(key, fetcher);
}

/** Resolves the configured provider at each call: a process without a key still starts, and a use says why it cannot search. */
export const lazySearchProvider = (env: NodeJS.ProcessEnv): SearchProvider => ({
  get name() { return searchProviderFrom(env).name; },
  search: (input, signal) => searchProviderFrom(env).search(input, signal),
});

/** The provider if configured, else undefined. */
export function configuredSearch(env: NodeJS.ProcessEnv): SearchProvider | undefined {
  try { return searchProviderFrom(env); } catch (error) { if (error instanceof SearchUnavailableError) return undefined; throw error; }
}

export function webSearchTool(provider: SearchProvider): AgentTool {
  return {
    name: "web_search", label: "搜索资料",
    description: "Search the public web. `objective` is required: say what the search serves, which sources should rank first (primary, recent, original), which to exclude, and which facts to pull. `query` is a keyword query (a few distinctive keywords, not a sentence). Returns sources with the relevant excerpts and URLs, not verified full documents; follow useful ones with web_scrape for the full page. No generated answer.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }), objective: Type.String({ minLength: 1, description: "The goal this search serves and what a good result looks like." }) }),
    execute: async (_id, raw, signal) => {
      const a = raw as SearchRequest;
      return result(await provider.search(a, AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(90000)])));
    },
  };
}
