// Adapted from pi-runtime-lab search adapters; Voice lab remains unchanged.
import { readBoundedResponseText } from "../boundedResponse.js";
import type {
  WebScrapeProvider,
  WebScrapeRequest,
  WebScrapeResponse,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult
} from "./webTypes.js";

export type TavilySearchProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

/** Raw-evidence search adapter. It deliberately does not ask Tavily to generate an answer. */
export class TavilySearchProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: TavilySearchProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TAVILY_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.tavily.com").replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async search(input: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResponse> {
    if (!this.apiKey) throw new Error("Tavily search is unavailable: TAVILY_API_KEY is not configured");
    const query = input.query.trim();
    if (!query) throw new Error("Web search query is required");

    const response = await this.fetcher(`${this.baseUrl}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        query,
        topic: input.topic ?? "general",
        search_depth: input.searchDepth ?? "basic",
        max_results: input.maxResults ?? 5,
        time_range: input.timeRange,
        start_date: input.startDate,
        end_date: input.endDate,
        include_domains: input.includeDomains,
        exclude_domains: input.excludeDomains,
        include_raw_content: input.includeRawContent ? "markdown" : false,
        include_answer: false
      }),
      signal
    });

    const body = await readBoundedResponseText(response);
    const payload = parseJson(body);
    if (!response.ok) {
      throw new Error(`Tavily search failed (${response.status}): provider request rejected`);
    }

    const results = Array.isArray(payload.results) ? payload.results.map(normalizeResult) : [];
    return {
      provider: "tavily",
      query: typeof payload.query === "string" ? payload.query : query,
      retrievedAt: new Date().toISOString(),
      requestId: typeof payload.request_id === "string" ? payload.request_id : undefined,
      results
    };
  }
}

export class TavilyScrapeProvider implements WebScrapeProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: TavilySearchProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TAVILY_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.tavily.com").replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async scrape(input: WebScrapeRequest, signal?: AbortSignal): Promise<WebScrapeResponse> {
    if (!this.apiKey) throw new Error("Tavily scrape is unavailable: TAVILY_API_KEY is not configured");
    const url = validUrl(input.url);
    const response = await this.fetcher(`${this.baseUrl}/extract`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        urls: [url],
        extract_depth: input.extractDepth ?? "basic",
        format: input.format === "text" ? "text" : "markdown",
        include_favicon: false,
        include_images: false
      }),
      signal
    });
    const body = await readBoundedResponseText(response);
    const payload = parseJson(body);
    if (!response.ok) throw new Error(`Tavily scrape failed (${response.status}): provider request rejected`);
    const result = Array.isArray(payload.results) ? record(payload.results[0]) : {};
    const content = stringValue(result.raw_content);
    if (!content) {
      const failed = Array.isArray(payload.failed_results) ? record(payload.failed_results[0]) : {};
      throw new Error(`Tavily scrape returned no content for ${url}${stringValue(failed.error) ? `: ${failed.error}` : ""}`);
    }
    return { provider: "tavily", url: stringValue(result.url) || url, retrievedAt: new Date().toISOString(), content };
  }
}

export class FirecrawlSearchProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: TavilySearchProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.FIRECRAWL_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.firecrawl.dev").replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async search(input: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResponse> {
    if (!this.apiKey) throw new Error("Firecrawl search is unavailable: FIRECRAWL_API_KEY is not configured");
    const query = input.query.trim();
    if (!query) throw new Error("Web search query is required");
    const response = await this.fetcher(`${this.baseUrl}/v2/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        query,
        limit: input.maxResults ?? 5,
        sources: [input.topic === "news" ? "news" : "web"],
        includeDomains: input.includeDomains,
        excludeDomains: input.excludeDomains,
        tbs: firecrawlTimeRange(input.timeRange),
        scrapeOptions: input.includeRawContent ? { formats: ["markdown"], onlyMainContent: true } : undefined
      }),
      signal
    });
    const body = await readBoundedResponseText(response);
    const payload = parseJson(body);
    if (!response.ok) throw new Error(`Firecrawl search failed (${response.status}): provider request rejected`);
    const data = record(payload.data);
    const values = Array.isArray(payload.data) ? payload.data : [...arrayValue(data.web), ...arrayValue(data.news)];
    return {
      provider: "firecrawl",
      query,
      retrievedAt: new Date().toISOString(),
      results: values.map(normalizeFirecrawlResult)
    };
  }
}

