import "dotenv/config";

import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { ZodError } from "zod";
import { ClientToolBroker } from "./clientBroker.js";
import {
  compactRuntimeMessages,
  shouldAutoCompactMessages,
  type CompactionCheckpoint,
  type RuntimeCompactionMessage
} from "./compaction.js";
import { createAgentRuntime, type AgentRuntime, type RuntimeSessionSkills } from "./agentRuntime.js";
import { parseInboundMessage, PROTOCOL_VERSION, type ClientHello, type OutboundMessage, type RunStart } from "./protocol.js";
import { loadProjectInstructions } from "./projectDocs.js";
import { RunStateMachine } from "./runState.js";
import { ServerToolExecutor } from "./serverTools.js";
import { RuntimeStore, type ActivatedSkill, type RunStatus } from "./store.js";
import {
  discoverSkills,
  explicitSkillReferences,
  explicitSkillReferenceMatches,
  includeSkillInstructions,
  listSkillBundleResourcePaths,
  parseSkillMarkdown,
  readSkillResourceByPath,
  renderSkillsSection,
  skillResourceRoots,
  visibleSkillsForSession
} from "./skills.js";

export type RuntimeServer = {
  server: http.Server;
  wss: WebSocketServer;
  close: () => Promise<void>;
};

export type RuntimeServerOptions = {
  createRuntime?: () => AgentRuntime;
};

export function createRuntimeServer(options: RuntimeServerOptions = {}): RuntimeServer {
  const activeConversationRuns = new Map<string, string>();
  const connectionTasks = new Set<Promise<void>>();
  const createRuntime = options.createRuntime ?? createAgentRuntime;
  const server = http.createServer((req, res) => {
    void handleHttpRequest(req, res);
  });

  const wss = new WebSocketServer({ server, path: "/runtime" });
  wss.on("connection", (socket) => {
    const task = handleRuntimeSocket(socket, activeConversationRuns, createRuntime);
    connectionTasks.add(task);
    task.finally(() => connectionTasks.delete(task));
  });

  return {
    server,
    wss,
    close: async () => {
      for (const client of wss.clients) {
        client.close();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await Promise.allSettled([...connectionTasks]);
    }
  };
}

async function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/healthz") {
    writeJson(res, 200, { ok: true });
    return;
  }

  const match = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
  if (req.method === "GET" && match) {
    const conversationId = decodeURIComponent(match[1] ?? "");
    const store = new RuntimeStore();
    writeJson(res, 200, {
      conversation_id: conversationId,
      messages: await store.readVisibleConversation(conversationId)
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function releaseConversationRun(
  activeConversationRuns: Map<string, string>,
  conversationId: string,
  runId: string
): void {
  if (activeConversationRuns.get(conversationId) === runId) {
    activeConversationRuns.delete(conversationId);
  }
}

async function handleRuntimeSocket(
  socket: WebSocket,
  activeConversationRuns: Map<string, string>,
  createRuntime: () => AgentRuntime
): Promise<void> {
  let hello: ClientHello | undefined;
  let sessionSkills: RuntimeSessionSkills | undefined;
  const store = new RuntimeStore();
  const serverTools = new ServerToolExecutor();
  const runtime = createRuntime();
  const activeRuns = new Set<Promise<void>>();
  const activeRunStates = new Map<string, RunStateMachine>();

  const send = async (message: OutboundMessage): Promise<void> => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
    const conversationId = "run_id" in message && message.run_id
      ? activeRunStates.get(message.run_id)?.conversationId
      : undefined;
    await store.append({
      type: "runtime.event",
      conversation_id: conversationId,
      run_id: "run_id" in message ? message.run_id : undefined,
      event: message
    });
  };
  const broker = new ClientToolBroker(send, store);

  socket.on("message", (data) => {
    void (async () => {
      try {
        const message = parseInboundMessage(JSON.parse(String(data)));

        if (message.type === "client.hello") {
          if (hello) {
            await send({
              type: "turn.failed",
              error: {
                code: "duplicate_hello",
                message: "client.hello can only be sent once per runtime connection"
              }
            });
            return;
          }
          hello = message;
          sessionSkills = await buildSessionSkills(message.workspace_root);
          await store.append({
            type: "session.started",
            installation_id: message.installation_id,
            client_version: message.client_version,
            workspace_root: message.workspace_root,
            local_tools: message.local_tools
          });
          await send({
            type: "session.ready",
            accepted_protocol_version: PROTOCOL_VERSION
          });
          return;
        }

        if (!hello) {
          await send({
            type: "turn.failed",
            error: {
              code: "hello_required",
              message: "client.hello must be sent before run messages"
            }
          });
          return;
        }

        if (message.type === "tool_call.result") {
          if (!await broker.handleResult(message)) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "unknown_tool_call",
                message: `No pending tool request for ${message.tool_call_id}`
              }
            });
          }
          return;
        }

        if (message.type === "turn.cancel") {
          const state = activeRunStates.get(message.run_id);
          if (!state) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "unknown_run",
                message: `No active run for ${message.run_id}`
              }
            });
            return;
          }
          await state.cancel(message.reason ?? "Run canceled").catch(() => undefined);
          await broker.cancelRun(message.run_id, message.reason ?? "Run canceled");
          await send({
            type: "turn.failed",
            run_id: message.run_id,
            error: {
              code: "run_cancelled",
              message: message.reason ?? "Run canceled"
            }
          });
          return;
        }

        if (message.type === "client.message") {
          if (!sessionSkills) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "session_not_ready",
                message: "session skills were not initialized"
              }
            });
            return;
          }
          const activeRunId = activeConversationRuns.get(message.conversation_id);
          if (activeRunId) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "conversation_busy",
                message: `Conversation ${message.conversation_id} already has an active run: ${activeRunId}`
              }
            });
            return;
          }

          activeConversationRuns.set(message.conversation_id, message.run_id);
          const state = new RunStateMachine(message.run_id, message.conversation_id, store, async (status, reason) => {
            if (isTerminalRunStatus(status)) {
              releaseConversationRun(activeConversationRuns, message.conversation_id, message.run_id);
            }
            await send({
              type: "turn.state",
              run_id: message.run_id,
              status,
              reason
            });
          });
          activeRunStates.set(message.run_id, state);
          await state.queued();
          const task = runOneTurn(message, hello, sessionSkills, broker, serverTools, runtime, store, state, send);
          activeRuns.add(task);
          task.finally(() => {
            activeRuns.delete(task);
            activeRunStates.delete(message.run_id);
            releaseConversationRun(activeConversationRuns, message.conversation_id, message.run_id);
          });
        }
      } catch (error) {
        await send({
          type: "turn.failed",
          error: {
            code: "protocol_error",
            message: errorMessage(error)
          }
        });
      }
    })();
  });

  return new Promise<void>((resolve) => {
    socket.once("close", () => {
      void (async () => {
        const reason = "Client disconnected";
        const states = [...activeRunStates.values()];
        for (const state of states) {
          releaseConversationRun(activeConversationRuns, state.conversationId, state.runId);
        }
        await Promise.all(states.map((state) => state.cancel(reason).catch(() => undefined)));
        await broker.cancelAll(reason);
        await Promise.allSettled([...activeRuns]);
        resolve();
      })();
    });
  });
}

