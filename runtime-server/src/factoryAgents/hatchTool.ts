import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../protocol.js";
import { WorkbenchStore, type TargetBinding } from "./store.js";
import { result, digest } from "./files.js";

type DesktopClient = {
  createConversation(url: string, token: string, binding: { entitlementId?: string; productId?: string }, input: Record<string, unknown>, fetchImpl?: typeof fetch): Promise<{ conversation: { id: string } }>;
  getConversationSnapshot(url: string, token: string, binding: { entitlementId?: string; productId?: string }, id: string, afterCursor?: number, fetchImpl?: typeof fetch): Promise<Record<string, unknown>>;
  getConversationSubmission(url: string, token: string, binding: { entitlementId?: string; productId?: string }, id: string, runId: string, fetchImpl?: typeof fetch): Promise<{ run: Record<string, unknown> | null; submission: unknown }>;
  getConversationAsset(url: string, token: string, binding: { entitlementId?: string; productId?: string }, id: string, assetId: string, fetchImpl?: typeof fetch): Promise<string>;
  getConversationRun(url: string, token: string, binding: { entitlementId?: string; productId?: string }, id: string, runId: string, fetchImpl?: typeof fetch): Promise<Record<string, unknown>>;
  getConversationToolDetail(url: string, token: string, binding: { entitlementId?: string; productId?: string }, id: string, detail: { run_id: string; tool_call_id: string }, fetchImpl?: typeof fetch): Promise<Record<string, unknown>>;
};

/** Reuse Desktop's actual REST client. Only the headless WebSocket transport differs; no target Agent loop is implemented here. */
async function desktopClient(): Promise<DesktopClient> {
  const moduleUrl = new URL("../../../desktop-app/src/renderer/conversation-client.js", import.meta.url);
  return import(moduleUrl.href);
}

