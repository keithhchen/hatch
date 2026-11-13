// Adapted from pi-runtime-lab search adapters; Voice lab remains unchanged.
import { readBoundedResponseText } from "../boundedResponse.js";
import type {
  WebScrapeProvider,
  WebScrapeRequest,
  WebScrapeResponse
} from "./webTypes.js";

export type TavilySearchProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

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

/** The scrape provider Workers and the Assistant share: Tavily unless the Registry is set to Firecrawl. */
export function scrapeProviderFrom(env: NodeJS.ProcessEnv): WebScrapeProvider {
  const name = env.HATCH_FACTORY_SCRAPE_PROVIDER;
  if (name && !["tavily", "firecrawl"].includes(name)) throw new Error("Unknown scrape provider");
  return name === "firecrawl" ? new FirecrawlScrapeProvider({ apiKey: env.FIRECRAWL_API_KEY }) : new TavilyScrapeProvider({ apiKey: env.TAVILY_API_KEY });
}
