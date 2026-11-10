import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { harness, png } from "../assets/kit.test.js";
import { AttachmentFiles } from "../assets/files.js";
import type { AgentRuntime, RunContext } from "../agentRuntime.js";
import type { OutboundMessage, RunStart } from "../protocol.js";
import { RuntimeAssetStore } from "../assetStore.js";
import { ChatAssets } from "../chat/assets.js";
import { attachmentToolDefinitions } from "../chat/attachmentTools.js";
import { createFactoryLlmModel, type FactoryPiAgentOptions } from "../creatorLearning/factoryPi.js";
import { UpstreamError } from "../errors/upstream.js";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { MemoryEventLog } from "../conversations/eventLog.js";
import { FileWorkbenchBackend, WorkbenchStore } from "../factoryAgents/store.js";
import { WorkbenchRuntime } from "../factoryAgents/runtime.js";
import type { FactoryWorkspace } from "../factoryAgents/service.js";
import { RuntimeStore, localRuntimeAuthority } from "../store.js";
import { toolRegistry } from "../tools.js";
import { MemoryAgentDefinitionRepository, initialAgentDefinitions } from "../factoryAgents/definitions.js";
import { AssistantService, type ProductWorkspaces } from "./assistant.js";
import { AssistantChat } from "./chat.js";
import { MemoryDeliveries } from "./deliveries.js";
import { LegacyAssistantHistory } from "./history.js";
import { ExpertMaterials } from "./materials.js";
import type { AccountReach } from "./reach.js";
import { MemoryAssistantState } from "./state.js";
import { studioTranscripts, assistantFeedKey } from "./studioFeed.js";
import { studioToolDefinitions, studioTools } from "./studioTools.js";
import { AssistantTarget } from "./assistantTarget.js";
import type { AssistantChannels, Inbound } from "../channels/ports.js";
import type { ChannelConnection } from "../channels/connections.js";
import { idempotencyId, type OutboundMessage as ChannelMessage } from "../channels/types.js";
import { TelegramChannel } from "../channels/telegramChannel.js";
import { guarded } from "../channels/eligibility.js";
import { MemoryTaskRepository } from "./tasks.js";
import type { AgentCatalog, AgentChange } from "./catalog.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "22222222-2222-4222-8222-222222222222";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Step = {
  tools?: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** What it says, computed once the messages that joined the turn are in. */
  text?: string | ((turn: Turn) => string);
  delayMs?: number;
  /** The provider's error: the turn ends in it. */
  fail?: string;
};
type Turn = { input: RunStart; ctx: RunContext; /** Everything the Expert said in this turn, in order. */ said: string[]; live: string | undefined };

/** Automated test double for the model: the Assistant's runtime, scripted, with the tools called as the real one calls them. */
function scriptedModel(script: (turn: Turn, call: number) => Step | Promise<Step>) {
  const state = { calls: 0, turns: [] as Turn[] };
  const runtime: AgentRuntime = {
    async *run(input, ctx): AsyncGenerator<OutboundMessage> {
      const call = ++state.calls;
      const turn: Turn = { input, ctx, said: [input.message.content], live: await ctx.liveState?.() };
      state.turns.push(turn);
      const step = await script(turn, call);
      if (step.delayMs) await sleep(step.delayMs);
      for (const [index, tool] of (step.tools ?? []).entries()) {
        await ctx.toolBridge!.execute({ scope: "main", runId: input.run_id, toolCallId: `t${call}-${index}`, name: `studio.${tool.name}`, arguments: tool.arguments, clientTools: ctx.clientTools, state: ctx.state });
      }
      for (let more = await ctx.claimSteered?.(); more?.length; more = await ctx.claimSteered?.()) turn.said.push(...more.map(message => message.content ?? ""));
      if (step.fail) throw UpstreamError.of(step.fail);
      const text = typeof step.text === "function" ? step.text(turn) : step.text ?? "";
      if (text) yield { type: "assistant.delta", run_id: input.run_id, delta: { kind: "text", content: text } };
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };
  return { runtime, state };
}

type WorkerStep = { text?: string; tool?: { name: string; arguments: Record<string, unknown> } };

/** The interview and other workers still run on the factory runtime: a scripted model for them. */
function scriptedWorkers(script: (context: Context, call: number) => WorkerStep) {
  let calls = 0;
  return (options: FactoryPiAgentOptions) => new Agent({ ...options.agentOptions, initialState: { ...options.initialState, model: createFactoryLlmModel({ env: options.env }) }, streamFn: (_model, context) => {
    const step = script(context, ++calls);
    const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "moonshotai-cn", model: "kimi-k2.6", timestamp: Date.now(),
      content: step.tool ? [{ type: "toolCall", id: `call-worker-${calls}`, ...step.tool }] : [{ type: "text", text: step.text ?? "" }],
      stopReason: step.tool ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    setTimeout(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: step.tool ? "toolUse" : "stop", message }); stream.end(message); }, 0);
    return stream;
  } });
}