async function runOneTurn(
  input: RunStart,
  hello: ClientHello,
  sessionSkills: RuntimeSessionSkills,
  broker: ClientToolBroker,
  serverTools: ServerToolExecutor,
  runtime: AgentRuntime,
  store: RuntimeStore,
  state: RunStateMachine,
  send: (message: OutboundMessage) => Promise<void>
): Promise<void> {
  try {
    await state.start();
    let priorMessages = await store.readConversation(input.conversation_id);
    if (input.message.content.trim() === "/compact") {
      await compactAndEmit(input, store, state, send, priorMessages, {
        trigger: "manual",
        phase: "standalone_turn",
        reason: "user_requested"
      });
      await send({
        type: "turn.completed",
        run_id: input.run_id,
        output: [{
          type: "message",
          content: "Compaction complete."
        }],
        usage: {
          input_tokens: 0,
          output_tokens: 0
        }
      });
      await state.complete();
      return;
    }

    const preTurnCompaction = await compactIfNeeded(input, store, state, send, priorMessages, "pre_turn");
    if (preTurnCompaction) {
      priorMessages = preTurnCompaction.replacement_history;
    }

    const activatedSkills = await activateExplicitlyMentionedSkills(input, sessionSkills.records);
    for (const activation of activatedSkills) {
      await store.append({
        type: "skill.activated",
        conversation_id: input.conversation_id,
        run_id: input.run_id,
        name: activation.name,
        path: activation.path,
        scope: activation.scope,
        directory: activation.directory,
        content: activation.content,
        allowed_tools: activation.allowed_tools,
        resource_paths: activation.resource_paths,
        resource_manifest_truncated: activation.resource_manifest_truncated,
        timestamp: activation.activated_at
      });
      await send(skillActivatedEvent(input.run_id, activation));
    }
    await store.append({
      type: "message.created",
      conversation_id: input.conversation_id,
      run_id: input.run_id,
      role: input.message.role,
      content: input.message.content
    });
    const messages = [...priorMessages, input.message];

    for await (const event of runtime.run(input, {
      clientBroker: broker,
      serverTools,
      state,
      messages,
      sessionSkills,
      activatedSkills,
      clientTools: hello.local_tools,
      workspaceRoot: hello.workspace_root,
      persistModelMessage: async (message) => {
        await store.append({
          type: "conversation.model_message",
          conversation_id: input.conversation_id,
          run_id: input.run_id,
          message
        });
      },
      compactMessagesIfNeeded: async (runtimeMessages: RuntimeCompactionMessage[], phase) => {
        const compacted = await compactIfNeeded(input, store, state, send, runtimeMessages, phase);
        return compacted?.replacement_history;
      }
    })) {
      if (state.status === "cancelled") {
        break;
      }
      await persistServerToolCallEvent(event, input, store);
      await persistSkillEvent(event, input, store);
      const activation = await skillActivationFromToolEvent(event);
      if (activation) {
        await store.append({
          type: "skill.activated",
          conversation_id: input.conversation_id,
          run_id: input.run_id,
          ...activation
        });
      }
      if (event.type === "turn.completed") {
        await store.append({
          type: "message.created",
          conversation_id: input.conversation_id,
          run_id: input.run_id,
          role: "assistant",
          content: event.output.map((item) => item.content).join("\n")
        });
        await send(event);
        await state.complete();
        continue;
      }
      await send(event);
    }
  } catch (error) {
    if (state.status === "cancelled") {
      return;
    }
    await state.fail(errorMessage(error)).catch(() => undefined);
    await send({
      type: "turn.failed",
      run_id: input.run_id,
      error: {
        code: "run_failed",
        message: errorMessage(error)
      }
    });
  }
}

