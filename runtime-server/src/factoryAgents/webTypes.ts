export type WebSearchRequest = {
  query: string;
  topic?: "general" | "news" | "finance";
  searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
  maxResults?: number;
  timeRange?: "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y";
  startDate?: string;
  endDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  includeRawContent?: boolean;
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  publishedAt?: string;
  score?: number;
  source: string;
};

export type WebSearchResponse = {
  provider: string;
  query: string;
  retrievedAt: string;
  requestId?: string;
  results: WebSearchResult[];
};

export interface WebSearchProvider {
  search(input: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResponse>;
}

export type WebScrapeRequest = {
  url: string;
  format?: "markdown" | "text" | "html";
  extractDepth?: "basic" | "advanced";
  onlyMainContent?: boolean;
  timeoutMs?: number;
};

export type WebScrapeResponse = {
  provider: string;
  url: string;
  retrievedAt: string;
  title?: string;
  description?: string;
  content: string;
  links?: string[];
  statusCode?: number;
  requestId?: string;
};

export interface WebScrapeProvider {
  scrape(input: WebScrapeRequest, signal?: AbortSignal): Promise<WebScrapeResponse>;
}