const userTexts = (context: Context) => context.messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content : message.content.map(block => block.type === "text" ? block.text : "").join("")).filter(text => !text.startsWith("<system-reminder>"));

async function setup(options: { model: Parameters<typeof scriptedModel>[0]; worker?: Parameters<typeof scriptedWorkers>[0]; legacy?: boolean; transcriber?: Parameters<typeof harness>[0] extends infer H ? H extends { transcriber?: infer T } ? T : never : never }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-assistant-"));
  const tasks = new MemoryTaskRepository();
  const state = new MemoryAssistantState();
  const deliveries = new MemoryDeliveries();
  const pushed: Array<{ text: string; buttons?: ChannelMessage["buttons"]; prefer?: string }> = [];
  const applied: AgentChange[] = [];
  let reachable = true;
  const reach = { assistantAccounts: async () => [{ accountId: ACCOUNT, timezone: "UTC" }] } as unknown as AccountReach;
  const channels: Pick<AssistantChannels, "push" | "canReach"> = {
    push: async (_account, message, prefer) => { pushed.push({ text: message.text, ...(message.buttons ? { buttons: message.buttons } : {}), ...(prefer ? { prefer } : {}) }); return true; },
    canReach: async () => reachable,
  };
  const telegram = new TelegramChannel({ token: "test", username: "hatch_test_bot", webhookSecret: "secret" }, (async (url: string, init?: RequestInit) => {
    if (url.includes("/file/bot")) return new Response(url.endsWith(".oga") ? Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]) : "# 我的选址笔记\n隔壁活过三年才算数\n", { status: 200 });
    if (url.endsWith("/getFile")) return new Response(JSON.stringify({ ok: true, result: { file_path: String(init?.body).includes('"v1"') ? "voice/file_1.oga" : "documents/notes.md" } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch);
  const productStore = new WorkbenchStore(path.join(root, "product"), { creatorId: ACCOUNT, productId: PRODUCT }, new MemoryAgentDefinitionRepository(await initialAgentDefinitions()));
  let grantedTools: Parameters<ProductWorkspaces["attachAssistant"]>[0]["grantedTools"] | undefined;
  let withheldTools: Parameters<ProductWorkspaces["attachAssistant"]>[0]["withheldTools"] | undefined;
  const agentFactory = scriptedWorkers(options.worker ?? (() => ({ text: "完成" })));
  const productRuntime = new WorkbenchRuntime(productStore, { env: { HATCH_FACTORY_LLM_PROFILE: "kimi-k2.6" }, agentFactory, maxTurns: 6, grantedTools: session => grantedTools?.({ creatorId: ACCOUNT, productId: PRODUCT }, session) ?? [], withheldTools: async session => await withheldTools?.({ creatorId: ACCOUNT, productId: PRODUCT }, session) ?? [] });
  const workspace = { store: productStore, runtime: productRuntime } as unknown as FactoryWorkspace;
  let opened: ((scope: { creatorId: string; productId: string }, workspace: FactoryWorkspace) => void) | undefined;
  const catalog: AgentCatalog = {
    list: async () => [{ productId: PRODUCT, name: "选址顾问", promise: "帮餐厅老板选址", status: "published" }],
    get: async (_account, productId) => productId === PRODUCT ? { productId, name: "选址顾问", promise: "帮餐厅老板选址", status: "published" } : undefined,
    create: async () => { throw new Error("unused"); },
    apply: async (_account, _product, change) => { applied.push(change); },
    live: async () => ({ is_live: false, pending_changes: [] }),
    token: async () => "token",
  };
  const legacy = new FileWorkbenchBackend(path.join(root, "assistant"));
  const assistant = new AssistantService({
    tasks, reach, catalog, channels, state, deliveries,
    products: { workspace: async () => { opened?.({ creatorId: ACCOUNT, productId: PRODUCT }, workspace); return workspace; }, attachAssistant: hooks => { opened = hooks.opened; grantedTools = hooks.grantedTools; withheldTools = hooks.withheldTools; } },
    backend: () => legacy,
    exclusive: async (_name, fn) => fn(),
    env: { HATCH_FACTORY_LLM_PROFILE: "kimi-k2.6" },
    runtime: { agentFactory },
  });
  const dataDir = path.join(root, "chat");
  const store = new (studioTranscripts(RuntimeStore))(dataDir);
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  const kit = await harness({ ...(options.transcriber ? { transcriber: options.transcriber } : {}) });
  const chatAssets = new ChatAssets({ pipeline: kit.pipeline, blobs: kit.blobs, files: new AttachmentFiles(kit.repository, kit.blobs) });
  for (const definition of attachmentToolDefinitions(chatAssets.tools())) toolRegistry.set(definition.name, definition);
  const tools = studioTools(assistant);
  for (const definition of studioToolDefinitions(tools)) toolRegistry.set(definition.name, definition);
  const log = new MemoryEventLog();
  const model = scriptedModel(options.model);
  const chat = new AssistantChat({
    repository, store, eventLog: log, chatAssets, state, tools, desk: assistant, assetStore: new RuntimeAssetStore(dataDir),
    history: new LegacyAssistantHistory({ backend: () => legacy, state, store }),
    prompt: async () => "你是 Hatch 助理。", liveState: id => assistant.liveState(id), env: {}, createRuntime: () => model.runtime,
    sweepMs: 60_000,
  });
  assistant.bind(chat, new ExpertMaterials({ assets: chatAssets, conversation: id => chat.conversation(id) }));
  await chat.start();
  const connection: ChannelConnection = { id: "c0000000-0000-4000-8000-000000000001", ownerAccountId: ACCOUNT, channel: "telegram", scope: "", client: "im", target: { kind: "assistant" }, audience: "self", taskSpecific: false, state: "active" };
  const target = new AssistantTarget(assistant);
  const notices: string[] = [];
  /** What the router hands the Assistant once it has authorized the sender; the inbox id is derived from the event id, so a repeat is the same message. */
  const telegramUpdate = async (update: unknown) => {
    const handled = [];
    for (const event of telegram.parse(Buffer.from(JSON.stringify(update))).events) {
      const inbound: Inbound = {
        id: idempotencyId(event.eventId), connection, event, adapter: telegram, principal: { kind: "account", accountId: ACCOUNT },
        address: { connectionId: connection.id, ...event.address }, notify: async text => { notices.push(text); },
      };
      handled.push(await target.handle(inbound));
    }
    return handled;
  };
  const say = (text: string, id = `m-${Math.random().toString(36).slice(2)}`) => chat.say(ACCOUNT, { id, parts: [{ type: "text", text }], client: { client: "web" } });
  const idle = async () => { await sleep(30); await chat.idle(ACCOUNT, 20_000); await sleep(30); };
  return {
    root, tasks, state, deliveries, pushed, notices, log, applied, telegramUpdate, assistant, chat, target, model, productStore, productRuntime, say, idle, legacy, store, kit, tools, chatAssets,
    setReachable: (value: boolean) => { reachable = value; },
    close: async () => { await assistant.close(); await chat.close(); await productRuntime.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); },
  };
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await sleep(20);
  }
}

const update = (id: number, text: string) => ({ update_id: id, message: { message_id: 9 + id, chat: { id: 42, type: "private" }, text } });

test("A burst of Telegram messages steers one Run: every message is in it, and one reply is owed", async () => {
  const env = await setup({ model: (turn, call) => call === 1 ? { delayMs: 200, text: turn2 => `看到${turn2.said.length}条` } : { text: "不该再有一轮" } });
  try {
    const first = await env.telegramUpdate(update(1, "第一条"));
    await sleep(60);
    const burst = [...await env.telegramUpdate(update(2, "第二条")), ...await env.telegramUpdate(update(3, "第三条")), ...await env.telegramUpdate(update(3, "第三条"))];
    await env.idle();
    assert.equal(env.model.state.calls, 1, "the later messages joined the Run: there is no merge window and no second Run");
    assert.deepEqual(env.model.state.turns[0]!.said, ["第一条", "第二条", "第三条"]);
    assert.equal(new Set([...first, ...burst].map(handled => handled.runId)).size, 1, "all of them belong to one Run, which is where the one reply comes from");
    const progress = await env.chat.gateway.progress(first[0]!.runId!);
    assert.equal(progress?.ended && progress.reply.text, "看到3条");
    const lines = await env.chat.lines(ACCOUNT);
    assert.deepEqual(lines.filter(line => line.role === "user").map(line => line.text), ["第一条", "第二条", "第三条"], "the repeated update was one message");
    const kinds = (await env.log.after(assistantFeedKey(ACCOUNT), "0", 5000)).map(entry => entry.event.type);
    assert.ok(kinds.includes("delta") && kinds.includes("message_end") && kinds.includes("run_end"), "Studio observers see the Run like a worker's");
  } finally { await env.close(); }
});

test("The Assistant's tools are its own: declared once, absent from a Product's conversation, refused from a client that cannot use them", async () => {
  const env = await setup({ model: () => ({ tools: [{ name: "list_tasks", arguments: {} }], text: "好" }) });
  try {
    const { chatToolsForRun } = await import("../agentRuntime.js");
    const names = (allowed?: string[]) => chatToolsForRun([], allowed).map(tool => tool.function.name);
    assert.ok(!names().includes("start_task") && !names(["creator.x"]).includes("start_task"), "a Product's conversation has no Studio tools");
    assert.ok(names(env.tools.map(tool => `studio.${tool.name}`)).includes("start_task"));
    assert.deepEqual(names(env.tools.map(tool => `studio.${tool.name}`)), [...names(env.tools.map(tool => `studio.${tool.name}`))].sort(), "one fixed order");
    assert.match(toolRegistry.get("studio.start_task")!.model!.description!, /Available on: web, cli, mcp, im/);
    await env.say("看看事项");
    await env.idle();
    assert.equal((await env.chat.status(ACCOUNT)).state, "idle");
    // The client of the latest message authorizes the call.
    await env.chat.say(ACCOUNT, { id: "from-dm", parts: [{ type: "text", text: "dm" }], client: { client: "dm" } });
    await env.idle();
    assert.equal((await env.chat.status(ACCOUNT)).state, "failed", "tool_unsupported_on_client ended the Run");
  } finally { await env.close(); }
});

test("The Assistant's build runs the Product's builder, which cannot go live", async () => {
  const toolNames: string[][] = [];
  const env = await setup({
    model: (_turn, call) => call === 1 ? { tools: [{ name: "start_task", arguments: { kind: "build", agent_id: PRODUCT, instruction: "加上熟客店菜单可以长的例外" } }], text: "好" } : { text: "好" },
    worker: context => { toolNames.push((context.tools ?? []).map(tool => tool.name)); return { text: "构建完成" }; },
  });
  try {
    await env.say("熟客店菜单可以长");
    await waitFor(async () => (await env.productStore.list()).some(session => session.role === "generation") && (await env.tasks.open(ACCOUNT)).length === 0);
    assert.ok(toolNames.length > 0);
    assert.ok(toolNames.every(names => !names.includes("corpus_upload")), "publishing stays with the Assistant");
    assert.deepEqual(env.applied, [], "a build changes nothing outward");
  } finally { await env.close(); }
});

test("A worker question becomes a task waiting for the Expert, and the Assistant hears it as news", async () => {
  const heard: string[] = [];
  const env = await setup({
    model: turn => { heard.push(turn.input.message.content); return { text: "好" }; },
    worker: (_context, call) => call === 1 ? { tool: { name: "askuser", arguments: { questions: [{ question: "这份评测里哪处最不像你？", options: [] }] } } } : { text: "完成" },
  });
  try {
    const task = await env.tasks.create({ accountId: ACCOUNT, productId: PRODUCT, kind: "evaluate", origin: { source: "web" }, status: "needs_you", needs: "review", payload: { step: "confirm", instruction: "更新" } });
    const evaluator = await env.productStore.create("evaluator");
    await env.tasks.update(task.id, { status: "working", session: { scope: "product", sessionId: evaluator.id }, payload: { step: "evaluator" } });
    await (env.assistant as unknown as { workspace(a: string, p: string): Promise<FactoryWorkspace> }).workspace(ACCOUNT, PRODUCT);
    await env.productRuntime.start(evaluator.id, "用最新案例评测线上 Agent。");
    await waitFor(() => heard.some(text => text.includes("这份评测里哪处最不像你？")));
    const waiting = await env.tasks.get(task.id);
    assert.equal(waiting!.status, "needs_you");
    assert.equal(waiting!.needs, "answer");
    assert.deepEqual(waiting!.payload.questions, ["这份评测里哪处最不像你？"]);
    assert.ok(heard.some(text => text.startsWith(`[任务 ${task.id}]`)));
    await env.idle();
    assert.deepEqual((await env.chat.lines(ACCOUNT)).filter(line => line.role === "user"), [], "news is not the Expert speaking");
    await env.assistant.answer(ACCOUNT, task.id, "第二条最不像我");
    await waitFor(async () => (await env.tasks.get(task.id))!.status === "done");
    const answered = (await env.productStore.get(evaluator.id)).messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content));
    assert.ok(answered.some(text => text.includes("第二条最不像我")), "the answer reached the worker");
  } finally { await env.close(); }
});

