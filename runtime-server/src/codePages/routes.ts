import type http from "node:http";
import { ChatError } from "../chat/principal.js";
import { readJsonObject, writeJson } from "../http/httpSupport.js";
import type { CodePages } from "./codePages.js";

const CODE_ROUTE = /^\/v1\/codes\/([^/]+)(\/intake)?$/;

/**
 * `GET /v1/codes/<code>`: the state of the code's page. `POST /v1/codes/<code>/intake`: the Brief's answers `{ "<field id>": "<value>" }`,
 * which spends the code and starts the Run; answers with the state after it. The code is the credential: nothing here takes another.
 */
export async function handleCodePageRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, pages: CodePages): Promise<void> {
  const match = CODE_ROUTE.exec(url.pathname);
  if (!match || (match[2] ? req.method !== "POST" : req.method !== "GET")) {
    writeJson(res, match ? 405 : 404, { error: { code: match ? "method_not_allowed" : "not_found", message: match ? "Method not allowed." : "Not found." } });
    return;
  }
  const code = decodeURIComponent(match[1]!);
  res.setHeader("cache-control", "no-store");
  try {
    writeJson(res, 200, match[2] ? await pages.intake(code, await readJsonObject(req), req.headers) : await pages.status(code, req.headers));
  } catch (error) {
    if (!(error instanceof ChatError)) throw error;
    writeJson(res, error.status, { error: { code: error.code, message: error.message } });
  }
}
