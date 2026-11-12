import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { WorkbenchStore, type FactoryProductScope } from "./store.js";
import { result, digest } from "./files.js";

const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

/** The Runtime's Conversation HTTP API, scoped to the host Product. Redirects are refused; errors carry the HTTP status. */
function runtimeHttp(runtimeUrl: string, token: string, productId: string, signal: AbortSignal | undefined) {
  const base = new URL(runtimeUrl);
  base.protocol = base.protocol === "wss:" ? "https:" : base.protocol === "ws:" ? "http:" : base.protocol;
  base.search = ""; base.hash = "";
  const send = async (method: string, path: string, query: Record<string, string> = {}, body?: unknown, timeoutMs = 60000): Promise<Response> => {
    const url = new URL(base); url.pathname = path; url.searchParams.set("product_id", productId);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
      throw Object.assign(new Error(payload.error?.message || `Runtime request failed (${response.status})`), { status: response.status, code: payload.error?.code });
    }
    return response;
  };
  return { send, json: async (...args: Parameters<typeof send>) => await (await send(...args)).json() as Record<string, any> };
}

export function hatchTool(store: WorkbenchStore, id: string, changed: () => void, scope: FactoryProductScope, env: NodeJS.ProcessEnv = process.env): AgentTool {
  const product = Object.freeze({ creatorId: scope.creatorId, productId: scope.productId });
  return {
    name: "hatch_tool", label: "运行 Hatch Agent", description: "Call the existing authenticated Hatch server Runtime, with NO LocalRunner/local tools. Host fixes the target Agent. start/continue send only client-visible text/materials. status/read/tool_detail inspect the real conversation; read_asset downloads a real referenced output asset for inspection. No rubric or private client-state files may be sent. Runtime output is saved read-only as RESULT.md/results/*.md. Never retry a pending submission without inspecting status.",
    parameters: Type.Object({ operation: Type.Union([Type.Literal("start"), Type.Literal("continue"), Type.Literal("status"), Type.Literal("read"), Type.Literal("tool_detail"), Type.Literal("read_asset"), Type.Literal("cancel")]), message: Type.Optional(Type.String({ maxLength: 100000, description: "Required for start and continue: the actual customer message. brief_answers and material_paths do not replace this message." })), material_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })), brief_answers: Type.Optional(Type.Array(Type.Object({ field_id: Type.String(), value: Type.String() }))), asset_id: Type.Optional(Type.String()), tool_call_id: Type.Optional(Type.String()) }),
    execute: async (callId, raw, signal) => {
      const args = raw as { operation: string; message?: string; material_paths?: string[]; tool_call_id?: string; asset_id?: string; brief_answers?: Array<{ field_id: string; value: string }> };
      const session = await store.get(id);
      const configuredUrl = env.HATCH_FACTORY_RUNTIME_URL;
      const token = env.HATCH_FACTORY_CREATOR_TOKEN;
      if (!configuredUrl || !token) throw new Error("HTool unavailable: configure the real Runtime and Creator authentication. No substitute runner is used.");
      const url = new URL(configuredUrl);
      if (!(["https:", "wss:"].includes(url.protocol) || (["http:", "ws:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) || url.username || url.password) throw new Error("Runtime requires TLS or a loopback endpoint");
      const http = runtimeHttp(configuredUrl, token, product.productId, signal);
      const conversation = (conversationId: string, suffix = "") => `/v1/conversations/${encodeURIComponent(conversationId)}${suffix}`;
      if (["status", "read", "tool_detail"].includes(args.operation)) {
        if (!session.hatch) throw new Error("No real Hatch conversation has been started");
        const h = session.hatch;
        if (args.operation === "tool_detail") {
          if (!h.lastRunId || !args.tool_call_id) throw new Error("Run and tool call ID are required");
          return result((await http.json("GET", conversation(h.conversationId, `/tools/${encodeURIComponent(h.lastRunId)}/${encodeURIComponent(args.tool_call_id)}`))).tool);
        }
        if (args.operation === "status" && h.lastRunId) {
          const value = await http.json("GET", conversation(h.conversationId, `/runs/${encodeURIComponent(h.lastRunId)}`)).catch(error => { if (error.status === 404 && error.code === "run_not_found") return { run: null, submission: null }; throw error; });
          const terminal = !value.run && !value.submission || TERMINAL.includes(String(value.run?.status));
          if (terminal) await store.update(id, s => { if (s.hatch && s.hatch.lastRunId === h.lastRunId) s.hatch.pending = false; });
          return result(value);
        }
        return result(await http.json("GET", conversation(h.conversationId, "/snapshot"), { view: "page" }));
      }
      if (args.operation === "read_asset") {
        if (!session.hatch || !args.asset_id) throw new Error("A real conversation and referenced asset_id are required");
        const response = await http.send("GET", conversation(session.hatch.conversationId, `/assets/${encodeURIComponent(args.asset_id)}`));
        const mime = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
        if (Number(response.headers.get("content-length") ?? 0) > 20 * 1024 * 1024) throw new Error("Runtime asset exceeds workspace file limit");
        const bytes = Buffer.from(await response.arrayBuffer());
        const markdown = ["text/markdown", "text/plain"].includes(mime);
        const record = await store.put(id, `output/results/asset-${digest(args.asset_id).slice(7, 23)}.${markdown ? "md" : "bin"}`, bytes, { actor: "host", readonly: true, mimeType: mime });
        if (markdown) await store.put(id, "output/RESULT.md", bytes, { actor: "host", readonly: true, mimeType: mime, origin: { sessionId: id, path: record.path } });
        changed(); return result(record);
      }
      if (args.operation === "cancel") {
        if (!session.hatch?.lastRunId) throw new Error("No target run to cancel");
        await http.json("POST", conversation(session.hatch.conversationId, `/runs/${encodeURIComponent(session.hatch.lastRunId)}/cancel`), {}, { reason: "Evaluator requested cancellation" });
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
        const response = await http.json("POST", "/v1/conversations", {}, { client_request_id: `factory-${id}`, title: `Factory evaluation ${session.title}`, brief_answers: args.brief_answers ?? [] });
        if (!response.conversation?.id) throw new Error("Runtime did not return a real conversation ID");
        conversationId = response.conversation.id as string;
        await store.update(id, s => { s.hatch = { conversationId: conversationId! }; });
      }
      // The same tool call always sends the same message ID, so a retried call replays the Run instead of duplicating it.
      const clientMessageId = `factory-${id}-${callId}`;
      const request = { client_message_id: clientMessageId, content: message };
      await store.update(id, s => { s.hatch = { conversationId: conversationId!, pending: true }; });
      let runId: string | undefined;
      let output = "";
      const events: unknown[] = [{ type: "client.message", conversation_id: conversationId, ...request, message: { role: "user", content: message } }];
      try {
        const deadline = Date.now() + 900000;
        for (;;) {
          const body = await http.json("POST", conversation(conversationId, "/messages"), { wait: "60" }, request, 90000);
          events.push(body);
          runId = body.run?.id ?? body.run_id;
          if (runId) await store.update(id, s => { if (s.hatch) s.hatch.lastRunId = runId; });
          const status = String(body.run?.status ?? body.status);
          if (TERMINAL.includes(status)) {
            if (status !== "completed") throw new Error(`Target ${status}`);
            output = String(body.reply ?? "");
            break;
          }
          if (Date.now() >= deadline) throw new Error("Target Runtime timeout; inspect status before retrying");
        }
        if (Buffer.byteLength(output) > 4 * 1024 * 1024) throw new Error("Target trace limit reached");
        if (output.trim()) {
          await store.put(id, `output/results/${runId}.md`, Buffer.from(output), { actor: "host", readonly: true });
          await store.put(id, "output/RESULT.md", Buffer.from(output), { actor: "host", readonly: true, origin: { sessionId: id, path: `output/results/${runId}.md` } });
        }
        await store.update(id, s => { if (s.hatch && s.hatch.lastRunId === runId) s.hatch.pending = false; });
        changed();
        return result({ conversationId, runId, result_path: output.trim() ? "output/RESULT.md" : null, local_tools: [], output, note: "Use read/tool_detail to inspect referenced output assets, then read_asset to download their actual bytes before evaluating." });
      } catch (error) {
        // A refusal by the Runtime means nothing was accepted; a dropped connection or timeout leaves the submission uncertain.
        if ((error as { status?: number }).status) await store.update(id, s => { if (s.hatch) s.hatch.pending = false; });
        throw error;
      } finally {
        const trace = `# Hatch Runtime trace\n\nConversation: ${conversationId}\nRun: ${runId ?? "unassigned"}\nLocal tools: none\n\nclient.message records the outbound customer message; Runtime responses establish acceptance and completion.\n\n\`\`\`json\n${JSON.stringify(events, null, 2)}\n\`\`\`\n`;
        await store.put(id, `output/results/${runId ?? clientMessageId}-trace.md`, Buffer.from(trace), { actor: "host", readonly: true });
        changed();
      }
    }
  };
}
