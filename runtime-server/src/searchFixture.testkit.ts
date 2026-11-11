import http from "node:http";
import { after, before } from "node:test";

/**
 * A test-only web search endpoint. The deterministic runtime searches before anything else, and an unconfigured web search
 * is an error in every environment, so tests that run it point HATCH_WEB_SEARCH_URL here for the whole file.
 */
export function useSearchFixture(): void {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: [{ title: "Hatch runtime architecture", url: "https://example.invalid/hatch/runtime", snippet: "Test fixture." }] }));
  });
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (typeof address === "object" && address) process.env.HATCH_WEB_SEARCH_URL = `http://127.0.0.1:${address.port}/search`;
  });
  after(async () => {
    delete process.env.HATCH_WEB_SEARCH_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}
