import "dotenv/config";

import http from "node:http";
import { createHash } from "node:crypto";
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
import { SkillRuntime } from "./skillRuntime.js";
import { RuntimeStore, type RunStatus } from "./store.js";
import { ToolBridge } from "./toolBridge.js";
import { CreatorReleaseResolver, type ResolvedCreatorRelease } from "./release.js";
import { EntitlementError, FileEntitlementResolver, type EntitlementResolver } from "./entitlements.js";
import { findCompletedDelivery, recordCompletedDelivery, type CommerceEventSink, type DeliveryArtifact, type DeliveryBinding } from "./delivery.js";
import { materializeCreatorRelease, permittedLocalTools } from "./releaseMaterialization.js";
import {
  discoverSkills,
  includeSkillInstructions,
  renderSkillsSection,
  visibleSkillsForSession
} from "./skills.js";

export type RuntimeServer = {
  server: http.Server;
  wss: WebSocketServer;
  close: () => Promise<void>;
};

export type RuntimeServerOptions = {
  createRuntime?: () => AgentRuntime;
  releaseResolver?: CreatorReleaseResolver;
  entitlementResolver?: EntitlementResolver;
  commerceEventSink?: CommerceEventSink;
  /**
   * A local write requires an explicit decision in the Desktop client. Keep
   * this separate from model request timeouts: an otherwise healthy run must
   * not fail just because the buyer took a moment to read the proposed diff.
   */
  clientToolTimeoutMs?: number;
};

/**
 * The Runtime remains usable without commerce (for local development and
 * protocol tests), but a deployed consumer Runtime must write completed
 * delivery events to the same durable ledger read by the Creator Dashboard.
 *
 * Kept here rather than in a demo-only entry point so `node dist/index.js`
 * has the same transaction behavior as the app we ship.
 */
export async function commerceEventSinkFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Promise<CommerceEventSink | undefined> {
  const ledgerFile = environment.HATCH_COMMERCE_LEDGER_FILE?.trim();
  if (!ledgerFile) return undefined;

  const commerce = await import(new URL("../../packages/commerce/src/index.js", import.meta.url).href) as {
    CommerceLedger: { open(options: { filePath: string }): Promise<{
      findByIdempotencyKey(key: string): unknown;
    }> };
    LedgerCommerceSink: new (ledger: unknown) => {
      ingest(type: string, payload: Record<string, unknown>, options: { idempotencyKey: string }): Promise<unknown>;
    };
  };
  const ledger = await commerce.CommerceLedger.open({ filePath: ledgerFile });
  const recognizedSink = new commerce.LedgerCommerceSink(ledger);
  return {
    append: (type, payload, options) => recognizedSink.ingest(type, payload, options),
    findByIdempotencyKey: (key) => ledger.findByIdempotencyKey(key)
  };
}

export async function createRuntimeServerFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Promise<RuntimeServer> {
  return createRuntimeServer({
    commerceEventSink: await commerceEventSinkFromEnvironment(environment)
  });
}

export function clientToolTimeoutMs(raw = process.env.HATCH_CLIENT_TOOL_TIMEOUT_MS): number {
  // The Desktop keeps a pending write visible while the buyer reviews it.
  // Two minutes is shorter than a normal interruption, while an unbounded
  // pending call would retain a dead browser connection forever.
  if (raw === undefined || raw === "") return 300_000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 30_000 || parsed > 1_800_000) {
    throw new Error("HATCH_CLIENT_TOOL_TIMEOUT_MS must be an integer between 30000 and 1800000");
  }
  return parsed;
}

type SessionBinding = {
  tenantId: string;
  userId: string;
  productId: string;
  releaseId: string;
  releaseDigest: string;
  release?: ResolvedCreatorRelease;
  entitlementId?: string;
  orderId?: string;
  creatorId?: string;
  explicit: boolean;
};

