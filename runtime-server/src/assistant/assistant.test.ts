import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { harness, png } from "../assets/kit.test.js";
import { AttachmentFiles } from "../assets/files.js";
import type { AgentRuntime, RunContext } from "../agentRuntime.js";
import type { ConversationMessage, OutboundMessage, RunStart } from "../protocol.js";
import { RuntimeAssetStore } from "../assetStore.js";
import { ChatAssets } from "../chat/assets.js";
import { attachmentToolDefinitions } from "../chat/attachmentTools.js";
import { createFactoryLlmModel, type FactoryPiAgentOptions } from "../creatorLearning/factoryPi.js";
import { UpstreamError } from "../errors/upstream.js";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { FileWorkbenchBackend, WorkbenchStore } from "../factoryAgents/store.js";
import { WorkbenchRuntime } from "../factoryAgents/runtime.js";
import type { FactoryWorkspace } from "../factoryAgents/service.js";
import { RuntimeStore, localRuntimeAuthority } from "../store.js";
import { toolRegistry } from "../tools.js";
import { MemoryAgentDefinitionRepository, initialAgentDefinitions } from "../factoryAgents/definitions.js";
import { AssistantService, type AssistantIngest, type ProductWorkspaces } from "./assistant.js";
import { AssistantChat } from "./chat.js";
import { MemoryDeliveries } from "./deliveries.js";
import { LegacyAssistantHistory } from "./history.js";
import { ExpertMaterials } from "./materials.js";
import type { AccountReach } from "./reach.js";
import { MemoryAssistantState } from "./state.js";
import { assistantFeedKey } from "./studioVocabulary.js";
import { messageKey } from "../chat/messageKey.js";
import { studioToolDefinitions, studioTools } from "./studioTools.js";
import { ChatFlow } from "../channels/chatTarget.js";
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
type Turn = { input: RunStart; ctx: RunContext; /** Everything the Expert said in this turn, in order. */ said: string[]; /** What the Run claimed after it began: the messages the model reads next. */ claimed: ConversationMessage[]; live: string | undefined };