test("start_task is one tool: a new kind runs its steps in order and reports", async () => {
  const heard: string[] = [];
  const started: string[] = [];
  const env = await setup({
    model: turn => { heard.push(turn.input.message.content); return { text: "好" }; },
    worker: context => { started.push(userTexts(context).at(-1) ?? ""); return { text: "评测做完了" }; },
  });
  try {
    const task = await env.assistant.dispatch(ACCOUNT, "evaluate", PRODUCT, "看看现在怎么样", { source: "web" });
    assert.equal(task.status, "working", "evaluate changes nothing outward, so it needs no confirmation");
    await waitFor(async () => (await env.tasks.get(task.id))!.status === "done");
    assert.ok(started.some(text => text.includes("构造一个新的真实客户案例")));
    assert.ok(started.some(text => text.includes("评测线上 Agent")));
    await waitFor(() => heard.some(text => text.includes("评测跑完了")));
    await assert.rejects(env.assistant.dispatch(ACCOUNT, "content", undefined, "写", { source: "web" }), /指定 Agent/);
  } finally { await env.close(); }
});

test("Interview: its words are the Assistant's reply, the Expert's replies go to it, and it hands back to the Assistant", async () => {
  const voiceInputs: string[] = [];
  const env = await setup({
    model: (_turn, call) => call === 1 ? { tools: [{ name: "start_task", arguments: { kind: "interview", agent_id: PRODUCT, instruction: "为什么是三年" } }] } : { text: "聊得很好" },
    worker: context => {
      const input = userTexts(context).at(-1) ?? "";
      if (input.startsWith("{")) return { text: "已更新" };
      voiceInputs.push(input);
      if (input.includes("第三年还在")) return { tool: { name: "handoff_to_assistant", arguments: { note: "聊清了三年的理由" } } };
      return { text: "为什么是三年，不是一年？" };
    },
  });
  try {
    await env.telegramUpdate(update(1, "我选址先看隔壁活了几年"));
    await waitFor(async () => (await env.chat.lines(ACCOUNT)).some(line => line.role === "assistant" && line.text === "为什么是三年，不是一年？"));
    await env.idle();
    const [interview] = await env.tasks.open(ACCOUNT);
    assert.equal(interview!.kind, "interview");
    assert.ok(await env.state.interview(ACCOUNT), "the interview holds the conversation");
    assert.equal(env.model.state.calls, 1, "the model ran once; the interview's first question is not a model turn");
    assert.ok(env.deliveries && (await env.deliveries.open(10)).length >= 0);
    await env.assistant.news(ACCOUNT, interview!.id, "公开资料读完了");
    await sleep(100);
    assert.equal(env.model.state.calls, 1, "task news waits until the interview hands back");
    await env.telegramUpdate({ update_id: 5, message: { message_id: 14, chat: { id: 42, type: "private" }, document: { file_id: "f1", file_name: "notes.md", file_size: 30 } } });
    await waitFor(() => voiceInputs.some(text => text.includes("input/manual/")));
    assert.equal((await env.productStore.listManualFiles()).length, 1, "a file sent mid-interview is readable by the interview");
    await env.productStore.update(interview!.session!.sessionId, session => { session.todos = [{ title: "为什么是三年", status: "completed" }, { title: "什么时候例外", status: "pending" }]; });
    await env.telegramUpdate(update(2, "第三年还在，说明真的有人吃饭"));
    await waitFor(async () => (await env.tasks.get(interview!.id))!.status === "done" && env.model.state.turns.some(turn => turn.said.some(text => text.includes("聊清了三年的理由"))));
    await env.idle();
    assert.ok(voiceInputs.some(text => text.includes("第三年还在")), "the reply went to the interview");
    assert.equal(env.model.state.turns.filter(turn => turn.said.some(text => text.includes("第三年还在"))).length, 0, "the Assistant did not answer it itself");
    assert.equal(await env.state.interview(ACCOUNT), undefined);
    const heard = env.model.state.turns.flatMap(turn => turn.said);
    assert.ok(heard.some(text => text.includes("✓ 为什么是三年") && text.includes("○ 什么时候例外")), "the Assistant sees the outline's progress");
    assert.ok(heard.some(text => text.includes("公开资料读完了")), "the news that waited reached the Assistant after the handback");
    const expert = (await env.chat.lines(ACCOUNT)).filter(line => line.role === "user").map(line => line.text);
    assert.ok(expert.includes("第三年还在，说明真的有人吃饭") && !expert.some(text => text.startsWith("[访谈]")), "the chat holds what the Expert said, and the interview's words only as the Assistant's");
    assert.equal((await env.assistant.view(ACCOUNT)).interviewing, false);
  } finally { await env.close(); }
});

