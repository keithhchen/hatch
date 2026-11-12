import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { WorkbenchStore, ROLES, isAssistantRole, type Comment, type FactoryProductScope, type Session } from "./store.js";
import { WorkbenchRuntime, safeError, type WorkbenchRuntimeOptions } from "./runtime.js";
import { hatchTool } from "./hatchTool.js";
import { corpusTools } from "./corpusTools.js";
import { agentEntries, assertAgentAvailable, type AgentDefinitionRepository } from "./definitions.js";
import { resolveFactoryLlmProfile } from "../llmProfiles.js";
import { factoryAgentTools } from "./factoryTools.js";
import { convertUpload } from "./markdownConverter.js";
import { modelRole } from "../modelRoles.js";

export function publicSession(s: Session) { const { context, ...publicData } = s; return publicData; }

export async function createFactoryHandler(options: { root: string; scope: FactoryProductScope; definitions: AgentDefinitionRepository; env?: NodeJS.ProcessEnv; runtime?: WorkbenchRuntimeOptions; withheldTools?: (session: Session) => Promise<string[]> }) {
  const source = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = { ...source, HATCH_FACTORY_LLM_PROFILE: modelRole("factory", source) };
  const store = new WorkbenchStore(options.root, options.scope, options.definitions);
  await store.recover();
  const runtime = new WorkbenchRuntime(store, { env, ...options.runtime, withheldTools: options.runtime?.withheldTools ?? options.withheldTools, extraTools: options.runtime?.extraTools ?? (async (s, _signal, changed) => [...corpusTools(store, s.id, changed, options.scope, env), hatchTool(store, s.id, changed, options.scope, env)]) });
  const streams = new Set<ServerResponse>();
  const chatStreams = new Set<ServerResponse>();
  const entries = async () => agentEntries(await options.definitions.list(), await store.list(), await store.listManualFiles());
  const assertRoleAvailable = async (role: Session["role"]) => { if (isAssistantRole(role)) throw new Error("Assistant sessions are not part of a Product workspace"); return assertAgentAvailable(await entries(), role); };
  const factorySnapshot = async () => {
    const sessions = await store.list();
    const manualFiles = await store.listManualFiles();
    return {
      type: "snapshot" as const,
      manualFiles,
      agents: agentEntries(await options.definitions.list(), sessions, manualFiles),
      sessions: sessions.map(session => ({
        id: session.id,
        role: session.role,
        status: session.status,
        updatedAt: session.updatedAt,
        outputUpdatedAt: session.outputUpdatedAt,
        todos: session.todos,
      })),
    };
  };
  const writeSse = (res: ServerResponse, value: unknown) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  let snapshotQueue = Promise.resolve();
  const enqueueFactorySnapshot = (target?: ServerResponse) => {
    snapshotQueue = snapshotQueue.then(async () => {
      const snapshot = await factorySnapshot();
      if (target) writeSse(target, snapshot);
      else for (const response of streams) writeSse(response, snapshot);
    }).catch(() => undefined);
    return snapshotQueue;
  };
  runtime.events.on("event", (event: any) => {
    if (["state", "files", "todos", "message", "comments"].includes(event?.type)) void enqueueFactorySnapshot();
  });
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://factory.internal");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      if (url.pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        streams.add(res);
        const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": heartbeat\n\n"); }, 15000);
        res.once("close", () => { clearInterval(heartbeat); streams.delete(res); });
        await enqueueFactorySnapshot(res);
        return;
      }
      const chatEvents = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/events$/);
      if (chatEvents && req.method === "GET") {
        const id = chatEvents[1]!;
        await store.get(id);
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        chatStreams.add(res);
        const listener = (event: any) => { if (event?.sessionId === id) writeSse(res, event); };
        runtime.events.on("event", listener);
        const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": heartbeat\n\n"); }, 15000);
        res.once("close", () => { clearInterval(heartbeat); chatStreams.delete(res); runtime.events.off("event", listener); });
        res.write("event: connected\ndata: {}\n\n");
        return;
      }
      if (url.pathname === "/api/config" && req.method === "GET") {
        return json(res, 200, { roles: ROLES, agents: await entries(), manualFiles: await store.listManualFiles(), runtimeUrl: env.HATCH_FACTORY_RUNTIME_URL ?? "", services: { model: Boolean(env[resolveFactoryLlmProfile(env).apiKeyEnv]?.trim()), search: Boolean(env.FIRECRAWL_API_KEY?.trim()), scrape: Boolean(env.HATCH_FACTORY_SCRAPE_PROVIDER === "firecrawl" ? env.FIRECRAWL_API_KEY : env.TAVILY_API_KEY), hatch: Boolean(env.HATCH_FACTORY_RUNTIME_URL && env.HATCH_FACTORY_CREATOR_TOKEN), corpus: Boolean(env.HATCH_FACTORY_REGISTRY_URL && env.HATCH_FACTORY_CREATOR_TOKEN) } });
      }

      if (url.pathname === "/api/sessions" && req.method === "GET") { const sessions = await store.list(); const manualFiles = await store.listManualFiles(); return json(res, 200, { sessions: sessions.map(s => ({ ...publicSession(s), messages: undefined })), agents: agentEntries(await options.definitions.list(), sessions, manualFiles), manualFiles }); }
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        const b = z.object({ role: z.enum(ROLES), title: z.string().max(200).optional() }).parse(await body(req));
        await assertRoleAvailable(b.role);
        const existing = (await store.list()).find(session => session.role === b.role);
        const session = existing ?? await store.create(b.role, b.title);
        if (!existing) await enqueueFactorySnapshot();
        return json(res, existing ? 200 : 201, publicSession(await store.get(session.id)));
      }
      const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})(?:\/(.*))?$/);
      if (match) {
        const id = match[1]!; const action = match[2] ?? "";
        if (!action && req.method === "GET") { const session = await store.get(id); return json(res, 200, { ...publicSession(session), agent: (await entries()).find(entry => entry.role === session.role), files: await store.contextFiles(id) }); }
        if (action === "prompt" && req.method === "GET") return json(res, 200, { content: await runtime.prompt((await store.get(id)).role) });
        if (action === "message" && req.method === "POST") { const session = await store.get(id); await assertRoleAvailable(session.role); const b = z.object({ content: z.string().min(1).max(100000) }).parse(await body(req)); await runtime.start(id, b.content); return json(res, 202, { accepted: true }); }
        if (action === "stop" && req.method === "POST") { await body(req); runtime.stop(id); return json(res, 202, { requested: true }); }
        if (action === "files" && req.method === "POST") {
          const b = z.object({ path: z.string(), base64: z.string(), mimeType: z.string().optional() }).parse(await body(req));
          const bytes = Buffer.from(b.base64, "base64");
          const converted = b.path.startsWith("input/manual/") ? await convertUpload(path.basename(b.path), bytes) : { name: path.basename(b.path), bytes, mimeType: b.mimeType || "application/octet-stream" };
          const target = b.path.startsWith("input/manual/") ? `input/manual/${converted.name}` : b.path;
          const record = await store.put(id, target, converted.bytes, { actor: "user", mimeType: converted.mimeType });
          runtime.emit(id, "files"); return json(res, 201, record);
        }
        if (action === "files" && req.method === "GET") {
          const data = await store.read(id, url.searchParams.get("path") ?? "");
          if (url.searchParams.get("download") === "1") { res.writeHead(200, { "Content-Type": data.record.mimeType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(data.record.path))}` }); res.end(data.bytes); return; }
          return json(res, 200, { ...data.record, content: /^text\//.test(data.record.mimeType) || /\.(md|txt|json|csv|srt|vtt)$/.test(data.record.path) ? data.bytes.toString("utf8") : null });
        }
        if (action === "files" && req.method === "DELETE") { const b = z.object({ path: z.string() }).parse(await body(req)); await store.removeInput(id, b.path); runtime.emit(id, "files"); return json(res, 200, { removed: true }); }
        if (action === "comments" && req.method === "POST") {
          const b = z.object({ path: z.string(), start: z.number().int(), end: z.number().int(), quote: z.string(), text: z.string().min(1).max(20000), replacement: z.string().max(100000).optional() }).parse(await body(req));
          const comment = await store.comment(id, b); runtime.emit(id, "comments"); return json(res, 201, comment);
        }
        if (action === "comments/export" && req.method === "POST") {
          const b = z.object({ locale: z.enum(["en", "zh", "ja"]).default("en") }).parse(await body(req));
          const s = await store.get(id);
          const text = renderReviewMarkdown(s.comments, b.locale);
          const record = await store.put(id, "output/REVIEW.md", Buffer.from(text), { actor: "user" });
          runtime.emit(id, "files"); return json(res, 200, record);
        }
      }
      return json(res, 404, { error: "Unknown API route" });
    } catch (error) {
      const structured = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; details?: unknown } : undefined;
      const status = typeof structured?.status === "number" ? structured.status : 400;
      const message = safeError(error);
      json(res, status, typeof structured?.code === "string" ? { error: { code: structured.code, message, ...(structured.details === undefined ? {} : { details: structured.details }) }, detail: message } : { error: message });
    }
  };
  return { handle, store, runtime, entries, assertRoleAvailable, setScope: (scope: FactoryProductScope) => { if (scope.creatorId !== options.scope.creatorId || scope.productId !== options.scope.productId) throw new Error("Cannot retarget a Product workspace"); options.scope.briefSpec = scope.briefSpec; }, setCreatorToken: (token: string) => { env.HATCH_FACTORY_CREATOR_TOKEN = token; }, close: async () => { for (const response of streams) response.end(); for (const response of chatStreams) response.end(); await runtime.close(); } };
}

const reviewCopy = {
  en: { title: "Expert review", original: "Original", comment: "Comment", replacement: "Suggested replacement" },
  zh: { title: "专家批注", original: "原文", comment: "意见", replacement: "建议替换" },
  ja: { title: "専門家レビュー", original: "原文", comment: "コメント", replacement: "修正案" }
} as const;

export function renderReviewMarkdown(comments: Comment[], locale: keyof typeof reviewCopy = "en"): string {
  const copy = reviewCopy[locale];
  return `# ${copy.title}\n\n${comments.map(c => `## ${c.path}\n\n${copy.original}:\n\n> ${c.quote.replaceAll("\n", "\n> ")}\n\n${copy.comment}: ${c.text}\n${c.replacement === undefined ? "" : `\n${copy.replacement}:\n\n${c.replacement}\n`}`).join("\n")}`;
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
