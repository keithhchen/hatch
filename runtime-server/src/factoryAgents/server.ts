import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { WorkbenchStore, ROLES, type Comment, type FactoryProductScope, type Session } from "./store.js";
import { WorkbenchRuntime, safeError, type WorkbenchRuntimeOptions } from "./runtime.js";
import { hatchTool } from "./hatchTool.js";
import { corpusTools } from "./corpusTools.js";
import { agentEntries, assertAgentAvailable, type AgentDefinitionRepository } from "./definitions.js";
import { resolveFactoryLlmProfile } from "../llmProfiles.js";
import { VoiceSession, type VoiceServerEvent } from "./voice.js";

export function publicSession(s: Session) { const { context, ...publicData } = s; return publicData; }

export async function createFactoryHandler(options: { root: string; scope: FactoryProductScope; definitions: AgentDefinitionRepository; env?: NodeJS.ProcessEnv; runtime?: WorkbenchRuntimeOptions }) {
  const env: NodeJS.ProcessEnv = { HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash", ...(options.env ?? process.env) };
  const store = new WorkbenchStore(options.root, options.scope, options.definitions);
  await store.recover();
  const runtime = new WorkbenchRuntime(store, { env, ...options.runtime, extraTools: options.runtime?.extraTools ?? (async (s, _signal, changed) => [...corpusTools(store, s.id, changed, options.scope, env), hatchTool(store, s.id, changed, options.scope, env)]) });
  const streams = new Set<ServerResponse>();
  const voices = new Map<string, VoiceSession>();
  const entries = async () => agentEntries(await options.definitions.list(), await store.list());
  const assertRoleAvailable = async (role: Session["role"]) => assertAgentAvailable(await entries(), role);
  const voiceFor = (id: string) => {
    let voice = voices.get(id);
    if (!voice) {
      voice = new VoiceSession({
        emit: (event: VoiceServerEvent) => runtime.events.emit("event", { sessionId: id, ...event }),
        onFinalTranscript: async (_conversationId, content) => { await assertRoleAvailable("voice"); await runtime.start(id, content); },
        onInterrupt: async () => { runtime.stop(id); },
        environment: env
      });
      voices.set(id, voice);
    }
    return voice;
  };
  runtime.events.on("event", (event: any) => {
    const voice = event?.sessionId ? voices.get(event.sessionId) : undefined;
    if (!voice || !event.type?.startsWith("voice.")) return;
    const base = { agent: "interviewer" as const, conversationId: event.sessionId, runId: event.runId || "" };
    if (event.type === "voice.run_started") voice.handleRuntimeEvent({ ...base, type: "run.started" });
    if (event.type === "voice.delta") voice.handleRuntimeEvent({ ...base, type: "assistant.delta", content: event.text || "" });
    if (event.type === "voice.tool") voice.handleRuntimeEvent({ ...base, type: "tool.call" });
    if (event.type === "voice.tool_end") voice.handleRuntimeEvent({ ...base, type: "tool.result" });
    if (event.type === "voice.run_completed") voice.handleRuntimeEvent({ ...base, type: "run.completed" });
    if (event.type === "voice.run_interrupted") voice.handleRuntimeEvent({ ...base, type: "run.interrupted" });
    if (event.type === "voice.run_failed") voice.handleRuntimeEvent({ ...base, type: "run.failed" });
  });
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
      if (url.pathname === "/api/config" && req.method === "GET") return json(res, 200, { roles: ROLES, agents: await entries(), runtimeUrl: env.HATCH_FACTORY_RUNTIME_URL ?? "", services: { model: Boolean(env[resolveFactoryLlmProfile(env).apiKeyEnv]?.trim()), search: Boolean(env.TAVILY_API_KEY), scrape: Boolean(env.HATCH_FACTORY_SCRAPE_PROVIDER === "firecrawl" ? env.FIRECRAWL_API_KEY : env.TAVILY_API_KEY), hatch: Boolean(env.HATCH_FACTORY_RUNTIME_URL && env.HATCH_FACTORY_CREATOR_TOKEN), corpus: Boolean(env.HATCH_FACTORY_REGISTRY_URL && env.HATCH_FACTORY_CREATOR_TOKEN), voice: Boolean(env.ELEVENLABS_API_KEY?.trim() && env.ELEVENLABS_VOICE_ID?.trim()) } });

      if (url.pathname === "/api/sessions" && req.method === "GET") { const sessions = await store.list(); return json(res, 200, { sessions: sessions.map(s => ({ ...publicSession(s), messages: undefined })), agents: agentEntries(await options.definitions.list(), sessions) }); }
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        const b = z.object({ role: z.enum(ROLES), title: z.string().max(200).optional() }).parse(await body(req));
        await assertRoleAvailable(b.role);
        const existing = (await store.list()).find(session => session.role === b.role);
        const session = existing ?? await store.create(b.role, b.title);
        return json(res, existing ? 200 : 201, publicSession(await store.get(session.id)));
      }
      const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})(?:\/(.*))?$/);
      if (match) {
        const id = match[1]!; const action = match[2] ?? "";
        if (!action && req.method === "GET") { const session = await store.get(id); return json(res, 200, { ...publicSession(session), agent: (await entries()).find(entry => entry.role === session.role), files: await store.contextFiles(id) }); }
        if (action === "prompt" && req.method === "GET") return json(res, 200, { content: await runtime.prompt((await store.get(id)).role) });
        if (action === "message" && req.method === "POST") { const session = await store.get(id); await assertRoleAvailable(session.role); const b = z.object({ content: z.string().min(1).max(100000) }).parse(await body(req)); await runtime.start(id, b.content); return json(res, 202, { accepted: true }); }
        if (action === "stop" && req.method === "POST") { await body(req); runtime.stop(id); return json(res, 202, { requested: true }); }
        if (action === "voice/start" && req.method === "POST") { const s = await store.get(id); if (s.role !== "voice") throw new Error("Voice is only available in the Voice Agent"); await assertRoleAvailable(s.role); await body(req); await voiceFor(id).start(id); return json(res, 200, { started: true }); }
        if (action === "voice/audio" && req.method === "POST") { const b = z.object({ base64: z.string().min(1) }).parse(await body(req)); voiceFor(id).audio(Buffer.from(b.base64, "base64")); return json(res, 202, { accepted: true }); }
        if (action === "voice/stop" && req.method === "POST") { await body(req); await voices.get(id)?.stop(); voices.delete(id); return json(res, 200, { stopped: true }); }
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
  return { handle, store, runtime, setScope: (scope: FactoryProductScope) => { if (scope.creatorId !== options.scope.creatorId || scope.productId !== options.scope.productId) throw new Error("Cannot retarget a Product workspace"); options.scope.briefSpec = scope.briefSpec; }, setCreatorToken: (token: string) => { env.HATCH_FACTORY_CREATOR_TOKEN = token; }, close: async () => { for (const response of streams) response.end(); await runtime.close(); } };
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
