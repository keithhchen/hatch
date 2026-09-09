import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { WorkbenchStore, ROLES, type Session } from "./store.js";
import { WorkbenchRuntime, safeError, type WorkbenchRuntimeOptions } from "./runtime.js";
import { hatchTool } from "./hatchTool.js";
import { corpusTools } from "./corpusTools.js";
import { evaluationTargets, resolveEvaluationTarget } from "./targets.js";

const targetSchema = z.object({ entitlementId: z.string().uuid().optional(), productId: z.string().uuid(), briefAnswers: z.array(z.object({ field_id: z.string(), value: z.string() }).strict()).optional() }).strict();
export function publicSession(s: Session) { const { context, ...publicData } = s; return publicData; }

export async function createFactoryHandler(options: { root: string; env?: NodeJS.ProcessEnv; runtime?: WorkbenchRuntimeOptions }) {
  const env = { ...(options.env ?? process.env) };
  const store = new WorkbenchStore(options.root);
  await store.recover();
  const runtime = new WorkbenchRuntime(store, { env, ...options.runtime, extraTools: options.runtime?.extraTools ?? (async (s, _signal, changed) => s.role === "evaluator" ? [hatchTool(store, s.id, changed, env)] : s.role === "generation" ? corpusTools(store, s.id, changed, env) : []) });
  const streams = new Set<ServerResponse>();
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://factory.internal");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      if (url.pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        streams.add(res);
        res.write("event: connected\ndata: {}\n\n");
        const listener = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        runtime.events.on("event", listener);
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
        res.once("close", () => { clearInterval(heartbeat); streams.delete(res); runtime.events.off("event", listener); });
        return;
      }
      if (url.pathname === "/api/config" && req.method === "GET") return json(res, 200, { roles: ROLES, runtimeUrl: env.HATCH_FACTORY_RUNTIME_URL ?? "", services: { kimi: Boolean(env.LLM_API_KEY), search: Boolean(env.TAVILY_API_KEY), scrape: Boolean(env.HATCH_FACTORY_SCRAPE_PROVIDER === "firecrawl" ? env.FIRECRAWL_API_KEY : env.TAVILY_API_KEY), hatch: Boolean(env.HATCH_FACTORY_RUNTIME_URL && (env.HATCH_FACTORY_CREATOR_TOKEN || env.HATCH_FACTORY_AUTH_TOKEN)), corpus: Boolean(env.HATCH_FACTORY_REGISTRY_URL && env.HATCH_FACTORY_CREATOR_TOKEN) } });

      if (url.pathname === "/api/evaluation-targets" && req.method === "GET") return json(res, 200, await evaluationTargets(store, env));
      if (url.pathname === "/api/sessions" && req.method === "GET") return json(res, 200, { sessions: (await store.list()).map(s => ({ ...publicSession(s), messages: undefined })) });
      if (url.pathname === "/api/sessions" && req.method === "POST") { const b = z.object({ role: z.enum(ROLES), title: z.string().max(200).optional() }).parse(await body(req)); return json(res, 201, publicSession(await store.create(b.role, b.title))); }
      const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})(?:\/(.*))?$/);
      if (match) {
        const id = match[1]!; const action = match[2] ?? "";
        if (!action && req.method === "GET") return json(res, 200, publicSession(await store.get(id)));
        if (action === "prompt" && req.method === "GET") return json(res, 200, { content: await runtime.prompt((await store.get(id)).role) });
        if (action === "message" && req.method === "POST") { const b = z.object({ content: z.string().min(1).max(100000) }).parse(await body(req)); await runtime.start(id, b.content); return json(res, 202, { accepted: true }); }
        if (action === "stop" && req.method === "POST") { await body(req); runtime.stop(id); return json(res, 202, { requested: true }); }
        if (action === "target" && req.method === "PUT") {
          const b = targetSchema.parse(await body(req));
          const selectedTarget = await resolveEvaluationTarget(store, env, b);
          await store.update(id, s => { if (s.role !== "evaluator" || s.status === "running" || s.hatch) throw new Error("Target can only be set on an idle evaluation before first execution"); s.target = selectedTarget; });
          return json(res, 200, { saved: true });
        }
        if (action === "files" && req.method === "POST") {
          const b = z.object({ path: z.string(), base64: z.string(), mimeType: z.string().optional() }).parse(await body(req));
          const bytes = Buffer.from(b.base64, "base64");
          const record = await store.put(id, b.path, bytes, { actor: "user", mimeType: b.mimeType });
          runtime.emit(id, "files"); return json(res, 201, record);
        }
        if (action === "files" && req.method === "GET") {
          const data = await store.read(id, url.searchParams.get("path") ?? "");
          if (url.searchParams.get("download") === "1") { res.writeHead(200, { "Content-Type": data.record.mimeType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(data.record.path))}` }); res.end(data.bytes); return; }
          return json(res, 200, { ...data.record, content: /^text\//.test(data.record.mimeType) || /\.(md|txt|json|csv|srt|vtt)$/.test(data.record.path) ? data.bytes.toString("utf8") : null });
        }
        if (action === "files" && req.method === "DELETE") { const b = z.object({ path: z.string() }).parse(await body(req)); await store.removeInput(id, b.path); runtime.emit(id, "files"); return json(res, 200, { removed: true }); }
        if (action === "transfer" && req.method === "POST") {
          const b = z.object({ fromSessionId: z.string().uuid(), files: z.array(z.object({ path: z.string() })).min(1).max(100) }).parse(await body(req));
          if (b.fromSessionId === id) throw new Error("Choose a different destination workspace");
          const destination = await store.get(id);
          if (destination.status === "running") throw new Error("Stop the destination chat before adding files");
          for (const f of b.files) {
            if (!f.path.startsWith("output/")) throw new Error("Only output files may be handed off");
            const { bytes, record } = await store.read(b.fromSessionId, f.path);
            await store.put(id, `input/${f.path.slice(7)}`, bytes, { actor: "user", mimeType: record.mimeType, origin: { sessionId: b.fromSessionId, path: f.path } });
          }
          runtime.emit(id, "files"); return json(res, 200, { transferred: b.files.length });
        }
        if (action === "comments" && req.method === "POST") {
          const b = z.object({ path: z.string(), start: z.number().int(), end: z.number().int(), quote: z.string(), text: z.string().min(1).max(20000), replacement: z.string().max(100000).optional() }).parse(await body(req));
          const comment = await store.comment(id, b); runtime.emit(id, "comments"); return json(res, 201, comment);
        }
        if (action === "comments/export" && req.method === "POST") {
          await body(req); const s = await store.get(id);
          const text = `# 专家批注\n\n${s.comments.map(c => `## ${c.path}\n\n原文：\n\n> ${c.quote.replaceAll("\n", "\n> ")}\n\n意见：${c.text}\n${c.replacement === undefined ? "" : `\n建议替换：\n\n${c.replacement}\n`}`).join("\n")}`;
          const record = await store.put(id, "output/REVIEW.md", Buffer.from(text), { actor: "user" });
          runtime.emit(id, "files"); return json(res, 200, record);
        }
      }
      return json(res, 404, { error: "Unknown API route" });
    } catch (error) { json(res, 400, { error: safeError(error) }); }
  };
  return { handle, store, runtime, setCreatorToken: (token: string) => { env.HATCH_FACTORY_CREATOR_TOKEN = token; }, close: async () => { for (const response of streams) response.end(); await runtime.close(); } };
}

// Local transport for automated tests; the product mounts the same handler behind Registry authentication.
export async function createWorkbenchServer(options: Parameters<typeof createFactoryHandler>[0]) {
  const app = await createFactoryHandler(options);
  const server = http.createServer((req, res) => {
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!req.headers.host || !allowed.has(req.headers.host) || req.headers.origin && !allowed.has(new URL(req.headers.origin).host)) { json(res, 403, { error: "Cross-origin request rejected" }); return; }
    void app.handle(req, res);
  });
  return { ...app, server, close: async () => { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

function json(res: ServerResponse, status: number, value: unknown): void { if (res.headersSent) { res.end(); return; } res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); }
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("application/json required");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 29 * 1024 * 1024) throw new Error("Request too large"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