export function createRuntimeServer(options: RuntimeServerOptions = {}): RuntimeServer {
  const activeConversationRuns = new Map<string, string>();
  const connectionTasks = new Set<Promise<void>>();
  const createRuntime = options.createRuntime ?? createAgentRuntime;
  const releaseResolver = options.releaseResolver
    ?? (process.env.HATCH_RELEASES_DIR ? new CreatorReleaseResolver(process.env.HATCH_RELEASES_DIR) : undefined);
  const entitlementResolver = options.entitlementResolver
    ?? (process.env.HATCH_ENTITLEMENTS_FILE ? new FileEntitlementResolver(process.env.HATCH_ENTITLEMENTS_FILE) : undefined);
  const server = http.createServer((req, res) => {
    void handleHttpRequest(req, res, releaseResolver, entitlementResolver);
  });

  const wss = new WebSocketServer({ server, path: "/runtime" });
  wss.on("connection", (socket) => {
    const task = handleRuntimeSocket(
      socket,
      activeConversationRuns,
      createRuntime,
      releaseResolver,
      entitlementResolver,
      options.commerceEventSink,
      options.clientToolTimeoutMs ?? clientToolTimeoutMs()
    );
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

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  releaseResolver?: CreatorReleaseResolver,
  entitlementResolver?: EntitlementResolver
): Promise<void> {
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

  if (req.method === "GET" && url.pathname === "/v1/me/creator-agents") {
    const licenseToken = bearerToken(req);
    if (!licenseToken) {
      writeJson(res, 401, { error: { code: "authentication_required", message: "Sign in to view purchased Creator Agents." } });
      return;
    }
    if (!entitlementResolver || !releaseResolver) {
      writeJson(res, 503, { error: { code: "entitlements_unavailable", message: "Creator Agent purchases are temporarily unavailable." } });
      return;
    }
    try {
      const entitlements = await entitlementResolver.list({ licenseToken });
      const creatorAgents = await Promise.all(entitlements.map(async (entitlement) => {
        const release = await releaseResolver.resolve(entitlement.release_id, entitlement.release_digest);
        if (release.public.product_id !== entitlement.product_id || release.public.creator_id !== entitlement.creator_id) {
          throw new Error(`Entitlement ${entitlement.entitlement_id} does not match its pinned Creator Release`);
        }
        return {
          entitlement_id: entitlement.entitlement_id,
          creator: release.public.creator,
          product: {
            id: release.public.product_id,
            name: release.public.product.name,
            description: release.public.product.description,
            promise: release.public.product.promise,
            boundaries: release.public.product.boundaries,
            offer: release.public.product.price
          },
          presentation: release.public.presentation
        };
      }));
      writeJson(res, 200, { creator_agents: creatorAgents });
    } catch (error) {
      writeJson(res, 403, { error: { code: "entitlement_lookup_failed", message: errorMessage(error) } });
    }
    return;
  }

  const match = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
  if (req.method === "GET" && match) {
    const conversationId = decodeURIComponent(match[1] ?? "");
    let binding: SessionBinding | undefined;
    try {
      binding = await bindingFromHistoryRequest(req, url, releaseResolver, entitlementResolver);
    } catch (error) {
      writeJson(res, 403, { error: { code: "entitlement_required", message: errorMessage(error) } });
      return;
    }
    if (!binding) {
      writeJson(res, 400, { error: { code: "binding_required", message: "A signed-in entitlement binding is required." } });
      return;
    }
    const store = new RuntimeStore();
    writeJson(res, 200, {
      conversation_id: conversationId,
      tenant_id: binding.tenantId,
      product_id: binding.productId,
      release_id: binding.releaseId,
      release_digest: binding.releaseDigest,
      messages: sanitizeBoundHistory(
        await store.readVisibleConversation(scopedConversationId(binding, conversationId)),
        binding.releaseId
      )
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
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
  createRuntime: () => AgentRuntime,
  releaseResolver?: CreatorReleaseResolver,
  entitlementResolver?: EntitlementResolver,
  commerceEventSink?: CommerceEventSink,
  toolResultTimeoutMs = clientToolTimeoutMs()
): Promise<void> {
  let hello: ClientHello | undefined;
  let binding: SessionBinding | undefined;
  let sessionSkills: RuntimeSessionSkills | undefined;
  const store = new RuntimeStore();
  const serverTools = new ServerToolExecutor();
  const runtime = createRuntime();
  const activeRuns = new Set<Promise<void>>();
  const activeRunStates = new Map<string, RunStateMachine>();
  const activeSkillRuntimes = new Map<string, SkillRuntime>();

  const send = async (message: OutboundMessage): Promise<void> => {
    const outbound = protectPrivateReleaseBoundary(message, binding?.release);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(outbound));
    }
    const conversationId = "run_id" in outbound && outbound.run_id
      ? activeRunStates.get(outbound.run_id)?.conversationId
      : undefined;
    await store.append({
      type: "runtime.event",
      conversation_id: conversationId,
      run_id: "run_id" in outbound ? outbound.run_id : undefined,
      event: outbound
    });
  };
  const broker = new ClientToolBroker(send, store, toolResultTimeoutMs);
  const toolBridge = new ToolBridge(broker, serverTools);

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
          binding = await resolveSessionBinding(message, releaseResolver, entitlementResolver);
          hello = binding.release
            ? { ...message, local_tools: permittedLocalTools(binding.release, message.local_tools) }
            : message;
          sessionSkills = await buildSessionSkills(hello.workspace_root, binding.release);
          await store.append({
            type: "session.started",
            installation_id: message.installation_id,
            tenant_id: binding.tenantId,
            user_id: binding.userId,
            product_id: binding.productId,
            release_id: binding.releaseId,
            release_digest: binding.releaseDigest,
            ...(binding.entitlementId ? { entitlement_id: binding.entitlementId } : {}),
            client_version: message.client_version,
            workspace_root: hello.workspace_root,
            local_tools: hello.local_tools
          });
          await send({
            type: "session.ready",
            accepted_protocol_version: PROTOCOL_VERSION,
            tenant_id: binding.tenantId,
            user_id: binding.userId,
            product_id: binding.productId,
            release_id: binding.releaseId,
            release_digest: binding.releaseDigest,
            ...(binding.entitlementId ? { entitlement_id: binding.entitlementId } : {}),
            ...(binding.release ? {
              creator_agent: {
                creator: binding.release.public.creator,
                product: {
                  id: binding.release.public.product_id,
                  name: binding.release.public.product.name,
                  description: binding.release.public.product.description,
                  promise: binding.release.public.product.promise,
                  boundaries: binding.release.public.product.boundaries,
                  offer: binding.release.public.product.price
                },
                presentation: binding.release.public.presentation
              }
            } : {})
          });
          return;
        }

        if (!hello || !binding) {
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
          const reason = message.reason ?? "Run canceled";
          await state.cancel(reason).catch(() => undefined);
          await store.append({
            type: "message.created",
            conversation_id: state.conversationId,
            run_id: state.runId,
            role: "assistant",
            content: "Run cancelled."
          }).catch(() => undefined);
          const cleanup = await Promise.allSettled([
            broker.cancelRun(message.run_id, reason),
            activeSkillRuntimes.get(message.run_id)?.cancelParentRun(message.run_id) ?? Promise.resolve()
          ]);
          await persistCancellationCleanupErrors(store, message.run_id, cleanup);
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
          const storageConversationId = binding.explicit ? scopedConversationId(binding, message.conversation_id) : message.conversation_id;
          const boundMessage: RunStart = { ...message, conversation_id: storageConversationId };
          const activeRunId = activeConversationRuns.get(storageConversationId);
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

          activeConversationRuns.set(storageConversationId, message.run_id);
          const state = new RunStateMachine(message.run_id, storageConversationId, store, async (status, reason) => {
            if (isTerminalRunStatus(status)) {
              releaseConversationRun(activeConversationRuns, storageConversationId, message.run_id);
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
          const task = runOneTurn(boundMessage, hello, sessionSkills, binding, broker, serverTools, toolBridge, runtime, createRuntime, store, state, send, activeSkillRuntimes, commerceEventSink);
          activeRuns.add(task);
          task.finally(() => {
            activeRuns.delete(task);
            activeRunStates.delete(message.run_id);
            releaseConversationRun(activeConversationRuns, storageConversationId, message.run_id);
          });
        }
      } catch (error) {
        await send({
          type: "turn.failed",
          error: {
            code: error instanceof EntitlementError ? error.code : "protocol_error",
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

export function protectPrivateReleaseBoundary(message: OutboundMessage, release?: ResolvedCreatorRelease): OutboundMessage {
  if (!release) return message;
  if (message.type === "skill.activated" || message.type === "skill.invoked") {
    return {
      ...message,
      path: `release://${release.public.release_id}/protected-skill/${encodeURIComponent(message.name)}`,
      ...(message.type === "skill.activated" ? { resource_paths: [], resource_manifest_truncated: false } : {}),
      ...(message.type === "skill.invoked" ? { trigger: { ...message.trigger, path: message.trigger.path ? "release://private" : undefined } } : {})
    } as OutboundMessage;
  }
  if (message.type === "tool_call.delta" && message.locality === "server") {
    const serializedArguments = JSON.stringify(message.arguments ?? {});
    if ([release.releaseDirectory, release.protectedSkillsRoot, release.ragRoot].some((root) => serializedArguments.includes(root))) {
      return { ...message, arguments: {}, result: message.result ? { private_result_redacted: true } : undefined };
    }
  }
  return message;
}

async function runOneTurn(
  input: RunStart,
  hello: ClientHello,
  sessionSkills: RuntimeSessionSkills,
  binding: SessionBinding,
  broker: ClientToolBroker,
  serverTools: ServerToolExecutor,
  toolBridge: ToolBridge,
  runtime: AgentRuntime,
  createRuntime: () => AgentRuntime,
  store: RuntimeStore,
  state: RunStateMachine,
  send: (message: OutboundMessage) => Promise<void>,
  activeSkillRuntimes: Map<string, SkillRuntime>,
  commerceEventSink?: CommerceEventSink
): Promise<void> {
  let skillRuntime: SkillRuntime | undefined;
  let deliveredArtifact: DeliveryArtifact | undefined;
  try {
    await state.start();
    const deliveryBinding = deliveryBindingFromSession(binding);
    if (commerceEventSink && deliveryBinding) {
      const completedDelivery = await findCompletedDelivery(
        commerceEventSink,
        deliveryBinding,
        input.conversation_id,
        input.run_id
      );
      if (completedDelivery) {
        await send({ type: "delivery.ready", run_id: input.run_id, ...completedDelivery });
        await send({
          type: "turn.completed",
          run_id: input.run_id,
          output: [{ type: "message", content: "This delivery was already completed. The existing artifact has not been changed." }],
          usage: { input_tokens: 0, output_tokens: 0 }
        });
        await state.complete();
        return;
      }
    }
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

    const materializedRelease = binding.release
      ? await materializeCreatorRelease(binding.release, input.message.content, hello.local_tools)
      : undefined;
    skillRuntime = new SkillRuntime({
      parentInput: input,
      parentState: state,
      sessionSkills,
      clientBroker: broker,
      serverTools,
      toolBridge,
      clientTools: materializedRelease?.localTools ?? hello.local_tools,
      allowedExternalTools: materializedRelease?.externalTools,
      releaseSystemPrompt: materializedRelease?.systemPrompt,
      releaseDeliveryWorkflow: materializedRelease?.deliveryWorkflow,
      releaseDeliveryAuditContext: materializedRelease?.deliveryAuditContext,
      workspaceRoot: hello.workspace_root,
      store,
      emit: send,
      createWorkerRuntime: () => createRuntime()
    });
    activeSkillRuntimes.set(input.run_id, skillRuntime);
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
      activatedSkills: [],
      clientTools: materializedRelease?.localTools ?? hello.local_tools,
      allowedExternalTools: materializedRelease?.externalTools,
      // A Creator Release has already materialized its one protected Skill
      // into the server-private system prompt. Product execution is a single
      // Agent session, not a generic parent Agent delegating to a second one.
      allowSkillRun: !binding.release,
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
      },
      toolBridge,
      skillRuntime,
      toolScope: "main",
      releaseSystemPrompt: materializedRelease?.systemPrompt,
      releaseDeliveryWorkflow: materializedRelease?.deliveryWorkflow,
      releaseDeliveryAuditContext: materializedRelease?.deliveryAuditContext
    })) {
      if (state.status === "cancelled") {
        break;
      }
      await persistServerToolCallEvent(event, input, store);
      await persistSkillEvent(event, input, store);
      if (
        event.type === "tool_call.delta"
        && event.locality === "client"
        && event.name === "fs.write"
        && event.status === "completed"
        && typeof event.arguments?.content === "string"
      ) {
        deliveredArtifact = {
          type: "file",
          content: event.arguments.content,
          ...(typeof event.arguments.path === "string" ? { path: event.arguments.path } : {})
        };
      }
      if (event.type === "turn.completed") {
        const artifactContent = event.output.map((item) => item.content).join("\n");
        await store.append({
          type: "message.created",
          conversation_id: input.conversation_id,
          run_id: input.run_id,
          role: "assistant",
          content: artifactContent
        });
        if (commerceEventSink && deliveryBinding) {
          const receipt = await recordCompletedDelivery(
            commerceEventSink,
            deliveryBinding,
            input.conversation_id,
            input.run_id,
            deliveredArtifact ?? { type: "message", content: artifactContent }
          );
          await send({ type: "delivery.ready", run_id: input.run_id, ...receipt });
        }
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
  } finally {
    await skillRuntime?.cancelParentRun(input.run_id);
    activeSkillRuntimes.delete(input.run_id);
  }
}

async function persistCancellationCleanupErrors(
  store: RuntimeStore,
  runId: string,
  results: PromiseSettledResult<unknown>[]
): Promise<void> {
  if (!results.some((result) => result.status === "rejected")) return;
  await store.append({
    type: "runtime.event",
    run_id: runId,
    event: {
      type: "turn.cleanup",
      status: "error"
    }
  }).catch(() => undefined);
}

async function buildSessionSkills(workspaceRoot?: string, release?: ResolvedCreatorRelease): Promise<RuntimeSessionSkills> {
  // The Release materializer loads the exact protected SKILL.md into the
  // direct server Agent. Do not also expose it as a model-selectable catalog
  // entry: that creates an unnecessary nested skill worker and lets the same
  // method run through two different delivery paths.
  const records = release ? [] : await discoverSkills({ workspaceRoot });
  const visibleRecords = visibleSkillsForSession(records);
  const rendered = await includeSkillInstructions()
    ? renderSkillsSection(visibleRecords, { executionMode: "protected" })
    : emptyRenderedSkills();
  const projectInstructions = await loadProjectInstructions(workspaceRoot);
  return {
    records,
    visibleRecords,
    rendered,
    ...(projectInstructions ? { projectInstructions } : {})
  };
}

async function resolveSessionBinding(
  hello: ClientHello,
  releaseResolver?: CreatorReleaseResolver,
  entitlementResolver?: EntitlementResolver
): Promise<SessionBinding> {
  const productMode = Boolean(releaseResolver || entitlementResolver);
  if (productMode) {
    if (!releaseResolver || !entitlementResolver) {
      throw new EntitlementError(
        "entitlement_configuration_incomplete",
        "Creator Agent access is unavailable because entitlement verification is not fully configured."
      );
    }
    if (!hello.entitlement_id) {
      throw new EntitlementError("entitlement_required", "A valid Creator Agent entitlement is required.");
    }
    const entitlement = await entitlementResolver.resolve({
      licenseToken: hello.license_token,
      entitlementId: hello.entitlement_id,
      installationId: hello.installation_id
    });
    const release = await releaseResolver.resolve(entitlement.release_id, entitlement.release_digest);
    if (release.public.product_id !== entitlement.product_id || release.public.creator_id !== entitlement.creator_id) {
      throw new Error("Entitlement does not match its pinned Creator Release");
    }
    return {
      tenantId: entitlement.tenant_id,
      userId: entitlement.user_id,
      productId: entitlement.product_id,
      releaseId: entitlement.release_id,
      releaseDigest: entitlement.release_digest,
      entitlementId: entitlement.entitlement_id,
      orderId: entitlement.order_id,
      creatorId: entitlement.creator_id,
      release,
      explicit: true
    };
  }

  // Resolver-free mode is intentionally limited to local development and tests.
  // In product mode all scope is derived from a server-verified entitlement above.
  const tenantId = hello.tenant_id ?? `local-${shortHash(hello.license_token)}`;
  const userId = hello.user_id ?? hello.installation_id;
  const releaseId = hello.release_id ?? "local-uat-release";
  const releaseDigest = hello.release_digest ?? `sha256:${"0".repeat(64)}`;
  const release = hello.release_id && releaseResolver ? await releaseResolver.resolve(releaseId, releaseDigest) : undefined;
  if (hello.release_id && !releaseResolver) throw new Error("HATCH_RELEASES_DIR is required for an explicit Creator Release");
  const productId = hello.product_id ?? release?.public.product_id ?? "local-uat-product";
  if (release && release.public.product_id !== productId) throw new Error("Creator Release product binding mismatch");
  return {
    tenantId, userId, productId, releaseId, releaseDigest, release,
    explicit: Boolean(hello.tenant_id || hello.user_id || hello.product_id || hello.release_id || hello.release_digest)
  };
}

export function scopedConversationId(binding: Pick<SessionBinding, "tenantId" | "userId" | "productId" | "releaseId" | "releaseDigest">, conversationId: string): string {
  return `scope:${shortHash([binding.tenantId, binding.userId, binding.productId, binding.releaseId, binding.releaseDigest].join("\u0000"))}:${conversationId}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

async function bindingFromHistoryRequest(
  req: http.IncomingMessage,
  url: URL,
  releaseResolver?: CreatorReleaseResolver,
  entitlementResolver?: EntitlementResolver
): Promise<SessionBinding | undefined> {
  const entitlementId = url.searchParams.get("entitlement_id") ?? undefined;
  const licenseToken = bearerToken(req);
  const productMode = Boolean(releaseResolver || entitlementResolver);
  if (productMode) {
    if (!releaseResolver || !entitlementResolver) {
      throw new EntitlementError(
        "entitlement_configuration_incomplete",
        "Creator Agent access is unavailable because entitlement verification is not fully configured."
      );
    }
    if (!entitlementId || !licenseToken) {
      throw new EntitlementError("entitlement_required", "A Bearer token and Creator Agent entitlement are required.");
    }
    const entitlement = await entitlementResolver.resolve({ licenseToken, entitlementId });
    const release = await releaseResolver.resolve(entitlement.release_id, entitlement.release_digest);
    if (release.public.product_id !== entitlement.product_id || release.public.creator_id !== entitlement.creator_id) {
      throw new Error("Entitlement does not match its pinned Creator Release");
    }
    return {
      tenantId: entitlement.tenant_id,
      userId: entitlement.user_id,
      productId: entitlement.product_id,
      releaseId: entitlement.release_id,
      releaseDigest: entitlement.release_digest,
      entitlementId: entitlement.entitlement_id,
      orderId: entitlement.order_id,
      creatorId: entitlement.creator_id,
      release,
      explicit: true
    };
  }

  // Self-reported scope is accepted only when no product resolver is configured.
  // This keeps the existing resolver-free local harness usable without creating a
  // production authorization bypass.
  const value = (name: string): string | undefined => url.searchParams.get(name) ?? (typeof req.headers[`x-hatch-${name.replaceAll("_", "-")}`] === "string" ? String(req.headers[`x-hatch-${name.replaceAll("_", "-")}`]) : undefined);
  const [tenantId, userId, productId, releaseId, releaseDigest] = [value("tenant_id"), value("user_id"), value("product_id"), value("release_id"), value("release_digest")];
  if (!tenantId || !userId || !productId || !releaseId || !releaseDigest || !/^sha256:[a-f0-9]{64}$/.test(releaseDigest)) return undefined;
  return { tenantId, userId, productId, releaseId, releaseDigest, explicit: true };
}

function bearerToken(req: http.IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function deliveryBindingFromSession(binding: SessionBinding): DeliveryBinding | undefined {
  if (!binding.entitlementId || !binding.orderId || !binding.creatorId) return undefined;
  return {
    entitlementId: binding.entitlementId,
    orderId: binding.orderId,
    userId: binding.userId,
    creatorId: binding.creatorId,
    productId: binding.productId,
    releaseId: binding.releaseId,
    releaseDigest: binding.releaseDigest
  };
}

function sanitizeBoundHistory(messages: Awaited<ReturnType<RuntimeStore["readVisibleConversation"]>>, releaseId: string): Awaited<ReturnType<RuntimeStore["readVisibleConversation"]>> {
  return messages.map((message) => ({
    ...message,
    ...(message.skill_events ? {
      skill_events: message.skill_events.map((event) => ({
        ...event,
        path: `release://${releaseId}/protected-skill/${encodeURIComponent(event.name)}`,
        resource_paths: event.resource_paths ? [] : undefined,
        resource_manifest_truncated: event.resource_manifest_truncated === undefined ? undefined : false,
        trigger: event.trigger ? { ...event.trigger, path: event.trigger.path ? "release://private" : undefined } : undefined
      }))
    } : {}),
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map((tool) => tool.locality === "server" && /^file[._]/.test(tool.name)
        ? { ...tool, arguments: {}, result: tool.result === undefined ? undefined : { private_result_redacted: true } }
        : tool)
    } : {})
  }));
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
  void createRuntimeServerFromEnvironment().then((runtimeServer) => {
    runtimeServer.server.listen(port, "127.0.0.1", () => {
      const commerce = process.env.HATCH_COMMERCE_LEDGER_FILE ? " with commerce ledger" : "";
      console.log(`Hatch TS runtime listening on ws://127.0.0.1:${port}/runtime${commerce}`);
    });
  }).catch((error: unknown) => {
    console.error("Unable to start Hatch Runtime:", error);
    process.exitCode = 1;
  });
}
