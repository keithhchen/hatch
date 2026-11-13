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