export function hatchTool(store: WorkbenchStore, id: string, changed: () => void, env: NodeJS.ProcessEnv = process.env): AgentTool {
  return {
    name: "hatch_tool", label: "运行 Hatch Agent", description: "Call the existing authenticated Hatch server Runtime, with NO LocalRunner/local tools. Host fixes the target Agent. start/continue send only client-visible text/materials. status/read/tool_detail inspect the real conversation; read_asset downloads a real referenced output asset for inspection. No rubric or private client-state files may be sent. Runtime output is saved read-only as RESULT.md/results/*.md. Never retry a pending submission without inspecting status.",
    parameters: Type.Object({ operation: Type.Union([Type.Literal("start"), Type.Literal("continue"), Type.Literal("status"), Type.Literal("read"), Type.Literal("tool_detail"), Type.Literal("read_asset"), Type.Literal("cancel")]), message: Type.Optional(Type.String({ maxLength: 100000, description: "Required for start and continue: the actual customer message. brief_answers and material_paths do not replace this message." })), material_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })), brief_answers: Type.Optional(Type.Array(Type.Object({ field_id: Type.String(), value: Type.String() }))), asset_id: Type.Optional(Type.String()), tool_call_id: Type.Optional(Type.String()) }),
    execute: async (_callId, raw, signal) => {
      const args = raw as { operation: string; message?: string; material_paths?: string[]; tool_call_id?: string; asset_id?: string; brief_answers?: Array<{ field_id: string; value: string }> };
      const session = await store.get(id);
      const target = session.target;
      const token = target?.entitlementId ? env.HATCH_FACTORY_AUTH_TOKEN : env.HATCH_FACTORY_CREATOR_TOKEN;
      if (!target || !token) throw new Error("HTool unavailable: configure the real Runtime target Agent and HATCH_FACTORY_AUTH_TOKEN. No substitute runner is used.");
      const configuredUrl = env.HATCH_FACTORY_RUNTIME_URL;
      if (!configuredUrl || target.runtimeUrl !== configuredUrl) throw new Error("Runtime URL must match the host-configured HATCH_FACTORY_RUNTIME_URL");
      const url = new URL(target.runtimeUrl);
      if (!(["https:", "wss:"].includes(url.protocol) || (["http:", "ws:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) || url.username || url.password) throw new Error("Runtime requires TLS or a loopback endpoint");
      const client = await desktopClient();
      const request: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
      const binding = target.entitlementId ? { entitlementId: target.entitlementId } : { productId: target.productId };
      const desktopUrl = socketUrl(target.runtimeUrl);
      if (["status", "read", "tool_detail"].includes(args.operation)) {
        if (!session.hatch) throw new Error("No real Hatch conversation has been started");
        const h = session.hatch;
        if (args.operation === "tool_detail") {
          if (!h.lastRunId || !args.tool_call_id) throw new Error("Run and tool call ID are required");
          return result(await client.getConversationToolDetail(desktopUrl, token, binding, h.conversationId, { run_id: h.lastRunId, tool_call_id: args.tool_call_id }, request));
        }
        if (args.operation === "status" && h.lastRunId) {
          const value = await client.getConversationSubmission(desktopUrl, token, binding, h.conversationId, h.lastRunId, request);
          const terminal = !value.run && !value.submission || ["completed", "failed", "cancelled", "interrupted"].includes(String(value.run?.status));
          if (terminal) await store.update(id, s => { if (s.hatch && s.hatch.lastRunId === h.lastRunId) s.hatch.pending = false; });
          return result(value);
        }
        const value = await client.getConversationSnapshot(desktopUrl, token, binding, h.conversationId, 0, request);
        return result(value);
      }
      if (args.operation === "read_asset") {
        if (!session.hatch || !args.asset_id) throw new Error("A real conversation and referenced asset_id are required");
        let mime = "application/octet-stream";
        const encoded = await client.getConversationAsset(desktopUrl, token, binding, session.hatch.conversationId, args.asset_id, async (input, init) => {
          const response = await fetch(input, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
          mime = response.headers.get("content-type")?.split(";")[0] ?? mime;
          if (Number(response.headers.get("content-length") ?? 0) > 20 * 1024 * 1024) throw new Error("Runtime asset exceeds workspace file limit");
          return response;
        });
        const bytes = Buffer.from(encoded, "base64");
        const markdown = ["text/markdown", "text/plain"].includes(mime);
        const record = await store.put(id, `output/results/asset-${digest(args.asset_id).slice(7, 23)}.${markdown ? "md" : "bin"}`, bytes, { actor: "host", readonly: true, mimeType: mime });
        if (markdown) await store.put(id, "output/RESULT.md", bytes, { actor: "host", readonly: true, mimeType: mime, origin: { sessionId: id, path: record.path } });
        changed(); return result(record);
      }
      if (args.operation === "cancel") {
        if (!session.hatch?.lastRunId) throw new Error("No target run to cancel");
        await cancelTarget(target, token, session.hatch.conversationId, session.hatch.lastRunId, signal);
        return result("Cancellation requested through Hatch Runtime; inspect status to confirm.");
      }
      if (!args.message?.trim()) throw new Error("start/continue require message: the actual customer request or reply. brief_answers and material_paths do not replace it.");
      if (session.hatch?.pending) throw new Error("Previous target submission is pending or uncertain; inspect status before continuing");
      if (args.operation === "start" && session.hatch) throw new Error("This evaluation already has a real conversation; use continue or create a new evaluation workspace for another attempt");
      if (args.operation === "continue" && !session.hatch) throw new Error("Start the target conversation first");
      let message = args.message;
      for (const material of args.material_paths ?? []) {
        if (!material.startsWith("input/") || /(?:CLIENT_STATE|RUBRIC)\.md$/i.test(material) || /\/(private|sealed)\//i.test(material)) throw new Error("Only explicitly selected public client input files may enter the target context");
        const { bytes } = await store.read(id, material);
        if (!/\.(md|txt)$/i.test(material)) throw new Error("HTool currently accepts text client materials; no local file extensions are registered");
        message += `\n\n--- Client material: ${material} ---\n${bytes.toString("utf8")}`;
      }
      if (Buffer.byteLength(message) > 400000) throw new Error("Client materials exceed one message budget");
      let conversationId = session.hatch?.conversationId;
      if (!conversationId) {
        const response = await client.createConversation(desktopUrl, token, binding, { clientRequestId: `factory-${id}`, title: `Factory evaluation ${session.title}`, briefAnswers: args.brief_answers ?? target.briefAnswers ?? [] }, request);
        if (!response.conversation?.id) throw new Error("Runtime did not return a real conversation ID");
        conversationId = response.conversation.id;
        await store.update(id, s => { s.hatch = { conversationId: conversationId! }; });
      }
      const runId = randomUUID();
      await store.update(id, s => { s.hatch = { conversationId: conversationId!, lastRunId: runId, pending: true }; });
      const events: unknown[] = [];
      let output = "";
      let submitted = false;
      try {
        await runTarget(target, token, conversationId, runId, message, signal, event => {
          events.push(event);
          if (event.type === "assistant.delta" && event.run_id === runId && event.delta?.kind === "text") output += event.delta.content;
          if (Buffer.byteLength(output) > 4 * 1024 * 1024 || events.length > 20000) throw new Error("Target trace limit reached");
        }, () => { submitted = true; });
        if (output.trim()) {
          await store.put(id, `output/results/${runId}.md`, Buffer.from(output), { actor: "host", readonly: true });
          await store.put(id, "output/RESULT.md", Buffer.from(output), { actor: "host", readonly: true, origin: { sessionId: id, path: `output/results/${runId}.md` } });
        }
        await store.update(id, s => { if (s.hatch?.lastRunId === runId) s.hatch.pending = false; });
        changed();
        return result({ conversationId, runId, result_path: output.trim() ? "output/RESULT.md" : null, local_tools: [], output, note: "Use read/tool_detail to inspect referenced output assets, then read_asset to download their actual bytes before evaluating." });
      } catch (error) {
        if (!submitted) await store.update(id, s => { if (s.hatch && s.hatch.lastRunId === runId) s.hatch.pending = false; });
        throw error;
      } finally {
        const trace = `# Hatch Runtime trace\n\nConversation: ${conversationId}\nRun: ${runId}\nLocal tools: none\n\nclient.message records the outbound customer message; Runtime events establish acceptance and completion.\n\n\`\`\`json\n${JSON.stringify(events, null, 2)}\n\`\`\`\n`;
        await store.put(id, `output/results/${runId}-trace.md`, Buffer.from(trace), { actor: "host", readonly: true });
        if (output && !(await store.get(id)).files.some(f => f.path === `output/results/${runId}.md`)) await store.put(id, `output/results/${runId}-partial.md`, Buffer.from(output), { actor: "host", readonly: true });
        changed();
      }
    }
  };
}

function socketUrl(value: string): string { const u = new URL(value); u.protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol; if (u.pathname === "/") u.pathname = "/runtime"; u.search = ""; return u.href; }
function connect(target: TargetBinding, token: string, conversationId: string): WebSocket {
  const ws = new WebSocket(socketUrl(target.runtimeUrl), { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 20000 });
  ws.once("open", () => ws.send(JSON.stringify({ type: "client.hello", protocol_version: PROTOCOL_VERSION, conversation_id: conversationId, auth_token: token, ...(target.entitlementId ? { entitlement_id: target.entitlementId } : { product_id: target.productId }), local_tools: [] })));
  return ws;
}
function verifyReady(event: Record<string, any>, target: TargetBinding, conversationId: string): void {
  if (event.accepted_protocol_version !== PROTOCOL_VERSION || event.creator_id !== target.creatorId || event.product_id !== target.productId || event.conversation_id !== conversationId) throw new Error("Hatch Runtime bound a different Agent or conversation; target was not executed");
}
async function runTarget(target: TargetBinding, token: string, conversationId: string, runId: string, message: string, signal: AbortSignal | undefined, observe: (event: Record<string, any>) => void, submitting: () => void): Promise<void> {
  const ws = connect(target, token, conversationId);
  let sent = false;
  try {
    await new Promise<void>((resolve, reject) => {
      let completed = false; let terminal = false;
      const fail = (error: unknown) => reject(error);
      const abort = () => { if (sent && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "turn.cancel", run_id: runId, reason: "Factory evaluation cancelled" })); fail(signal?.reason ?? new Error("Cancelled")); };
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => { if (sent && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "turn.cancel", run_id: runId, reason: "Factory evaluation deadline" })); fail(new Error("Target Runtime timeout; inspect status before retrying")); }, 900000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      ws.once("close", () => { cleanup(); if (!completed || !terminal) fail(new Error("Target connection closed; submission status may be uncertain")); });
      ws.once("error", fail);
      ws.on("message", data => {
        try {
          const event = JSON.parse(String(data));
          observe(event);
          if (event.type === "session.ready") {
            verifyReady(event, target, conversationId);
            if (sent) throw new Error("Duplicate session.ready");
            sent = true;
            submitting();
            const request = { type: "client.message", run_id: runId, client_message_id: runId, conversation_id: conversationId, message: { role: "user", content: message } };
            ws.send(JSON.stringify(request));
            observe(request);
          } else if (event.type === "tool_call.request") throw new Error("Runtime requested a local extension despite local_tools=[]; no local executor exists");
          else if (event.type === "turn.failed" && (!event.run_id || event.run_id === runId)) throw new Error(`Target failed: ${event.error?.code ?? "unknown"}`);
          else if (event.run_id === runId && event.type === "turn.completed") { if (event.finish_reason !== "stop") throw new Error(`Target finish: ${event.finish_reason}`); completed = true; }
          else if (event.run_id === runId && event.type === "turn.state") { if (event.status === "completed") terminal = true; else if (["failed", "cancelled", "interrupted"].includes(event.status)) throw new Error(`Target ${event.status}`); }
          if (completed && terminal) { cleanup(); resolve(); }
        } catch (error) { cleanup(); fail(error); }
      });
      if (signal?.aborted) abort();
    });
  } finally { ws.close(); setTimeout(() => ws.terminate(), 1000).unref(); }
}
async function cancelTarget(target: TargetBinding, token: string, conversationId: string, runId: string, signal?: AbortSignal): Promise<void> {
  const ws = connect(target, token, conversationId);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Cancel connection timeout")), 20000);
      ws.once("error", reject);
      ws.on("message", data => { try { const e = JSON.parse(String(data)); if (e.type === "session.ready") { verifyReady(e, target, conversationId); ws.send(JSON.stringify({ type: "turn.cancel", run_id: runId, reason: "Evaluator requested cancellation" }), error => error ? reject(error) : resolve()); clearTimeout(timer); } } catch (error) { clearTimeout(timer); reject(error); } });
      if (signal?.aborted) { clearTimeout(timer); reject(signal.reason); }
      ws.once("close", () => { clearTimeout(timer); reject(new Error("Cancel connection closed")); });
    });
  } finally { ws.close(); setTimeout(() => ws.terminate(), 1000).unref(); }
}