async function buildSessionSkills(workspaceRoot?: string): Promise<RuntimeSessionSkills> {
  const records = await discoverSkills({ workspaceRoot });
  const visibleRecords = visibleSkillsForSession(records);
  const rendered = await includeSkillInstructions()
    ? renderSkillsSection(visibleRecords)
    : emptyRenderedSkills();
  const projectInstructions = await loadProjectInstructions(workspaceRoot);
  return {
    records,
    visibleRecords,
    rendered,
    ...(projectInstructions ? { projectInstructions } : {})
  };
}

function emptyRenderedSkills(): ReturnType<typeof renderSkillsSection> {
  return {
    section: "",
    aliases: {},
    report: {
      total_count: 0,
      included_count: 0,
      omitted_count: 0,
      truncated_description_chars: 0,
      truncated_description_count: 0
    }
  };
}

async function persistSkillEvent(
  event: OutboundMessage,
  input: RunStart,
  store: RuntimeStore
): Promise<void> {
  if (event.type !== "skill.invoked") {
    return;
  }
  await store.append({
    type: "skill.invoked",
    conversation_id: input.conversation_id,
    run_id: input.run_id,
    name: event.name,
    path: event.path,
    scope: event.scope,
    invocation_type: event.invocation_type,
    reason: event.reason,
    source_tool_call_id: event.source_tool_call_id,
    trigger: event.trigger
  });
}

async function persistServerToolCallEvent(
  event: OutboundMessage,
  input: RunStart,
  store: RuntimeStore
): Promise<void> {
  if (event.type !== "tool_call.delta" || event.locality !== "server") {
    return;
  }
  await store.append({
    type: "tool.call",
    conversation_id: input.conversation_id,
    run_id: input.run_id,
    tool_call_id: event.tool_call_id,
    name: event.name,
    arguments: event.arguments ?? {},
    status: event.status,
    locality: event.locality,
    approval: event.approval,
    ...(event.result ? { result: event.result } : {}),
    ...(event.error ? { error: event.error } : {})
  });
}

async function compactIfNeeded(
  input: RunStart,
  store: RuntimeStore,
  state: RunStateMachine,
  send: (message: OutboundMessage) => Promise<void>,
  messages: RuntimeCompactionMessage[],
  phase: "pre_turn" | "mid_turn"
): Promise<CompactionCheckpoint | undefined> {
  if (!shouldAutoCompactMessages(messages)) {
    return undefined;
  }
  return compactAndEmit(input, store, state, send, messages, {
    trigger: "auto",
    phase,
    reason: "context_limit"
  });
}