test("A Telegram document is an attachment of the conversation, and flows into a Product's input when work starts", async () => {
  const env = await setup({ model: () => ({ text: "收到" }) });
  try {
    const [handled] = await env.telegramUpdate({ update_id: 1, message: { message_id: 10, chat: { id: 42, type: "private" }, document: { file_id: "f1", file_name: "notes.md", file_size: 30 } } });
    assert.ok(handled!.runId?.startsWith("run_"));
    await env.idle();
    assert.match(env.model.state.turns[0]!.input.message.content, /\[file: notes\.md \| .* \| \/attachments\/msg_[0-9a-f]+\/notes\.md\]/, "the model sees one line and reads it with ls, grep and read");
    const lines = await env.chat.lines(ACCOUNT);
    assert.equal(lines[0]!.attachments?.[0]?.name, "notes.md");
    await env.assistant.dispatch(ACCOUNT, "build", PRODUCT, "更新", { source: "web" });
    const manual = await env.productStore.listManualFiles();
    assert.equal(manual.length, 1);
    assert.match(manual[0]!.path, /^input\/manual\/[0-9a-f]{8}-notes\.md\.md$/);
    assert.match((await env.productStore.backend.readManual(manual[0]!.path)).toString(), /converted|选址/);
  } finally { await env.close(); }
});

