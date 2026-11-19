import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type http from "node:http";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../report-assets");
const ROUTE = /^\/report-assets\/(v\d+)\/(report\.css|report\.js)$/;
const MIME: Record<string, string> = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

/**
 * GET /report-assets/vN/report.css|report.js: the stylesheet and script audit reports load by a fixed HTTPS URL, from the
 * buyer's browser and from the Agent's computer. A version's files never change (a new look is a new vN), so they cache forever.
 * Returns false for a path that is not an asset.
 */
export async function handleReportAssetRoute(request: http.IncomingMessage, response: http.ServerResponse, url: URL, root = ROOT): Promise<boolean> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return false;
  const body = request.method === "GET" || request.method === "HEAD" ? await readFile(path.join(root, match[1]!, match[2]!)).catch(() => undefined) : undefined;
  if (!body) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("Not found");
    return true;
  }
  response.writeHead(200, {
    "content-type": MIME[path.extname(match[2]!)]!,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*"
  });
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}