async function compactAndEmit(
  input: RunStart,
  store: RuntimeStore,
  state: RunStateMachine,
  send: (message: OutboundMessage) => Promise<void>,
  messages: RuntimeCompactionMessage[],
  options: {
    trigger: "auto" | "manual";
    phase: "pre_turn" | "mid_turn" | "standalone_turn";
    reason: "context_limit" | "user_requested";
  }
): Promise<CompactionCheckpoint> {
  await state.compact(options.phase);
  const checkpoint = await compactRuntimeMessages(messages, {
    ...options,
    windowState: await store.readCompactionState(input.conversation_id)
  });
  await store.append({
    type: "conversation.compacted",
    conversation_id: input.conversation_id,
    run_id: input.run_id,
    ...checkpoint
  });
  await send({
    type: "session.compacted",
    run_id: input.run_id,
    ...checkpoint
  });
  await state.start();
  return checkpoint;
}

async function activateExplicitlyMentionedSkills(
  input: RunStart,
  discovered: Awaited<ReturnType<typeof discoverSkills>>
): Promise<ActivatedSkill[]> {
  const references = explicitSkillReferences(input.message.content, discovered.map((skill) => skill.name));
  if (references.names.size === 0 && references.paths.size === 0) return [];

  const resourceRoots = skillResourceRoots(discovered);
  const activePaths = new Set<string>();
  const activatedAt = new Date().toISOString();
  const activations: ActivatedSkill[] = [];

  for (const skill of discovered) {
    if (!explicitSkillReferenceMatches(skill, references) || activePaths.has(skill.path)) {
      continue;
    }
    const resourceManifest = await listSkillBundleResourcePaths(skill.directory);
    activations.push({
      name: skill.name,
      path: skill.path,
      scope: skill.scope,
      directory: skill.directory,
      content: await readSkillResourceByPath(skill.path, resourceRoots),
      allowed_tools: skill.manifest.allowedTools,
      resource_paths: resourceManifest.paths,
      resource_manifest_truncated: resourceManifest.truncated,
      activated_at: activatedAt
    });
    activePaths.add(skill.path);
  }

  return activations;
}

function skillActivatedEvent(runId: string, activation: ActivatedSkill): OutboundMessage {
  return {
    type: "skill.activated",
    run_id: runId,
    name: activation.name,
    path: activation.path,
    scope: activation.scope ?? "custom",
    status: "activated",
    invocation_type: "explicit",
    reason: "explicit_mention",
    resource_paths: activation.resource_paths,
    resource_manifest_truncated: activation.resource_manifest_truncated
  };
}

async function skillActivationFromToolEvent(event: OutboundMessage): Promise<{
  name: string;
  path: string;
  scope?: string;
  directory: string;
  content: string;
  allowed_tools?: string;
  resource_paths: string[];
  resource_manifest_truncated: boolean;
} | undefined> {
  if (
    event.type !== "tool_call.delta"
    || event.status !== "completed"
    || event.name !== "file_read"
    || event.locality !== "server"
  ) {
    return undefined;
  }

  const result = event.result ?? {};
  const skillPath = typeof result.path === "string" ? result.path : "";
  const content = typeof result.content === "string" ? result.content : "";
  if (!skillPath.endsWith("/SKILL.md") && !skillPath.endsWith("\\SKILL.md")) {
    return undefined;
  }
  if (!content) return undefined;

  const normalized = path.resolve(skillPath);
  const parsed = tryParseSkillMarkdown(content);
  if (!parsed) return undefined;
  const resourceManifest = await listSkillBundleResourcePaths(path.dirname(normalized));
  return {
    name: parsed.manifest.name,
    path: normalized,
    directory: path.dirname(normalized),
    content,
    allowed_tools: parsed.manifest.allowedTools,
    resource_paths: resourceManifest.paths,
    resource_manifest_truncated: resourceManifest.truncated
  };
}

function tryParseSkillMarkdown(source: string): ReturnType<typeof parseSkillMarkdown> | undefined {
  try {
    return parseSkillMarkdown(source);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8400);
  const runtimeServer = createRuntimeServer();
  runtimeServer.server.listen(port, "127.0.0.1", () => {
    console.log(`Hatch TS runtime listening on ws://127.0.0.1:${port}/runtime`);
  });
}
