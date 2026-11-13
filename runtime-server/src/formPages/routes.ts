import type http from "node:http";
import type { FormPages } from "./service.js";
import { FormConflict } from "./schema.js";

const ROUTE = /^\/f\/(form_[a-f0-9]{20})(?:\/(submit)|\/answers\/([^/]+))?$/;
const BODY_MAX_BYTES = 64 * 1024;

const json = (response: http.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > BODY_MAX_BYTES) throw Object.assign(new Error("内容太长"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("请求格式不对"), { status: 400 });
  return body as Record<string, unknown>;
}

/**
 * The Expert's side of a form page, under /f/: open it, save or clear one answer, submit. The signed link (`t`) is the only
 * credential, so these run before sign-in. Returns false for a path that is not a form page.
 */
export async function handleFormRoute(request: http.IncomingMessage, response: http.ServerResponse, url: URL, forms: FormPages | undefined): Promise<boolean> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return false;
  const [, formId, submit, answer] = match as unknown as [string, string, string | undefined, string | undefined];
  if (!forms) { json(response, 503, { error: { code: "forms_unavailable", message: "表单页现在不可用" } }); return true; }
  const token = url.searchParams.get("t");
  try {
    if (request.method === "GET" && !submit && !answer) {
      const html = await forms.open(formId, token);
      // The link is in the address: keep it out of Referer headers, and the page out of caches.
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
      response.end(html);
    } else if (request.method === "POST" && submit) {
      await forms.submit(formId, token);
      json(response, 200, { status: "submitted" });
    } else if (request.method === "POST" && answer) {
      const body = await readBody(request);
      if (!("value" in body) || body.value === null || !Number.isInteger(body.base)) throw Object.assign(new Error("请求格式不对"), { status: 400 });
      json(response, 200, await forms.save(formId, token, decodeURIComponent(answer), body.value, body.base as number));
    } else if (request.method === "DELETE" && answer) {
      const base = Number(url.searchParams.get("base"));
      if (!Number.isInteger(base)) throw Object.assign(new Error("请求格式不对"), { status: 400 });
      json(response, 200, await forms.save(formId, token, decodeURIComponent(answer), null, base));
    } else {
      json(response, 405, { error: { code: "method_not_allowed", message: "不支持这个操作" } });
    }
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (!status) throw error;
    json(response, status, { error: { code: error instanceof FormConflict ? "conflict" : "form_request_failed", message: (error as Error).message } });
  }
  return true;
}