/** Automated test double for the model: the Assistant's runtime, scripted, with the tools called as the real one calls them. */
function scriptedModel(script: (turn: Turn, call: number) => Step | Promise<Step>) {
  const state = { calls: 0, turns: [] as Turn[] };
  const runtime: AgentRuntime = {
    async *run(input, ctx): AsyncGenerator<OutboundMessage> {
      const call = ++state.calls;
      const turn: Turn = { input, ctx, said: [input.message.content], claimed: [], live: await ctx.liveState?.() };
      state.turns.push(turn);
      const step = await script(turn, call);
      if (step.delayMs) await sleep(step.delayMs);
      for (const [index, tool] of (step.tools ?? []).entries()) {
        await ctx.toolBridge!.execute({ scope: "main", runId: input.run_id, toolCallId: `t${call}-${index}`, name: `studio.${tool.name}`, arguments: tool.arguments, clientTools: ctx.clientTools, state: ctx.state });
      }
      for (let more = await ctx.claimSteered?.(); more?.length; more = await ctx.claimSteered?.()) { turn.claimed.push(...more); turn.said.push(...more.map(message => message.content ?? "")); }
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

async function setup(options: { model: Parameters<typeof scriptedModel>[0]; worker?: Parameters<typeof scriptedWorkers>[0]; legacy?: boolean; live?: unknown; ingest?: AssistantIngest; transcriber?: Parameters<typeof harness>[0] extends infer H ? H extends { transcriber?: infer T } ? T : never : never }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-assistant-"));
  const tasks = new MemoryTaskRepository();
  const state = new MemoryAssistantState();
  const deliveries = new MemoryDeliveries();
  const pushed: Array<{ text: string; key: string | undefined; buttons?: ChannelMessage["buttons"]; prefer?: string }> = [];
  let pushFailures = 0;
  const applied: AgentChange[] = [];
  let reachable = true;
  const reach = { assistantAccounts: async () => [{ accountId: ACCOUNT, timezone: "UTC" }] } as unknown as AccountReach;
  const channels: Pick<AssistantChannels, "push" | "canReach"> = {
    push: async (_account, message, prefer, key) => {
      if (!reachable) return false;
      if (pushFailures-- > 0) throw new Error("channel down");
      // Like the channel layer, a key already queued is queued once.
      if (!key || !pushed.some(sent => sent.key === key)) pushed.push({ text: message.text, key, ...(message.buttons ? { buttons: message.buttons } : {}), ...(prefer ? { prefer } : {}) });
      return true;
    },
    canReach: async () => reachable,
  };
  const telegramCalls: Array<{ method: string; body: any }> = [];
  const telegram = new TelegramChannel({ token: "test", username: "hatch_test_bot", webhookSecret: "secret" }, "", (async (url: string, init?: RequestInit) => {
    if (url.includes("/file/bot")) return new Response(url.endsWith(".oga") ? Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]) : "# 我的选址笔记\n隔壁活过三年才算数\n", { status: 200 });
    if (url.endsWith("/getFile")) return new Response(JSON.stringify({ ok: true, result: { file_path: String(init?.body).includes('"v1"') ? "voice/file_1.oga" : "documents/notes.md" } }), { status: 200 });
    telegramCalls.push({ method: url.split("/").pop()!, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch);
  const productStore = new WorkbenchStore(path.join(root, "product"), { creatorId: ACCOUNT, productId: PRODUCT }, new MemoryAgentDefinitionRepository(await initialAgentDefinitions()));
  let withheldTools: Parameters<ProductWorkspaces["attachAssistant"]>[0]["withheldTools"] | undefined;
  const agentFactory = scriptedWorkers(options.worker ?? (() => ({ text: "完成" })));
  const productRuntime = new WorkbenchRuntime(productStore, { env: { HATCH_FACTORY_LLM_PROFILE: "kimi-k2.6" }, agentFactory, maxTurns: 6, withheldTools: async session => await withheldTools?.({ creatorId: ACCOUNT, productId: PRODUCT }, session) ?? [] });
  const workspace = { store: productStore, runtime: productRuntime } as unknown as FactoryWorkspace;
  let opened: ((scope: { creatorId: string; productId: string }, workspace: FactoryWorkspace) => void) | undefined;
  const catalog: AgentCatalog = {
    list: async () => [{ productId: PRODUCT, name: "选址顾问", promise: "帮餐厅老板选址", status: "published" }],
    get: async (_account, productId) => productId === PRODUCT ? { productId, name: "选址顾问", promise: "帮餐厅老板选址", status: "published" } : undefined,
    create: async () => { throw new Error("unused"); },
    apply: async (_account, _product, change) => { applied.push(change); },
    live: async () => options.live ?? ({ is_live: false, pending_changes: [] }),
    token: async () => "token",
  };
  const legacy = new FileWorkbenchBackend(path.join(root, "assistant"));
  const assistant = new AssistantService({
    tasks, reach, catalog, channels, state, deliveries,
    products: { workspace: async () => { opened?.({ creatorId: ACCOUNT, productId: PRODUCT }, workspace); return workspace; }, attachAssistant: hooks => { opened = hooks.opened; withheldTools = hooks.withheldTools; } },
    backend: () => legacy,
    exclusive: async (_name, fn) => fn(),
    search: { search: async () => { throw new Error("no web search in tests"); } },
    env: { HATCH_FACTORY_LLM_PROFILE: "kimi-k2.6" },
    runtime: { agentFactory },
    ...(options.ingest ? { ingest: options.ingest } : {}),
  });
  const dataDir = path.join(root, "chat");
  const store = new RuntimeStore(dataDir);
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  const kit = await harness({ ...(options.transcriber ? { transcriber: options.transcriber } : {}) });
  const chatAssets = new ChatAssets({ pipeline: kit.pipeline, blobs: kit.blobs, files: new AttachmentFiles(kit.repository, kit.blobs) });
  for (const definition of attachmentToolDefinitions(chatAssets.tools())) toolRegistry.set(definition.name, definition);
  const tools = studioTools(assistant);
  for (const definition of studioToolDefinitions(tools)) toolRegistry.set(definition.name, definition);
  const model = scriptedModel(options.model);
  const chat = new AssistantChat({
    repository, store, chatAssets, state, tools, assetStore: new RuntimeAssetStore(dataDir),
    history: new LegacyAssistantHistory({ backend: () => legacy, state, store }),
    prompt: async () => "你是 Hatch 助理。", liveState: id => assistant.liveState(id), env: {}, createRuntime: () => model.runtime,
    sweepMs: 60_000,
  });
  const materials = new ExpertMaterials({ assets: chatAssets, conversation: id => chat.conversation(id) });
  assistant.bind(chat, materials);
  await chat.start();
  const log = chat.feed;
  const connection: ChannelConnection = { id: "c0000000-0000-4000-8000-000000000001", ownerAccountId: ACCOUNT, channel: "telegram", scope: "", client: "im", target: { kind: "assistant" }, audience: "self", taskSpecific: false, state: "active" };
  const target = new ChatFlow(new AssistantTarget(assistant));
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
    root, tasks, state, deliveries, pushed, notices, log, applied, telegramCalls, telegramUpdate, assistant, chat, target, model, productStore, productRuntime, say, idle, legacy, store, kit, tools, chatAssets, materials,
    setReachable: (value: boolean) => { reachable = value; },
    failPushes: (count: number) => { pushFailures = count; },
    close: async () => { await assistant.close(); await chat.close(); await store.close(); await repository.close(); await productRuntime.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); },
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
    // What the Run says as it goes is live and not recorded; what it did is the journal's.
    const live: string[] = [];
    env.log.live(assistantFeedKey(ACCOUNT), event => { live.push(String(event.type)); });
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
    const recorded = await env.log.after(assistantFeedKey(ACCOUNT), "0", 5000);
    const kinds = recorded.map(entry => entry.event.type);
    assert.ok(live.includes("delta") && kinds.includes("message_end") && kinds.includes("run_end"), "Studio observers see the Run like a worker's");
    assert.ok(recorded.every(entry => typeof entry.event.run_id === "string"), "every event names its Run");
    assert.equal(recorded.filter(entry => entry.event.type === "message").length, 3, "each message is an event, and names itself");
    assert.ok(recorded.filter(entry => entry.event.type === "message" || entry.event.type === "message_end").every(entry => typeof entry.event.message_id === "string"));
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
    await env.productStore.update((await env.productStore.create("voice")).id, session => { session.todos = [{ title: "选址的判断", status: "completed" }]; });
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

test("Interview is an ordinary worker: it writes the outline on the Product's session and reports, the conversation stays with the Assistant, and build waits for every item to be ticked", async () => {
  const voiceInputs: string[] = [];
  const env = await setup({
    model: (_turn, call) => call === 1 ? { tools: [{ name: "start_task", arguments: { kind: "interview", agent_id: PRODUCT, instruction: "为什么是三年" } }] } : { text: "第一个问题：你怎么选址？" },
    worker: context => {
      const input = userTexts(context).at(-1) ?? "";
      if (input.startsWith("{")) return { text: "已更新" };
      voiceInputs.push(input);
      if (context.messages.some(message => message.role === "toolResult")) return { text: "大纲写好了" };
      return { tool: { name: "update_todo", arguments: { todos: [{ title: "技能·选址：例子、规则、例外、触发", status: "pending" }, { title: "底线：不答什么", status: "pending" }] } } };
    },
  });
  try {
    await env.telegramUpdate(update(1, "我选址先看隔壁活了几年"));
    await waitFor(async () => env.model.state.turns.some(turn => turn.said.some(text => text.includes("访谈大纲写好了"))));
    await env.idle();
    assert.match(voiceInputs[0]!, /^\[Hatch 助理请你写访谈大纲\]/, "the worker is told it was dispatched by the Assistant");
    const outline = env.model.state.turns.flatMap(turn => turn.said).find(text => text.includes("访谈大纲写好了"))!;
    assert.match(outline, /○ 技能·选址.*\n○ 底线/, "the Assistant hears the outline");
    assert.equal((await env.productStore.list()).find(session => session.role === "voice")!.assistantTaskId, undefined, "the dispatch mark is cleared when the worker is done");
    assert.equal((await env.chat.lines(ACCOUNT)).filter(line => line.role === "assistant").some(line => line.text.startsWith("[访谈]")), false);

    // The Expert's next message goes to the Assistant's model, not to the worker.
    const calls = env.model.state.calls;
    await env.say("三年还在，说明真有人吃饭");
    await env.idle();
    assert.equal(env.model.state.calls, calls + 1);
    assert.ok(env.model.state.turns.at(-1)!.said.includes("三年还在，说明真有人吃饭"));
    assert.equal(voiceInputs.some(text => text.includes("三年还在")), false, "the worker heard nothing of it");

    const build = () => callTool(env, "start_task", { kind: "build", agent_id: PRODUCT, instruction: "构建" });
    await assert.rejects(build(), /还有没聊完的：技能·选址.*、底线/);
    await assert.rejects(callTool(env, "tick_outline", { item: "不存在的项" }), /大纲里没有这一项/);
    await callTool(env, "tick_outline", { item: "技能·选址" });
    await assert.rejects(build(), /还有没聊完的：底线：不答什么/);
    await callTool(env, "tick_outline", { item: "底线" });
    assert.deepEqual((await env.productStore.list()).find(session => session.role === "voice")!.todos.map(todo => todo.status), ["completed", "completed"]);
    await build();
  } finally { await env.close(); }
});

test("A Telegram document is an attachment of the conversation; starting work copies none of it into a Product's input, only add_to_agent does", async () => {
  const env = await setup({ model: (turn, call) => call === 1 ? { tools: [{ name: "add_to_agent", arguments: { files: [sentPath(turn)] } }], text: "记下了" } : { text: "收到" } });
  try {
    const send = (updateId: number, messageId: number, name: string) => env.telegramUpdate({ update_id: updateId, message: { message_id: messageId, chat: { id: 42, type: "private" }, document: { file_id: "f1", file_name: name, file_size: 30 } } });
    const [handled] = await send(1, 10, "notes.md");
    assert.ok(handled!.runId?.startsWith("run_"));
    await env.idle();
    assert.match(env.model.state.turns[0]!.input.message.content, /\[file: notes\.md \| .* \| \/attachments\/msg_[0-9a-f]+\/notes\.md\]/, "the model sees one line and reads it with ls, grep and read");
    const lines = await env.chat.lines(ACCOUNT);
    assert.equal(lines[0]!.attachments?.[0]?.name, "notes.md");
    await send(2, 11, "other.md");
    await env.idle();
    await env.assistant.dispatch(ACCOUNT, "build", PRODUCT, "更新", { source: "web" });
    const manual = await env.productStore.listManualFiles();
    assert.equal(manual.length, 1, "the file nobody added did not appear");
    assert.match(manual[0]!.path, /^input\/manual\/[0-9a-f]{8}-notes\.md\.md$/);
    assert.match((await env.productStore.backend.readManual(manual[0]!.path)).toString(), /converted|选址/);
  } finally { await env.close(); }
});

test("The same Telegram document sent twice is two messages that both carry it, never a refusal", async () => {
  const env = await setup({ model: () => ({ text: "收到" }) });
  try {
    const send = (updateId: number, messageId: number) => env.telegramUpdate({ update_id: updateId, message: { message_id: messageId, chat: { id: 42, type: "private" }, document: { file_id: "f1", file_name: "notes.md", file_size: 30 } } });
    const [first] = await send(1, 10);
    await env.idle();
    const [second] = await send(2, 11);
    await env.idle();
    assert.ok(first!.runId?.startsWith("run_") && second!.runId?.startsWith("run_"), "each message started a Run");
    assert.deepEqual(env.notices, [], "nothing was refused");
    const experts = (await env.chat.lines(ACCOUNT)).filter(line => line.role === "user");
    assert.deepEqual(experts.map(line => line.attachments?.[0]?.name), ["notes.md", "notes.md"]);
  } finally { await env.close(); }
});

test("Rapid sends into a running reply store one message per id, however often an id is sent", async () => {
  const env = await setup({ model: (_turn, call) => call === 1 ? { delayMs: 300, text: "好" } : { text: "不该再有一轮" } });
  try {
    const send = (id: string, text: string) => env.assistant.hear(ACCOUNT, { id, source: "web", parts: [{ type: "text", text }] });
    await send("m-1", "第一句");
    await Promise.all([send("m-2", "他对我的影响很大"), send("m-2", "他对我的影响很大"), send("m-2", "他对我的影响很大"), send("m-3", "另一句"), send("m-3", "另一句")]);
    await send("m-2", "他对我的影响很大");
    await env.idle();
    const said = (await env.chat.lines(ACCOUNT)).filter(line => line.role === "user");
    assert.deepEqual(said.map(line => [line.id, line.text]), [["m-1", "第一句"], ["m-2", "他对我的影响很大"], ["m-3", "另一句"]]);
  } finally { await env.close(); }
});

test("Text and a file are one message; the model reads the file line and history shows only what was typed, with the file as an attachment", async () => {
  const env = await setup({ model: () => ({ text: "看了" }) });
  try {
    const upload = await env.assistant.upload(ACCOUNT, "notes.md", Buffer.from("# 笔记\n选址很重要"));
    await env.assistant.hear(ACCOUNT, { id: "one-1", source: "web", parts: [{ type: "text", text: "你看看" }, { type: "file", assetId: upload.assetId }] });
    await env.idle();
    assert.equal(env.model.state.calls, 1, "one message, one Run");
    assert.match(env.model.state.turns[0]!.input.message.content, /^你看看\n\[file: notes\.md/, "the model reads the text and the file line");
    const experts = (await env.chat.lines(ACCOUNT)).filter(line => line.role === "user");
    assert.equal(experts.length, 1);
    assert.equal(experts[0]!.text, "你看看", "history keeps what was typed");
    assert.deepEqual(experts[0]!.attachments?.map(({ type, name }) => ({ type, name })), [{ type: "file", name: "notes.md" }]);
    assert.ok((experts[0]!.attachments?.[0]?.bytes ?? 0) > 0);
    assert.doesNotMatch(JSON.stringify(await env.assistant.view(ACCOUNT)), /\[file:/);
  } finally { await env.close(); }
});

const sentPath = (turn: { input: RunStart }) => turn.input.message.content.match(/\/attachments\/[^\s\]|]+/)![0];
const studioTool = (env: { tools: ReturnType<typeof studioTools> }, name: string) => env.tools.find(tool => tool.name === name)!;
const callTool = (env: { tools: ReturnType<typeof studioTools> }, name: string, args: Record<string, unknown>) => { const tool = studioTool(env, name); return tool.run({ accountId: ACCOUNT, runId: "r", origin: async () => ({ source: "web" }) }, tool.schema.parse(args)); };

const ingestRecorder = () => {
  const submitted: Array<{ productId: string; items: unknown; context?: string }> = [];
  const ingest: AssistantIngest = { submit: async (_account, productId, items, context) => { submitted.push({ productId, items, context }); return { id: "job-1", status: "queued" }; } };
  return { submitted, ingest };
};
const PDF = Buffer.from("%PDF-1.4 选址清单");

test("add_to_agent: plain text is written into the manual input by its form; an unknown path is refused", async () => {
  const env = await setup({ model: turn => ({ tools: [{ name: "add_to_agent", arguments: { files: [sentPath(turn)] } }], text: "记下了" }) });
  try {
    const upload = await env.assistant.upload(ACCOUNT, "notes.md", Buffer.from("# 笔记\n选址很重要"));
    await env.assistant.hear(ACCOUNT, { id: "add-1", source: "web", parts: [{ type: "text", text: "放进资料" }, { type: "file", assetId: upload.assetId }] });
    await env.idle();
    const [manual] = await env.productStore.backend.listManual();
    assert.match(manual!.path, /notes\.md\.md$/);
    assert.match((await env.productStore.backend.readManual(manual!.path)).toString(), /选址很重要/);
    await assert.rejects(callTool(env, "add_to_agent", { files: ["/attachments/none/x.md"] }), /专家没有发过这个文件：\/attachments\/none\/x\.md.*notes\.md/);
    await assert.rejects(callTool(env, "add_to_agent", {}), /至少要给一个/);
  } finally { await env.close(); }
});

test("add_to_agent: a PDF goes to Ingest with its original bytes, never into the manual input", async () => {
  const { submitted, ingest } = ingestRecorder();
  const env = await setup({ ingest, model: turn => ({ tools: [{ name: "add_to_agent", arguments: { files: [sentPath(turn)], context: "选址清单" } }], text: "交给整理了" }) });
  try {
    const upload = await env.assistant.upload(ACCOUNT, "list.pdf", PDF);
    await env.assistant.hear(ACCOUNT, { id: "pdf-1", source: "web", parts: [{ type: "text", text: "这是我的清单" }, { type: "file", assetId: upload.assetId }] });
    await env.idle();
    assert.deepEqual(submitted, [{ productId: PRODUCT, context: "选址清单", items: [{ name: "list.pdf", content_base64: PDF.toString("base64"), media_type: "application/pdf" }] }]);
    assert.equal((await env.productStore.backend.listManual()).length, 0);
  } finally { await env.close(); }
});

for (const [label, name, bytes, mediaType] of [
  ["a zip", "资料.zip", Buffer.from(zipSync({ "a.txt": new Uint8Array([65]) })), "application/zip"],
  ["an unknown binary", "data.bin", Buffer.from([0, 1, 2, 3, 0, 0xff, 0xfe]), "application/octet-stream"],
] as const) {
  test(`add_to_agent: ${label} is an attachment the Assistant sees, and goes to Ingest with its original bytes`, async () => {
    const { submitted, ingest } = ingestRecorder();
    const env = await setup({ ingest, model: turn => ({ tools: [{ name: "add_to_agent", arguments: { files: [sentPath(turn)] } }], text: "交给整理了" }) });
    try {
      const upload = await env.assistant.upload(ACCOUNT, name, bytes);
      await env.assistant.hear(ACCOUNT, { id: `bin-${name}`, source: "web", parts: [{ type: "text", text: "这个也是资料" }, { type: "file", assetId: upload.assetId }] });
      await env.idle();
      assert.deepEqual(submitted, [{ productId: PRODUCT, context: undefined, items: [{ name, content_base64: bytes.toString("base64"), media_type: mediaType }] }]);
      assert.equal((await env.productStore.backend.listManual()).length, 0);
    } finally { await env.close(); }
  });
}

test("add_to_agent: links go to Ingest; a mixed call writes the text now and submits one job for the rest", async () => {
  const { submitted, ingest } = ingestRecorder();
  const env = await setup({ ingest, model: () => ({ text: "" }) });
  try {
    const text = await env.assistant.upload(ACCOUNT, "notes.md", Buffer.from("# 笔记\n选址很重要"));
    const pdf = await env.assistant.upload(ACCOUNT, "list.pdf", PDF);
    await env.assistant.hear(ACCOUNT, { id: "mix-1", source: "web", parts: [{ type: "file", assetId: text.assetId }, { type: "file", assetId: pdf.assetId }] });
    await env.idle();
    const paths = (await env.materials.list(ACCOUNT)).map(material => material.chatPath);
    const result = await callTool(env, "add_to_agent", { files: paths, links: ["https://example.com/a"] });
    assert.equal(submitted.length, 1, "one job for everything that goes to Ingest");
    assert.deepEqual((submitted[0]!.items as unknown[]).length, 2);
    const went = (JSON.parse(String(result.output)) as { went: string[] }).went;
    assert.equal(went.length, 3);
    assert.ok(went.some(line => /notes\.md → input\/manual\/.*notes\.md\.md$/.test(line)));
    assert.ok(went.filter(line => line.includes("ingest job job-1，整理好会放进 input/manual")).length === 2);
    assert.equal((await env.productStore.backend.listManual()).length, 1);
  } finally { await env.close(); }
});

test("add_to_agent: without Ingest a call with a non-text item is refused whole, and the text half is not written", async () => {
  const env = await setup({ model: () => ({ text: "" }) });
  try {
    const text = await env.assistant.upload(ACCOUNT, "notes.md", Buffer.from("# 笔记"));
    const pdf = await env.assistant.upload(ACCOUNT, "list.pdf", PDF);
    await env.assistant.hear(ACCOUNT, { id: "bare-1", source: "web", parts: [{ type: "file", assetId: text.assetId }, { type: "file", assetId: pdf.assetId }] });
    await env.idle();
    const paths = (await env.materials.list(ACCOUNT)).map(material => material.chatPath);
    await assert.rejects(callTool(env, "add_to_agent", { files: paths }), /Ingest 没有配置，收不了：.*list\.pdf.*什么都没有加进资料/);
    await assert.rejects(callTool(env, "add_to_agent", { links: ["https://example.com/a"] }), /Ingest 没有配置/);
    assert.equal((await env.productStore.backend.listManual()).length, 0);
    await callTool(env, "add_to_agent", { files: paths.filter(path => path.endsWith("notes.md")) });
    assert.equal((await env.productStore.backend.listManual()).length, 1, "plain text alone needs no Ingest");
  } finally { await env.close(); }
});

test("A settled Ingest job reaches the Assistant once, with what came of each item", async () => {
  const env = await setup({ model: () => ({ text: "资料好了" }) });
  try {
    const job = { id: "job-9", accountId: ACCOUNT, productId: PRODUCT, status: "done" as const, context: "", createdAt: "", updatedAt: "", items: [
      { id: "i1", input: { name: "deck.pdf", bytes: 10 }, status: "ok" as const, markdown_path: "input/manual/deck.md" },
      { id: "i2", input: { url: "https://example.com/a" }, status: "failed" as const, error: "页面打不开" },
    ] };
    await env.assistant.ingested(job);
    await env.assistant.ingested(job);
    await env.idle();
    const heard = env.model.state.turns.flatMap(turn => turn.said).filter(text => text.includes("[资料 job-9"));
    assert.equal(heard.length, 1, "the same job is heard once");
    assert.match(heard[0]!, /deck\.pdf：已放进 input\/manual\/deck\.md/);
    assert.match(heard[0]!, /https:\/\/example\.com\/a：没成，页面打不开/);
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

test("A picture sent while the Assistant works reaches the model as pixels", async () => {
  const env = await setup({ model: (_turn, call) => call === 1 ? { delayMs: 300, text: "看到了" } : { text: "不该再有一轮" } });
  try {
    await env.say("先说一句");
    await waitFor(async () => (await env.chat.status(ACCOUNT)).state === "running");
    const upload = await env.assistant.upload(ACCOUNT, "店面.png", await png());
    await env.assistant.hear(ACCOUNT, { id: "pic-late", source: "web", parts: [{ type: "text", text: "这家店怎么样" }, { type: "image", assetId: upload.assetId }] });
    await env.idle();
    const claimed = env.model.state.turns[0]!.claimed;
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.model_images?.length, 1);
    assert.match(claimed[0]!.content ?? "", /\[image: \/attachments\//);
    const history = await env.store.readConversation((await env.chat.conversation(ACCOUNT)).id);
    assert.equal(history.find(message => message.content?.startsWith("这家店怎么样"))?.model_images?.length, 1);
  } finally { await env.close(); }
});

test("The chat shows only what was said; live state reaches the model but never history", async () => {
  const env = await setup({ model: () => ({ text: "好" }) });
  try {
    await env.say("[任务 看起来像通知] 其实是我说的");
    await env.idle();
    assert.match(env.model.state.turns[0]!.live ?? "", /^<当前状态>[\s\S]*选址顾问/);
    await env.assistant.news(ACCOUNT, "t1", "构建好了", "finished");
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

test("Live state gives links only for a live Product, with its own bot when it has one", async () => {
  const links = { public_url: "https://hatch.test/products/p1", chat_url: "https://hatch.test/chat/product/p1" };
  const live = await setup({ model: () => ({ text: "好" }), live: { is_live: true, pending_changes: [], ...links, telegram_url: "https://t.me/essay_bot" } });
  const draft = await setup({ model: () => ({ text: "好" }), live: { is_live: false, pending_changes: [], public_url: null, chat_url: null } });
  try {
    assert.match(await live.assistant.liveState(ACCOUNT), /在线[\s\S]*https:\/\/hatch\.test\/products\/p1[\s\S]*https:\/\/hatch\.test\/chat\/product\/p1[\s\S]*https:\/\/t\.me\/essay_bot/);
    const unpublished = await draft.assistant.liveState(ACCOUNT);
    assert.ok(unpublished.includes("未上线") && !unpublished.includes("http"), "no links before publish");
  } finally { await live.close(); await draft.close(); }
});

test("Publishing goes through the Product's interface, after the Expert confirms", async () => {
  const env = await setup({ model: () => ({ text: "好" }) });
  try {
    const task = await env.assistant.propose(ACCOUNT, PRODUCT, { release: "publish" }, { source: "web" });
    assert.equal(task.needs, "review");
    assert.deepEqual(env.applied, [], "nothing goes out before the Expert confirms");
    await env.assistant.approve(ACCOUNT, task.id, "page-click-1");
    assert.deepEqual(env.applied, [{ release: "publish" }]);
  } finally { await env.close(); }
});

test("A button pressed, delivered again or pressed twice decides the task once, before the Assistant hears of it; the other button afterwards is refused and said", async () => {
  const env = await setup({ model: () => ({ text: "好" }) });
  try {
    const task = await env.assistant.propose(ACCOUNT, PRODUCT, { release: "publish" }, { source: "telegram" });
    const press = (id: number, action: string) => ({ update_id: id, callback_query: { id: `cb${id}`, from: { id: 42 }, data: `t:${task.id}:${action}`, message: { message_id: 20, chat: { id: 42, type: "private" } } } });
    const hear = env.assistant.hear.bind(env.assistant);
    const decidedWhenHeard: Array<string | undefined> = [];
    env.assistant.hear = async (account, input) => { decidedWhenHeard.push((await env.tasks.get(task.id))?.decision?.action); return hear(account, input); };
    const [first] = await env.telegramUpdate(press(2, "approve"));
    await env.idle();
    assert.deepEqual(decidedWhenHeard, ["approve"], "no Run started before the task was decided");
    assert.deepEqual(await env.telegramUpdate(press(2, "approve")), [first], "the update delivered again gets the same reply");
    await env.telegramUpdate(press(3, "approve"));
    await env.telegramUpdate(press(4, "decline"));
    await env.idle();
    assert.deepEqual(env.applied, [{ release: "publish" }], "the storefront changed once");
    const stored = (await env.tasks.get(task.id))!;
    assert.deepEqual([stored.status, stored.decision?.action, stored.decision?.key], ["done", "approve", "telegram::2"]);
    assert.deepEqual(env.telegramCalls.filter(call => call.method === "answerCallbackQuery").map(call => call.body.text), ["好", "好", "好", "这件事已确认了，不能再取消"]);
    assert.ok(env.model.state.turns.some(turn => turn.said.some(text => /没有生效：这件事已确认了，不能再取消/.test(text))), "the Assistant is told the decline did not take");
  } finally { await env.close(); }
});

test("The page's approve and decline are the same decision: a click retried or the other button afterwards changes nothing, and the Assistant hears the decision once", async () => {
  const env = await setup({ model: () => ({ text: "好" }) });
  try {
    const task = await env.assistant.propose(ACCOUNT, PRODUCT, { release: "publish" }, { source: "web" });
    const click = async (action: "approve" | "decline", key: string) => {
      const { task: decided } = await env.assistant.decide(ACCOUNT, task.id, action, key);
      await env.assistant.news(ACCOUNT, decided.id, "专家在 Studio 里确认了这件事。", "decided");
    };
    await click("approve", "click-1");
    await click("approve", "click-1");
    await click("approve", "click-2");
    await assert.rejects(click("decline", "click-3"), /已确认了，不能再取消/);
    await env.idle();
    assert.deepEqual(env.applied, [{ release: "publish" }]);
    assert.equal(env.model.state.calls, 1, "the Assistant heard one decision");
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
    await env.assistant.news(ACCOUNT, task.id, "构建好了", "finished");
    await env.idle();
    await env.assistant.settleDeliveries();
    await env.assistant.settleDeliveries();
    assert.deepEqual(env.pushed.map(message => [message.text, message.prefer]), [["构建好了，要发布吗？", "telegram"]], "pushed once, where the Expert was last");
    await env.state.expertSpoke(ACCOUNT, { source: "web", at: new Date().toISOString() });
    await env.assistant.news(ACCOUNT, task.id, "又好了", "finished-again");
    await env.idle();
    await env.assistant.settleDeliveries();
    assert.equal(env.pushed.length, 1, "in Studio the reply is already on the page");
  } finally { await env.close(); }
});

test("A reply no chat could take yet, or that the channel failed to queue, stays owed and goes out once", async () => {
  const env = await setup({ model: () => ({ text: "构建好了，要发布吗？" }) });
  const consoleError = console.error;
  console.error = () => undefined;
  try {
    await env.state.expertSpoke(ACCOUNT, { source: "telegram", at: new Date(Date.now() - 3600_000).toISOString() });
    const task = await env.tasks.create({ accountId: ACCOUNT, kind: "build", origin: { source: "telegram" }, status: "needs_you", needs: "review", payload: {} });
    env.setReachable(false);
    await env.assistant.news(ACCOUNT, task.id, "构建好了", "finished");
    await env.idle();
    await env.assistant.settleDeliveries();
    assert.equal(env.pushed.length, 0, "no chat can take it");
    env.setReachable(true);
    env.failPushes(1);
    await env.assistant.settleDeliveries();
    assert.equal(env.pushed.length, 0, "the channel failed to queue it");
    await env.assistant.settleDeliveries();
    await env.assistant.settleDeliveries();
    assert.deepEqual(env.pushed.map(message => [message.text, message.key?.startsWith("assistant-run:")]), [["构建好了，要发布吗？", true]], "queued once, under the Run's own key");
    assert.deepEqual(await env.deliveries.open(10), [], "closed after it was queued");
  } finally { console.error = consoleError; await env.close(); }
});

test("News told again is one message and one owed reply, even when the first telling stopped before the debt was written", async () => {
  const env = await setup({ model: () => ({ text: "构建好了，要发布吗？" }) });
  try {
    await env.state.expertSpoke(ACCOUNT, { source: "telegram", at: new Date(Date.now() - 3600_000).toISOString() });
    const task = await env.tasks.create({ accountId: ACCOUNT, kind: "build", origin: { source: "telegram" }, status: "needs_you", needs: "review", payload: {} });
    const owe = env.deliveries.owe.bind(env.deliveries);
    env.deliveries.owe = async () => { throw new Error("database down"); };
    await assert.rejects(env.assistant.news(ACCOUNT, task.id, "构建好了", "finished"), /database down/);
    env.deliveries.owe = owe;
    await env.assistant.news(ACCOUNT, task.id, "构建好了", "finished");
    await env.assistant.news(ACCOUNT, task.id, "构建好了", "finished");
    await env.idle();
    await env.assistant.settleDeliveries();
    assert.equal(env.model.state.calls, 1, "the Assistant heard it once");
    assert.deepEqual(env.pushed.map(message => message.text), ["构建好了，要发布吗？"], "and its reply was owed, though the second telling was a replay");
  } finally { await env.close(); }
});

test("Two blocks of one task are two messages; a retry of one block is one", async () => {
  const env = await setup({ model: () => ({ text: "" }) });
  try {
    const task = await env.tasks.create({ accountId: ACCOUNT, kind: "build", origin: { source: "web" }, status: "working", payload: {} });
    const block = (reason: string, turn: number) => (env.assistant as unknown as { block(task: unknown, reason: string, turn: number): Promise<void> }).block(task, reason, turn);
    await block("第一次卡住", 4);
    await block("第一次卡住", 4);
    await env.idle();
    assert.equal(env.model.state.calls, 1, "a retry of the same block is heard once");
    await block("第二次卡住", 7);
    await env.idle();
    assert.equal(env.model.state.calls, 2, "a later block of the same task is heard too");
    assert.deepEqual(env.model.state.turns.map(turn => /第.次卡住/.exec(turn.input.message.content)?.[0]), ["第一次卡住", "第二次卡住"]);
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

test("The receipt of a sent message carries the time Chat accepted it", async () => {
  const env = await setup({ model: (_turn, call) => call === 1 ? { delayMs: 300, text: "好" } : { text: "不该再有一轮" } });
  try {
    await env.say("第一句");
    await waitFor(async () => (await env.chat.status(ACCOUNT)).state === "running");
    const send = env.chat.gateway.send.bind(env.chat.gateway);
    const accepted = "2020-01-01T00:00:00.000Z";
    (env.chat.gateway as { send: typeof send }).send = async (...args) => ({ ...(await send(...args)), acceptedAt: accepted });
    const sent = await env.chat.send(ACCOUNT, { id: "late-1", text: "补充一句", attachments: [], client: { client: "web" } });
    assert.equal(sent.queued, true);
    assert.equal(sent.message.created_at, accepted);
    await env.idle();
  } finally { await env.close(); }
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

test("The old conversation is read once into Chat: the Expert's words, the Assistant's replies and where the Expert last spoke", async () => {
  const env = await setup({ model: () => ({ text: "好" }) });
  try {
    const old = new WorkbenchStore(env.legacy, undefined, undefined);
    const session = await old.create("assistant", "Hatch 助理");
    const user = (text: string, itemId: string) => ({ role: "user" as const, content: `专家（Studio）：${text}`, timestamp: 1000, origin: { kind: "expert" as const, itemId, text } });
    await old.update(session.id, s => {
      s.messages = [user("我是陈姐", "a"), { role: "assistant", content: [{ type: "text", text: "你好陈姐" }], timestamp: 2000 } as never, { role: "user", content: "[任务 x] 构建好了", timestamp: 3000, origin: { kind: "system", itemId: "b" } } as never];
      (s as { assistantDesk?: unknown }).assistantDesk = { ingress: [], lastExpert: { source: "telegram", at: "2026-11-09T00:00:00.000Z" } };
    });
    const lines = await env.chat.lines(ACCOUNT);
    assert.deepEqual(lines.map(line => [line.role, line.text]), [["user", "我是陈姐"], ["assistant", "你好陈姐"]], "the system message stays out of the chat, as it did");
    assert.equal((await env.state.lastExpert(ACCOUNT))?.source, "telegram");
    const after = await old.get(session.id);
    assert.deepEqual([after.messages.length, (after as { assistantDesk?: unknown }).assistantDesk], [0, undefined], "the old session keeps only the Expert's files");
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
    assert.deepEqual(env.notices, ["语音暂时转不成文字，请先发文字。\nVoice messages cannot be transcribed right now. Please send text instead."]);
    assert.equal(env.model.state.calls, 0);
  } finally { console.error = log; await env.close(); }
});

test("The Expert's page reads the conversation by page: never the whole of it, and a message sent into a running reply is already there, queued", async () => {
  const env = await setup({ model: (turn, call) => call === 1 ? { delayMs: 300, text: "慢慢答" } : { text: "又答" } });
  try {
    // A page projects the events of its own Runs; reading the conversation's whole visible history is what it must not do.
    const project = env.store.readVisibleConversation.bind(env.store);
    env.store.readVisibleConversation = async (id, events) => events ? project(id, events) : assert.fail("the page must not read the whole conversation");
    await env.say("第一句", "m-first");
    await sleep(60);
    await env.say("第二句", "m-second");
    // Another reader, while the first reply is still being made: the second message is the conversation's already.
    const during = await env.assistant.view(ACCOUNT);
    assert.deepEqual(during.messages.map(message => [message.id, message.state]), [["m-first", undefined], ["m-second", "queued"]]);
    await env.idle();
    const after = await env.assistant.view(ACCOUNT);
    assert.deepEqual(after.messages.filter(message => message.role === "expert").map(message => [message.id, message.state]), [["m-first", undefined], ["m-second", undefined]]);
    assert.ok(after.messages.every(message => message.role === "expert" || /^run_[0-9a-f]+:[0-9]+$/.test(message.id)), "a reply is named <run_id>:<n>");
    assert.deepEqual((await env.assistant.view(ACCOUNT)).messages.map(message => message.id), after.messages.map(message => message.id), "ids do not change on a refresh");
    await env.say("第三句", "m-third");
    await env.idle();
    const earlier = await env.assistant.view(ACCOUNT, { limit: 1 });
    assert.equal(earlier.has_more, true, "the first Run is a page of its own");
    assert.ok((await env.assistant.view(ACCOUNT, { limit: 200, beforeCursor: earlier.before_cursor })).messages.length > 0);
  } finally { await env.close(); }
});

test("One key is one message whichever way it arrives: the page and the API share it, other content under it is refused, and a refused send leaves the key free", async () => {
  const env = await setup({ model: () => ({ text: "好" }) });
  try {
    // The page sends it, then the Studio API retries it under the same Idempotency-Key.
    await env.assistant.hear(ACCOUNT, { id: "key-1", source: "web", parts: [{ type: "text", text: "同一句" }] });
    const again = await env.chat.send(ACCOUNT, { id: "key-1", text: "同一句", attachments: [], client: { client: "cli" } });
    assert.equal(again.message.id, "key-1", "the key is the message's id");
    await env.idle();
    assert.deepEqual((await env.chat.lines(ACCOUNT)).filter(line => line.role === "user").map(line => [line.id, line.text]), [["key-1", "同一句"]], "one record");
    assert.equal(env.model.state.calls, 1, "one Run");
    await assert.rejects(env.chat.send(ACCOUNT, { id: "key-1", text: "别的话", attachments: [], client: { client: "cli" } }), { status: 409, code: "idempotency_conflict" });
    // A key is the same length for every client, and `sys:` is the Assistant's own.
    assert.throws(() => messageKey("k".repeat(257)), { code: "invalid_idempotency_key" });
    assert.equal(messageKey(`  ${"k".repeat(256)} `)?.length, 256);
    await assert.rejects(env.chat.send(ACCOUNT, { id: "sys:forged", text: "假装是系统", attachments: [], client: { client: "cli" } }), { status: 400, code: "invalid_message_id" });
    // A send that fails before it is accepted never stands for anything: the retry is delivered, not answered with a stranded "sent".
    await assert.rejects(env.chat.say(ACCOUNT, { id: "key-2", parts: [{ type: "image", assetId: "no-such-asset" }], client: { client: "web" } }));
    const retried = await env.chat.send(ACCOUNT, { id: "key-2", text: "再来一次", attachments: [], client: { client: "web" } });
    await env.idle();
    assert.equal(retried.message.id, "key-2");
    assert.ok((await env.chat.lines(ACCOUNT)).some(line => line.id === "key-2" && line.text === "再来一次"), "it was really sent");
  } finally { await env.close(); }
});