export class FirecrawlScrapeProvider implements WebScrapeProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: TavilySearchProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.FIRECRAWL_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.firecrawl.dev").replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async scrape(input: WebScrapeRequest, signal?: AbortSignal): Promise<WebScrapeResponse> {
    if (!this.apiKey) throw new Error("Firecrawl scrape is unavailable: FIRECRAWL_API_KEY is not configured");
    const url = validUrl(input.url);
    const format = input.format ?? "markdown";
    const response = await this.fetcher(`${this.baseUrl}/v2/scrape`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        url,
        formats: [format === "html" ? "html" : "markdown"],
        onlyMainContent: input.onlyMainContent ?? true,
        timeout: input.timeoutMs ?? 60_000
      }),
      signal
    });
    const body = await readBoundedResponseText(response);
    const payload = parseJson(body);
    if (!response.ok || payload.success === false) {
      throw new Error(`Firecrawl scrape failed (${response.status}): provider request rejected`);
    }
    const data = record(payload.data);
    const content = stringValue(data.markdown ?? data.html ?? data.rawHtml ?? data.text);
    if (!content) throw new Error(`Firecrawl scrape returned no content for ${url}`);
    const metadata = record(data.metadata);
    return {
      provider: "firecrawl",
      url: stringValue(metadata.sourceURL) || url,
      retrievedAt: new Date().toISOString(),
      title: stringValue(metadata.title) || undefined,
      description: stringValue(metadata.description) || undefined,
      content,
      links: arrayValue(data.links).map(stringValue).filter(Boolean),
      statusCode: typeof metadata.statusCode === "number" ? metadata.statusCode : undefined,
      requestId: stringValue(metadata.scrapeId) || undefined
    };
  }
}

function normalizeResult(value: unknown): WebSearchResult {
  const result = record(value);
  const url = stringValue(result.url);
  let source = url;
  try {
    source = new URL(url).hostname;
  } catch {
    // Keep the original value for malformed provider URLs; the evidence remains inspectable.
  }
  return {
    title: stringValue(result.title),
    url,
    snippet: stringValue(result.content ?? result.snippet),
    content: typeof result.raw_content === "string" ? result.raw_content : undefined,
    publishedAt: stringValue(result.published_date ?? result.publishedDate) || undefined,
    score: typeof result.score === "number" ? result.score : undefined,
    source
  };
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value));
  } catch {
    return { raw: value.slice(0, 2_000) };
  }
}

function errorMessage(payload: Record<string, unknown>, fallback: string): string {
  return stringValue(payload.detail ?? payload.message ?? payload.error) || fallback.slice(0, 2_000);
}

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" ? value as Record<string, any> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Public HTTP(S) URL required");
    return url.toString();
  } catch {
    throw new Error(`Invalid web URL: ${value}`);
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeFirecrawlResult(value: unknown): WebSearchResult {
  const result = record(value);
  const url = stringValue(result.url);
  let source = url;
  try {
    source = new URL(url).hostname;
  } catch {
    // Keep the original value for malformed provider URLs.
  }
  return {
    title: stringValue(result.title),
    url,
    snippet: stringValue(result.description ?? result.snippet ?? result.markdown),
    content: stringValue(result.markdown) || undefined,
    publishedAt: stringValue(result.date) || undefined,
    source
  };
}

function firecrawlTimeRange(value: WebSearchRequest["timeRange"]): string | undefined {
  if (value === "day" || value === "d") return "qdr:d";
  if (value === "week" || value === "w") return "qdr:w";
  if (value === "month" || value === "m") return "qdr:m";
  if (value === "year" || value === "y") return "qdr:y";
  return undefined;
}