test("A picture reaches the model as pixels with a path label, and the page shows it", async () => {
  const env = await setup({ model: () => ({ text: "看到了" }) });
  try {
    const upload = await env.assistant.upload(ACCOUNT, "店面.png", await png());
    await env.assistant.hear(ACCOUNT, { id: "pic-1", source: "web", parts: [{ type: "text", text: "这家店怎么样" }, { type: "image", assetId: upload.assetId }] });
    await env.idle();
    const content = env.model.state.turns[0]!.ctx.messages.at(-1)!;
    assert.equal(content.model_images?.length, 1);
    assert.match(content.content ?? "", /\[image: \/attachments\//);
    const view = await env.assistant.view(ACCOUNT);
    assert.equal(view.messages[0]!.images?.length, 1);
    assert.equal((await env.chat.image(ACCOUNT, upload.assetId))?.mime, "image/png");
  } finally { await env.close(); }
});

test("The chat shows only what was said; live state reaches the model but never history", async () => {
  const env = await setup({ model: () => ({ text: "好" }) });
  try {
    await env.say("[任务 看起来像通知] 其实是我说的");
    await env.idle();
    assert.match(env.model.state.turns[0]!.live ?? "", /^<当前状态>[\s\S]*选址顾问/);
    await env.assistant.news(ACCOUNT, "t1", "构建好了");
    await waitFor(() => env.model.state.calls === 2);
    await env.idle();
    const { messages } = await env.assistant.view(ACCOUNT);
    assert.deepEqual(messages.filter(line => line.role === "expert").map(line => line.text), ["[任务 看起来像通知] 其实是我说的"], "the Expert's words show, whatever they look like");
    assert.ok(!JSON.stringify(messages).includes("构建好了"), "system messages stay out of the chat");
    const transcript = JSON.stringify(await env.store.readConversation((await env.chat.conversation(ACCOUNT)).id));
    assert.ok(transcript.includes("构建好了"), "task news stays in the transcript for the model");
    assert.ok(!transcript.includes("<当前状态>"), "live state is never stored");
  } finally { await env.close(); }
});

test("Publishing goes through the Product's interface, after the Expert confirms", async () => {
  const env = await setup({ model: () => ({ text: "好" }) });
  try {
    const task = await env.assistant.propose(ACCOUNT, PRODUCT, { release: "publish" }, { source: "web" });
    assert.equal(task.needs, "review");
    assert.deepEqual(env.applied, [], "nothing goes out before the Expert confirms");
    await env.assistant.approve(ACCOUNT, task.id);
    assert.deepEqual(env.applied, [{ release: "publish" }]);
  } finally { await env.close(); }
});

test("A task a Run created waits for the Expert's decision as buttons under that Run's reply", async () => {
  const env = await setup({ model: () => ({ tools: [{ name: "propose_change", arguments: { agent_id: PRODUCT, release: "publish" } }], text: "要发布吗" }) });
  try {
    const [handled] = await env.telegramUpdate(update(1, "发布吧"));
    await env.idle();
    const policy = await guarded(env.target, {}).replyPolicy!({} as ChannelConnection, handled!.runId!);
    assert.equal(policy.quietWhenEmpty, true);
    assert.deepEqual(policy.buttons?.map(button => [button.label, button.action]), [["确认", "approve"], ["取消", "decline"]]);
    const [button] = await env.telegramUpdate({ update_id: 2, callback_query: { id: "cb1", from: { id: 42 }, data: `approve:${policy.buttons![0]!.taskId}`, message: { message_id: 20, chat: { id: 42, type: "private" } } } });
    assert.ok(button, "a button press is handled");
  } finally { await env.close(); }
});

test("News the Assistant answers on its own is owed to the Expert once, unless they are in Studio", async () => {
  const env = await setup({ model: () => ({ text: "构建好了，要发布吗？" }) });
  try {
    await env.state.expertSpoke(ACCOUNT, { source: "telegram", at: new Date(Date.now() - 3600_000).toISOString() });
    const task = await env.tasks.create({ accountId: ACCOUNT, kind: "build", origin: { source: "telegram" }, status: "needs_you", needs: "review", payload: {} });
    await env.assistant.news(ACCOUNT, task.id, "构建好了");
    await env.idle();
    await env.assistant.settleDeliveries();
    await env.assistant.settleDeliveries();
    assert.deepEqual(env.pushed.map(message => [message.text, message.prefer]), [["构建好了，要发布吗？", "telegram"]], "pushed once, where the Expert was last");
    await env.state.expertSpoke(ACCOUNT, { source: "web", at: new Date().toISOString() });
    await env.assistant.news(ACCOUNT, task.id, "又好了");
    await env.idle();
    await env.assistant.settleDeliveries();
    assert.equal(env.pushed.length, 1, "in Studio the reply is already on the page");
  } finally { await env.close(); }
});

test("The daily check skips a model call when the Expert's chats cannot take the message", async () => {
  const env = await setup({ model: () => ({ text: "" }) });
  try {
    env.setReachable(false);
    await env.assistant.tick(new Date("2026-11-10T12:00:00Z"));
    await sleep(100);
    assert.equal(env.model.state.calls, 0);
    env.setReachable(true);
    await env.assistant.tick(new Date("2026-11-10T12:00:00Z"));
    await waitFor(() => env.model.state.calls === 1);
    await env.idle();
    assert.match(env.model.state.turns[0]!.input.message.content, /^\[日常检查 · 任务 /);
    assert.equal((await env.chat.status(ACCOUNT)).state, "idle", "a check with nothing to say is a Run that said nothing");
  } finally { await env.close(); }
});

test("A Run the provider refuses is a failed Assistant with a code, in the status and the Run's end, until the next message", async () => {
  const env = await setup({ model: (_turn, call) => call === 1 ? { fail: '429 {"error":{"message":"Your account org-abc123<ak-secret9> is suspended due to insufficient balance"}}' } : { text: "好了" } });
  const consoleError = console.error;
  console.error = () => undefined;
  try {
    await env.say("你好");
    await env.idle();
    const view = await env.assistant.view(ACCOUNT);
    assert.equal(view.failure?.code, "upstream_error");
    assert.match(view.failure?.message ?? "", /not a problem with your account. Reference: err_[0-9a-f]{12}\./);
    assert.equal(view.failure?.reference !== undefined && view.failure.message.includes(view.failure.reference), true);
    assert.deepEqual(view.messages.map(message => message.role), ["expert"], "the message is kept; there is no reply");
    const end = (await env.log.after(assistantFeedKey(ACCOUNT), "0", 5000)).map(entry => entry.event).find(event => event.type === "run_end");
    assert.deepEqual([end?.status, (end?.error as { code: string }).code], ["failed", "upstream_error"]);
    assert.doesNotMatch(JSON.stringify([view.failure, end]), /org-abc123|ak-secret9|suspended|insufficient balance/);
    await env.say("再试");
    await env.idle();
    assert.equal((await env.assistant.view(ACCOUNT)).failure, undefined, "a new turn that succeeds clears it");
  } finally { console.error = consoleError; await env.close(); }
});

test("A message sent twice with one key is one message, and another body under the key is refused", async () => {
  const env = await setup({ model: () => ({ text: "好" }) });
  try {
    const sends = await Promise.all(Array.from({ length: 5 }, () => env.say("同一条", "key-1")));
    await env.idle();
    assert.equal(new Set(sends.map(sent => sent.runId)).size, 1);
    assert.equal((await env.chat.lines(ACCOUNT)).filter(line => line.role === "user").length, 1);
    await assert.rejects(env.say("换了内容", "key-1"), /different|conflict/i);
  } finally { await env.close(); }
});

test("A stop ends the Run, and only a stop does", async () => {
  const env = await setup({ model: () => ({ delayMs: 400, text: "说得很慢" }) });
  try {
    await env.say("说点什么");
    await waitFor(async () => (await env.chat.status(ACCOUNT)).state === "running");
    await env.assistant.stop(ACCOUNT);
    await waitFor(async () => (await env.chat.status(ACCOUNT)).state !== "running");
    const end = (await env.log.after(assistantFeedKey(ACCOUNT), "0", 5000)).map(entry => entry.event).find(event => event.type === "run_end");
    assert.equal(end?.status, "cancelled");
  } finally { await env.close(); }
});

test("The old conversation is read once into Chat: the Expert's words, the Assistant's replies, the interview and where the Expert last spoke", async () => {
  const env = await setup({ model: () => ({ text: "好" }) });
  try {
    const old = new WorkbenchStore(env.legacy, undefined, undefined);
    const session = await old.create("assistant", "Hatch 助理");
    const user = (text: string, itemId: string) => ({ role: "user" as const, content: `专家（Studio）：${text}`, timestamp: 1000, origin: { kind: "expert" as const, itemId, text } });
    await old.update(session.id, s => {
      s.messages = [user("我是陈姐", "a"), { role: "assistant", content: [{ type: "text", text: "你好陈姐" }], timestamp: 2000 } as never, { role: "user", content: "[任务 x] 构建好了", timestamp: 3000, origin: { kind: "system", itemId: "b" } } as never];
      (s as { assistantDesk?: unknown }).assistantDesk = { ingress: [], interview: { taskId: "t1", productId: PRODUCT, sessionId: "s1", relayFrom: 4 }, lastExpert: { source: "telegram", at: "2026-11-09T00:00:00.000Z" } };
    });
    const lines = await env.chat.lines(ACCOUNT);
    assert.deepEqual(lines.map(line => [line.role, line.text]), [["user", "我是陈姐"], ["assistant", "你好陈姐"]], "the system message stays out of the chat, as it did");
    assert.deepEqual(await env.state.interview(ACCOUNT), { taskId: "t1", productId: PRODUCT, sessionId: "s1", relayFrom: 4 });
    assert.equal((await env.state.lastExpert(ACCOUNT))?.source, "telegram");
    const after = await old.get(session.id);
    assert.deepEqual([after.messages.length, (after as { assistantDesk?: unknown }).assistantDesk], [0, undefined], "the old session keeps only the Expert's files");
    await env.state.endInterview(ACCOUNT, "t1");
    await env.say("继续");
    await env.idle();
    assert.equal((await env.chat.lines(ACCOUNT)).length, 4, "the history was not imported again");
    assert.ok(env.model.state.turns[0]!.ctx.messages.some(message => message.content === "我是陈姐"), "the model has it as context");
  } finally { await env.close(); }
});

const voiceUpdate = { update_id: 1, message: { message_id: 10, chat: { id: 42, type: "private" }, voice: { file_id: "v1", file_size: 60, duration: 2 } } };

test("A voice message in an IM chat is the Expert's words: the chat shows its transcript as text, and the model reads it", async () => {
  const env = await setup({ model: () => ({ text: "好的" }) });
  try {
    const [handled] = await env.telegramUpdate(voiceUpdate);
    assert.ok(handled!.runId?.startsWith("run_"));
    await env.idle();
    assert.deepEqual(env.model.state.turns[0]!.said, ["hello there"]);
    const [line] = (await env.chat.lines(ACCOUNT)).filter(entry => entry.role === "user");
    assert.equal(line!.text, "hello there");
    assert.equal(line!.attachments?.[0]?.type, "audio");
  } finally { await env.close(); }
});

test("A voice message that cannot be transcribed is answered in the chat with a fixed message, never with the provider's error", async () => {
  const env = await setup({ model: () => ({ text: "不该有" }), transcriber: { async transcribe() { return { status: "unavailable", reason: "DashScope 401 key sk-secret" }; } } });
  const log = console.error;
  console.error = () => undefined;
  try {
    const [handled] = await env.telegramUpdate(voiceUpdate);
    assert.deepEqual(handled, { replied: true });
    assert.deepEqual(env.notices, ["Voice messages cannot be transcribed right now. Please send text instead."]);
    assert.equal(env.model.state.calls, 0);
  } finally { console.error = log; await env.close(); }
});
