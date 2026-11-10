import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { createFactoryLlmModel, type FactoryPiAgentOptions } from "../creatorLearning/factoryPi.js";
import { FileWorkbenchBackend, WorkbenchStore } from "../factoryAgents/store.js";
import { WorkbenchRuntime } from "../factoryAgents/runtime.js";
import type { FactoryWorkspace } from "../factoryAgents/service.js";
import { MemoryEventLog } from "../conversations/eventLog.js";
import { EventLogJournal } from "../conversations/journal.js";
import { AssistantService, type ProductWorkspaces } from "./assistant.js";
import type { AccountReach } from "./reach.js";
import { AssistantTarget } from "./assistantTarget.js";
import type { AssistantChannels, Inbound } from "../channels/ports.js";
import type { ChannelConnection } from "../channels/connections.js";
import { idempotencyId, type OutboundMessage } from "../channels/types.js";
import { TelegramChannel } from "../channels/telegramChannel.js";
import { MemoryTaskRepository } from "./tasks.js";
import { MemoryAgentDefinitionRepository, initialAgentDefinitions } from "../factoryAgents/definitions.js";
import type { AgentCatalog, AgentChange } from "./catalog.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "22222222-2222-4222-8222-222222222222";

type Step = { text?: string; tool?: { name: string; arguments: Record<string, unknown> }; delayMs?: number; /** The provider's error text: the model's turn ends in error. */ fail?: string };
type Script = (context: Context, call: number) => Step;

/** Automated test double for the model: a scripted stream, no network. */
function scriptedAgents(scripts: { assistant: Script; worker?: Script }) {
  const calls = { assistant: 0, worker: 0 };
  const factory = (options: FactoryPiAgentOptions) => {
    const kind = String(options.initialState?.systemPrompt ?? "").includes("你是 Hatch 助理") ? "assistant" : "worker";
    return new Agent({ ...options.agentOptions, initialState: { ...options.initialState, model: createFactoryLlmModel({ env: options.env }) }, streamFn: (_model, context) => {
      const call = ++calls[kind];
      const step: Step = (kind === "assistant" ? scripts.assistant : scripts.worker ?? ((): Step => ({ text: "完成" })))(context, call);
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "moonshotai-cn", model: "kimi-k2.6", timestamp: Date.now(),
        content: step.tool ? [{ type: "toolCall", id: `call-${kind}-${call}`, ...step.tool }] : [{ type: "text", text: step.text ?? "" }],
        stopReason: step.fail ? "error" : step.tool ? "toolUse" : "stop", ...(step.fail ? { errorMessage: step.fail } : {}), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        if (step.fail) { stream.push({ type: "error", reason: "error", error: message }); stream.end(message); return; }
        stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: step.tool ? "toolUse" : "stop", message }); stream.end(message);
      }, step.delayMs ?? 0);
      return stream;
    } });
  };
  return { factory, calls };
}

const allUserTexts = (context: Context) => context.messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content : message.content.map(block => block.type === "text" ? block.text : "").join(""));
const userTexts = (context: Context) => allUserTexts(context).filter(text => !text.startsWith("<当前状态>") && !text.startsWith("<system-reminder>"));

async function setup(scripts: { assistant: Script; worker?: Script }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-assistant-"));
  const tasks = new MemoryTaskRepository();
  const sent: Array<{ text: string; buttons?: OutboundMessage["buttons"]; replyingTo?: string }> = [];
  const compactions: string[] = [];
  const applied: AgentChange[] = [];
  const reach = { assistantAccounts: async () => [] } as unknown as AccountReach;
  // The channel layer is its own port: the Assistant only says where a reply goes. Delivery is tested in channels/.
  const channels: AssistantChannels = {
    reply: async (inboundId, message) => { sent.push({ text: message.text, replyingTo: inboundId, ...(message.buttons ? { buttons: message.buttons } : {}) }); return true; },
    push: async (_account, message) => { sent.push({ text: message.text, ...(message.buttons ? { buttons: message.buttons } : {}) }); return true; },
    canReach: async () => true,
    compacting: async (_account, id) => { compactions.push(id); },
  };
  const telegram = new TelegramChannel({ token: "test", username: "hatch_test_bot", webhookSecret: "secret" }, (async (url: string) => {
    if (url.includes("/file/bot")) return new Response("# 我的选址笔记\n隔壁活过三年才算数\n", { status: 200 });
    if (url.endsWith("/getFile")) return new Response(JSON.stringify({ ok: true, result: { file_path: "documents/notes.md" } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch);
  const { factory, calls } = scriptedAgents(scripts);
  const productStore = new WorkbenchStore(path.join(root, "product"), { creatorId: ACCOUNT, productId: PRODUCT }, new MemoryAgentDefinitionRepository(await initialAgentDefinitions()));
  let grantedTools: Parameters<ProductWorkspaces["attachAssistant"]>[0]["grantedTools"] | undefined;
  let withheldTools: Parameters<ProductWorkspaces["attachAssistant"]>[0]["withheldTools"] | undefined;
  const productRuntime = new WorkbenchRuntime(productStore, { env: { HATCH_FACTORY_LLM_PROFILE: "kimi-k2.6" }, agentFactory: factory, maxTurns: 6, grantedTools: session => grantedTools?.({ creatorId: ACCOUNT, productId: PRODUCT }, session) ?? [], withheldTools: async session => await withheldTools?.({ creatorId: ACCOUNT, productId: PRODUCT }, session) ?? [] });
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
  const log = new MemoryEventLog();
  const assistant = new AssistantService({
    tasks, reach, catalog, channels,
    products: { workspace: async () => { opened?.({ creatorId: ACCOUNT, productId: PRODUCT }, workspace); return workspace; }, attachAssistant: hooks => { opened = hooks.opened; grantedTools = hooks.grantedTools; withheldTools = hooks.withheldTools; } },
    backend: () => new FileWorkbenchBackend(path.join(root, "assistant")),
    exclusive: async (_name, fn) => fn(),
    env: { HATCH_FACTORY_LLM_PROFILE: "kimi-k2.6" },
    runtime: { agentFactory: factory },
    journal: keyOf => new EventLogJournal(log, keyOf),
  });
  const idle = () => new Promise<void>(resolve => {
    const check = async () => {
      const view = await assistant.view(ACCOUNT);
      const desk = (await assistant.view(ACCOUNT));
      if (!view.running && !desk.running) { assistant.events.off("event", listener); resolve(); }
    };
    const listener = (event: { type?: string }) => { if (event.type === "assistant") void check(); };
    assistant.events.on("event", listener);
  });
  const connection: ChannelConnection = { id: "c0000000-0000-4000-8000-000000000001", ownerAccountId: ACCOUNT, channel: "telegram", scope: "", client: "im", target: { kind: "assistant" }, audience: "self", taskSpecific: false, state: "active" };
  const target = new AssistantTarget(assistant);
  /** What the router hands the Assistant once it has authorized the sender; the inbox id is derived from the event id, so a repeat is the same message. */
  const telegramUpdate = async (update: unknown) => {
    for (const event of telegram.parse(Buffer.from(JSON.stringify(update))).events) {
      const inbound: Inbound = {
        id: idempotencyId(event.eventId), connection, event, adapter: telegram, principal: { kind: "account", accountId: ACCOUNT },
        address: { connectionId: connection.id, ...event.address }, notify: async text => { sent.push({ text }); },
      };
      await target.handle(inbound);
    }
  };
  /** What the Assistant's runtime persisted, and what its journal says about it. */
  const journaled = async () => {
    const desk = await (assistant as unknown as { desk(account: string): Promise<{ store: WorkbenchStore; sessionId: string }> }).desk(ACCOUNT);
    const events = (await log.after(`assistant:${ACCOUNT}`, "0", 5000)).map(entry => entry.event.type);
    return { events, messages: (await desk.store.get(desk.sessionId)).messages.length, store: desk.store, sessionId: desk.sessionId };
  };
  return { root, tasks, sent, log, journaled, compactions, applied, telegramUpdate, assistant, calls, productStore, productRuntime, idle, close: async () => { await assistant.close(); await productRuntime.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}

test("A burst of Telegram messages steers one turn and gets one reply, with every message in the context", async () => {
  const seen: string[][] = [];
  const env = await setup({ assistant: (context, call) => { seen.push(userTexts(context)); return call === 1 ? { text: "先回第一条", delayMs: 150 } : { text: "三条都看到了" }; } });
  try {
    const done = env.idle();
    await env.telegramUpdate({ update_id: 1, message: { message_id: 10, chat: { id: 42, type: "private" }, text: "第一条" } });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(env.calls.assistant, 1, "the first message started a turn at once: there is no merge window");
    assert.deepEqual(seen[0]!.filter(text => text.startsWith("专家")), ["专家（Telegram）：第一条"]);
    await env.telegramUpdate({ update_id: 2, message: { message_id: 11, chat: { id: 42, type: "private" }, text: "第二条" } });
    await env.telegramUpdate({ update_id: 3, message: { message_id: 12, chat: { id: 42, type: "private" }, text: "第三条" } });
    await env.telegramUpdate({ update_id: 3, message: { message_id: 12, chat: { id: 42, type: "private" }, text: "第三条" } });
    await done;
    assert.equal(env.sent.length, 1, "one reply for the whole burst");
    assert.equal(env.sent[0]!.text, "三条都看到了");
    assert.deepEqual(seen.at(-1)!.filter(text => text.startsWith("专家")), ["专家（Telegram）：第一条", "专家（Telegram）：第二条", "专家（Telegram）：第三条"]);
    const view = await env.assistant.view(ACCOUNT);
    assert.equal(view.messages.filter(message => message.role === "expert").length, 3, "the duplicate update was dropped");
    assert.equal(env.sent[0]!.replyingTo, idempotencyId("3"), "the reply goes to the last message's inbox id");
    const { events, messages } = await env.journaled();
    assert.ok(events.includes("run_end") && events.includes("message_end"), "the Assistant's Runs are in the conversation log like a worker's");
    assert.ok(events.filter(type => type === "message").length >= 1 && messages >= 4);
  } finally { await env.close(); }
});

test("The Assistant's build runs the Product's builder, which cannot go live", async () => {
  const toolNames: string[][] = [];
  const env = await setup({
    assistant: (context, call) => call === 1 ? { tool: { name: "start_task", arguments: { kind: "build", agent_id: PRODUCT, instruction: "加上熟客店菜单可以长的例外" } } } : { text: "好" },
    worker: context => { toolNames.push((context.tools ?? []).map(tool => tool.name)); return { text: "构建完成" }; },
  });
  try {
    await env.telegramUpdate({ update_id: 1, message: { message_id: 10, chat: { id: 42, type: "private" }, text: "熟客店菜单可以长" } });
    await waitFor(async () => (await env.productStore.list()).some(session => session.role === "generation") && (await env.tasks.open(ACCOUNT)).length === 0);
    assert.ok(toolNames.length > 0);
    assert.ok(toolNames.every(names => !names.includes("corpus_upload")), "publishing stays with the Assistant");
    assert.deepEqual(env.applied, [], "a build changes nothing outward");
  } finally { await env.close(); }
});

test("A worker question becomes a task waiting for the Expert and reaches the Assistant", async () => {
  const assistantInputs: string[] = [];
  const env = await setup({
    assistant: context => { assistantInputs.push(userTexts(context).at(-1) ?? ""); return { text: "好" }; },
    worker: (_context, call) => call === 1 ? { tool: { name: "askuser", arguments: { questions: [{ question: "这份评测里哪处最不像你？", options: [] }] } } } : { text: "完成" },
  });
  try {
    const task = await env.tasks.create({ accountId: ACCOUNT, productId: PRODUCT, kind: "evaluate", origin: { source: "web" }, status: "needs_you", needs: "review", payload: { step: "confirm", instruction: "更新" } });
    const done = env.idle();
    const evaluator = await env.productStore.create("evaluator");
    await env.tasks.update(task.id, { status: "working", session: { scope: "product", sessionId: evaluator.id }, payload: { step: "evaluator" } });
    await env.assistant.view(ACCOUNT);
    (await (env.assistant as unknown as { workspace(a: string, p: string): Promise<FactoryWorkspace> }).workspace(ACCOUNT, PRODUCT));
    await env.productRuntime.start(evaluator.id, "用最新案例评测线上 Agent。");
    await done;
    const waiting = await env.tasks.get(task.id);
    assert.equal(waiting!.status, "needs_you");
    assert.equal(waiting!.needs, "answer");
    assert.deepEqual(waiting!.payload.questions, ["这份评测里哪处最不像你？"]);
    assert.ok(assistantInputs.some(text => text.includes("这份评测里哪处最不像你？")));
    await env.assistant.answer(ACCOUNT, task.id, "第二条最不像我");
    await waitFor(async () => (await env.tasks.get(task.id))!.status === "done");
    const answered = (await env.productStore.get(evaluator.id)).messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content));
    assert.ok(answered.some(text => text.includes("第二条最不像我")), "the answer reached the worker");
  } finally { await env.close(); }
});

test("start_task is one tool: a new kind runs its steps in order and reports", async () => {
  const assistantInputs: string[] = [];
  const started: string[] = [];
  const env = await setup({
    assistant: context => { assert.deepEqual((context.tools ?? []).filter(tool => ["web_scrape", "write"].includes(tool.name)), [], "the Assistant coordinates; it does not do the work"); assistantInputs.push(userTexts(context).at(-1) ?? ""); return { text: "好" }; },
    worker: context => { started.push(userTexts(context).at(-1) ?? ""); return { text: "评测做完了" }; },
  });
  try {
    await env.assistant.view(ACCOUNT);
    const task = await env.assistant.dispatch(ACCOUNT, "evaluate", PRODUCT, "看看现在怎么样", { source: "web" });
    assert.equal(task.status, "working", "evaluate changes nothing outward, so it needs no confirmation");
    await waitFor(async () => (await env.tasks.get(task.id))!.status === "done");
    assert.ok(started.some(text => text.includes("构造一个新的真实客户案例")));
    assert.ok(started.some(text => text.includes("评测线上 Agent")));
    await waitFor(async () => assistantInputs.some(text => text.includes("评测跑完了")));
    await assert.rejects(env.assistant.dispatch(ACCOUNT, "content", undefined, "写", { source: "web" }), /指定 Agent/);
  } finally { await env.close(); }
});

test("Interview pass-through: the Expert's replies go to the interview, then it hands back to the Assistant", async () => {
  const assistantInputs: string[] = [];
  const voiceInputs: string[] = [];
  const env = await setup({
    assistant: (context, call) => {
      assistantInputs.push(userTexts(context).at(-1) ?? "");
      return call === 1 ? { tool: { name: "start_task", arguments: { kind: "interview", agent_id: PRODUCT, instruction: "为什么是三年" } } } : { text: call === 2 ? "我请访谈来问问你" : "聊得很好" };
    },
    worker: context => {
      const input = userTexts(context).at(-1) ?? "";
      if (input.startsWith("{")) return { text: "已更新" }; // Scribe
      voiceInputs.push(input);
      if (input.includes("第三年还在")) return { tool: { name: "handoff_to_assistant", arguments: { note: "聊清了三年的理由" } } };
      return { text: "为什么是三年，不是一年？" };
    },
  });
  try {
    let done = env.idle();
    await env.assistant.ingest(ACCOUNT, { source: "telegram", text: "我选址先看隔壁活了几年", messageRef: "10" });
    await done;
    await new Promise(resolve => setTimeout(resolve, 100));
    const [interview] = await env.tasks.open(ACCOUNT);
    assert.equal(interview!.kind, "interview");
    assert.ok(env.sent.some(message => message.text === "为什么是三年，不是一年？"), "the interview question reached Telegram");
    assert.equal(env.calls.assistant, 1, "starting an interview ends the Assistant's turn");
    await env.assistant.ingest(ACCOUNT, { source: "task", taskId: interview!.id, text: "公开资料读完了" });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(env.calls.assistant, 1, "task news waits until the interview hands back");
    await env.telegramUpdate({ update_id: 1, message: { message_id: 12, chat: { id: 42, type: "private" }, document: { file_id: "f1", file_name: "notes.md", file_size: 30 } } });
    await waitFor(async () => voiceInputs.some(text => text.includes("input/manual/notes.md")));
    assert.deepEqual((await env.productStore.listManualFiles()).map(file => file.path), ["input/manual/notes.md"], "a file sent mid-interview is readable by the interview");
    await env.productStore.update(interview!.session!.sessionId, session => { session.todos = [{ title: "为什么是三年", status: "completed" }, { title: "什么时候例外", status: "pending" }]; });
    await env.assistant.ingest(ACCOUNT, { source: "telegram", text: "第三年还在，说明真的有人吃饭", messageRef: "11" });
    await waitFor(async () => (await env.tasks.get(interview!.id))!.status === "done" && assistantInputs.some(text => text.includes("聊清了三年的理由")) && !(await env.assistant.view(ACCOUNT)).running);
    assert.ok(voiceInputs.some(text => text.includes("第三年还在")), "the reply went to the interview");
    assert.ok(!assistantInputs.some(text => text.includes("第三年还在") && !text.includes("[任务")), "the Assistant did not answer it itself");
    const ended = await env.tasks.get(interview!.id);
    assert.equal(ended!.status, "done");
    assert.ok(assistantInputs.some(text => text.includes("聊清了三年的理由")));
    assert.ok(assistantInputs.some(text => text.includes("✓ 为什么是三年") && text.includes("○ 什么时候例外")), "the Assistant sees the outline's progress");
    assert.equal((await env.assistant.view(ACCOUNT)).interviewing, false);
    const { events, messages } = await env.journaled();
    assert.ok(events.filter(type => type === "message").length >= messages / 2, "messages that passed to the interview and came back were committed with their events too");
  } finally { await env.close(); }
});

test("A Telegram document becomes the Expert's material and flows into a Product's input", async () => {
  const assistantInputs: string[] = [];
  const env = await setup({ assistant: context => { assistantInputs.push(userTexts(context).at(-1) ?? ""); return { text: "收到" }; } });
  try {
    const done = env.idle();
    await env.telegramUpdate({ update_id: 1, message: { message_id: 10, chat: { id: 42, type: "private" }, document: { file_id: "f1", file_name: "notes.md", file_size: 30 } } });
    await done;
    assert.ok(assistantInputs.some(text => text.includes("input/materials/notes.md")));
    await env.tasks.create({ accountId: ACCOUNT, kind: "poke", origin: { source: "tick" } });
    await env.assistant.dispatch(ACCOUNT, "build", PRODUCT, "更新", { source: "web" });
    assert.deepEqual((await env.productStore.listManualFiles()).map(file => file.path), ["input/manual/notes.md"]);
  } finally { await env.close(); }
});

test("A file that can't be converted gets a plain reply; the cause stays out of the chat", async (t) => {
  const python = process.env.PYTHON_BIN;
  process.env.PYTHON_BIN = "/nonexistent/python";
  t.after(() => { if (python === undefined) delete process.env.PYTHON_BIN; else process.env.PYTHON_BIN = python; });
  const env = await setup({ assistant: () => ({ text: "收到" }) });
  try {
    await env.telegramUpdate({ update_id: 1, message: { message_id: 10, chat: { id: 42, type: "private" }, document: { file_id: "f1", file_name: "notes.pdf", file_size: 30 } } });
    const replies = env.sent.map(message => message.text);
    assert.equal(replies.length, 1);
    assert.match(replies[0]!, /没读出内容/);
    assert.doesNotMatch(replies[0]!, /nonexistent|Command failed|Traceback/);
  } finally { await env.close(); }
});

test("A Telegram photo reaches the model as pixels, and history keeps only a reference", async () => {
  let seen: Array<{ type: string; mimeType?: string; data?: string }> = [];
  const env = await setup({ assistant: context => { seen = context.messages.flatMap(message => message.role === "user" && Array.isArray(message.content) ? message.content as typeof seen : []); return { text: "看到了" }; } });
  try {
    const done = env.idle();
    await env.telegramUpdate({ update_id: 1, message: { message_id: 10, chat: { id: 42, type: "private" }, caption: "这家店怎么样", photo: [{ file_id: "small", file_size: 1 }, { file_id: "large", file_size: 2 }] } });
    await done;
    const image = seen.find(block => block.type === "image");
    assert.equal(image?.mimeType, "image/jpeg");
    assert.ok(!image?.data?.startsWith("hatch-file:"), "the model gets bytes");
    assert.ok(seen.some(block => block.type === "text" && JSON.stringify(block).includes("这家店怎么样")));
    const stored = JSON.stringify((await env.assistant.view(ACCOUNT)).messages);
    assert.ok(stored.includes("这家店怎么样"));
    const raw = JSON.stringify(await readSessions(env.root));
    assert.ok(raw.includes("hatch-file:input/images/"), "history stores the reference");
    assert.ok(!raw.includes(image!.data!), "history never stores the bytes");
  } finally { await env.close(); }
});

test("The chat shows only what was said; live state reaches the model but never history", async () => {
  let last = "";
  const env = await setup({ assistant: context => { last = allUserTexts(context).at(-1) ?? ""; return { text: "好" }; } });
  try {
    const done = env.idle();
    await env.assistant.ingest(ACCOUNT, { source: "web", text: "[任务 看起来像通知] 其实是我说的" });
    await done;
    assert.match(last, /^<当前状态>/);
    assert.match(last, /选址顾问/);
    const after = env.idle();
    await env.assistant.ingest(ACCOUNT, { source: "task", taskId: "t1", text: "构建好了" });
    await after;
    const { messages } = await env.assistant.view(ACCOUNT);
    assert.deepEqual(messages.filter(line => line.role === "expert").map(line => line.text), ["[任务 看起来像通知] 其实是我说的"], "the Expert's words show, whatever they look like");
    assert.ok(!JSON.stringify(messages).includes("构建好了"), "system messages stay out of the chat");
    const raw = JSON.stringify(await readSessions(env.root));
    assert.ok(raw.includes("构建好了"), "task news stays in history for the model");
    assert.ok(!raw.includes("<当前状态>"), "live state is never stored");
  } finally { await env.close(); }
});

test("Publishing goes through the Product's interface, after the Expert confirms", async () => {
  const env = await setup({ assistant: () => ({ text: "好" }) });
  try {
    const task = await env.assistant.propose(ACCOUNT, PRODUCT, { release: "publish" }, { source: "web" });
    assert.equal(task.needs, "review");
    assert.deepEqual(env.applied, [], "nothing goes out before the Expert confirms");
    await env.assistant.approve(ACCOUNT, task.id);
    assert.deepEqual(env.applied, [{ release: "publish" }]);
  } finally { await env.close(); }
});

test("Research becomes the Expert's material and a Product can read it", async () => {
  const assistantInputs: string[] = [];
  const env = await setup({
    assistant: context => { assistantInputs.push(userTexts(context).at(-1) ?? ""); return { text: "我读完了" }; },
    worker: (_context, call) => call === 1 ? { tool: { name: "write", arguments: { path: "output/PUBLIC_PROFILE.md", content: "# 陈姐\n做了 15 年开店顾问" } } }
      : { text: "读完了" },
  });
  try {
    await env.assistant.view(ACCOUNT);
    await env.assistant.dispatch(ACCOUNT, "research", undefined, "陈姐，东京的开店顾问", { source: "web" });
    await waitFor(async () => assistantInputs.some(text => text.includes("公开资料读完了")));
    await env.assistant.dispatch(ACCOUNT, "build", PRODUCT, "更新", { source: "web" });
    assert.deepEqual((await env.productStore.listManualFiles()).map(file => file.path), ["input/manual/公开资料.md"]);
  } finally { await env.close(); }
});

async function readSessions(root: string): Promise<unknown[]> {
  const found: unknown[] = [];
  for (const entry of await readdir(path.join(root, "assistant"), { recursive: true })) if (String(entry).endsWith("session.json")) found.push(JSON.parse(await readFile(path.join(root, "assistant", String(entry)), "utf8")));
  return found;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** The desk is private; these tests need its runtime to watch and to nudge a turn. */
async function deskOf(env: Awaited<ReturnType<typeof setup>>) {
  await env.assistant.view(ACCOUNT);
  return await (env.assistant as unknown as { desk(account: string): Promise<{ runtime: WorkbenchRuntime; sessionId: string; taken: Map<string, unknown> }> }).desk(ACCOUNT);
}

test("A message that arrives as a turn ends is not lost, and never runs beside it", async () => {
  const seen: string[][] = [];
  const env = await setup({ assistant: (context, call) => { seen.push(userTexts(context).filter(text => text.startsWith("专家"))); return { text: call === 1 ? "第一个回复" : "第二个回复" }; } });
  try {
    const desk = await deskOf(env);
    let running = 0; let peak = 0; let injected = false;
    desk.runtime.events.on("event", (event: { sessionId?: string; type?: string }) => {
      if (event.sessionId !== desk.sessionId) return;
      if (event.type === "voice.run_started") peak = Math.max(peak, ++running);
      if (event.type === "voice.run_completed") {
        running -= 1;
        // The turn has ended and its owner is still settling it: the worst moment for a message.
        if (!injected) { injected = true; void env.telegramUpdate({ update_id: 2, message: { message_id: 11, chat: { id: 42, type: "private" }, text: "第二条" } }); }
      }
    });
    const done = env.idle();
    await env.telegramUpdate({ update_id: 1, message: { message_id: 10, chat: { id: 42, type: "private" }, text: "第一条" } });
    await done;
    await waitFor(async () => env.sent.length === 2 && !(await env.assistant.view(ACCOUNT)).running);
    assert.equal(peak, 1, "at most one turn at a time");
    assert.equal(env.calls.assistant, 2);
    assert.deepEqual(seen.at(-1), ["专家（Telegram）：第一条", "专家（Telegram）：第二条"], "the late message is in the next turn's context");
    assert.deepEqual(env.sent.map(message => message.text), ["第一个回复", "第二个回复"]);
  } finally { await env.close(); }
});

test("While the turn is compacting, messages wait and join afterwards, and the Expert is told once", async () => {
  const env = await setup({ assistant: (_context, call) => call === 1 ? { text: "还在想", delayMs: 200 } : { text: "两条都看到了" } });
  try {
    const desk = await deskOf(env);
    await env.telegramUpdate({ update_id: 1, message: { message_id: 10, chat: { id: 42, type: "private" }, text: "第一条" } });
    await new Promise(resolve => setTimeout(resolve, 40));
    desk.runtime.emit(desk.sessionId, "compacting");
    desk.runtime.emit(desk.sessionId, "compacting");
    await env.telegramUpdate({ update_id: 2, message: { message_id: 11, chat: { id: 42, type: "private" }, text: "第二条" } });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(desk.taken.size, 1, "the second message waited: it was not steered into a turn that is summarizing");
    assert.equal(env.compactions.length, 1, "one notice per compaction, and a repeat of the same one is the channel layer's to drop");
    desk.runtime.emit(desk.sessionId, "delta", { text: "…" });
    await waitFor(async () => desk.taken.size === 2 || env.sent.length > 0);
    await waitFor(async () => env.sent.length === 1 && !(await env.assistant.view(ACCOUNT)).running);
    assert.deepEqual(env.sent.map(message => message.text), ["两条都看到了"]);
  } finally { await env.close(); }
});

test("The daily check skips a model call when the Expert's chats cannot take the message", async () => {
  let asked = 0;
  const env = await setup({ assistant: () => { asked += 1; return { text: "好" }; } });
  try {
    (env.assistant as unknown as { deps: { channels: AssistantChannels; reach: unknown } }).deps.channels = { ...(env.assistant as unknown as { deps: { channels: AssistantChannels } }).deps.channels, canReach: async () => false };
    (env.assistant as unknown as { deps: { reach: unknown } }).deps.reach = { assistantAccounts: async () => [{ accountId: ACCOUNT, timezone: "UTC" }] };
    await env.assistant.tick(new Date("2026-11-10T12:00:00Z"));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(asked, 0);
    assert.equal((await env.tasks.pokes(ACCOUNT, 3)).length, 0);
  } finally { await env.close(); }
});

test("A message and its event are one step: a reader never sees one without the other", async () => {
  const env = await setup({ assistant: (_context, call) => ({ text: `回复${call}`, delayMs: 20 }) });
  try {
    const key = `assistant:${ACCOUNT}`;
    const { store, sessionId } = await env.journaled();
    let torn = 0;
    let reads = 0;
    const watcher = setInterval(() => void env.log.consistent(key, async cursor => {
      const events = (await env.log.after(key, "0", 5000)).filter(entry => Number(entry.cursor) <= Number(cursor)).filter(entry => entry.event.type === "message").length;
      const messages = (await store.get(sessionId)).messages.length;
      reads++;
      // Each commit writes one message here, so the counts move together.
      if (events !== messages) torn++;
    }), 2);
    for (let i = 0; i < 4; i++) { await env.assistant.submit(ACCOUNT, { source: "web", text: `第${i}条` }); await new Promise(resolve => setTimeout(resolve, 15)); }
    await waitFor(async () => !(await env.assistant.view(ACCOUNT)).running);
    await new Promise(resolve => setTimeout(resolve, 40));
    clearInterval(watcher);
    assert.ok(reads > 5);
    assert.equal(torn, 0);
    const { events, messages } = await env.journaled();
    assert.equal(events.filter(type => type === "message").length, messages, "each message exactly once");
  } finally { await env.close(); }
});

test("submit returns the Run that took the message, and an upload lands where the model reads it", async () => {
  const env = await setup({ assistant: () => ({ text: "看到了", delayMs: 100 }) });
  try {
    const first = await env.assistant.submit(ACCOUNT, { source: "web", text: "你好" });
    assert.match(first.runId ?? "", /^run_/, "a real Run, from the runtime");
    assert.equal((await env.assistant.view(ACCOUNT)).runId, first.runId);
    const second = await env.assistant.submit(ACCOUNT, { source: "web", text: "再补一句" });
    assert.equal(second.runId, first.runId, "a message that steers the turn belongs to its Run");
    await waitFor(async () => !(await env.assistant.view(ACCOUNT)).running);
    assert.equal((await env.assistant.view(ACCOUNT)).runId, undefined);
    assert.equal((await env.assistant.submit(ACCOUNT, { source: "web", text: "又来" })).runId?.startsWith("run_"), true);
    await waitFor(async () => !(await env.assistant.view(ACCOUNT)).running);

    const workshop = env.assistant.workshop(ACCOUNT);
    const id = "33333333-3333-4333-8333-333333333333";
    const asset = (kind: "image" | "file", name: string, mime: string) => ({ id, record: { kind, name, mime }, derivative: () => undefined }) as never;
    const picture = workshop.place(asset("image", "我的 图.png", "image/png"));
    const note = workshop.place(asset("file", "选址 笔记.pdf", "application/pdf"));
    assert.deepEqual([picture, note], [`input/images/${id}.png`, "input/materials/33333333-选址 笔记.pdf.md"]);
    await workshop.files.writeManual(picture, Buffer.from("png"));
    assert.equal((await env.assistant.image(ACCOUNT, `${id}.png`)).toString(), "png", "the web image route finds it");
    await workshop.files.writeManual(note, Buffer.from("# 笔记"));
    await env.assistant.submit(ACCOUNT, { source: "web", text: "看图", images: [picture], attachments: [{ type: "image", name: "我的 图.png", assetId: "a1" }] });
    await waitFor(async () => !(await env.assistant.view(ACCOUNT)).running);
    const sent = (await env.assistant.view(ACCOUNT)).messages.find(message => message.text === "看图")!;
    assert.deepEqual(sent.attachments, [{ type: "image", name: "我的 图.png", assetId: "a1" }], "history says which assets the message carried");
    await env.assistant.dispatch(ACCOUNT, "build", PRODUCT, "更新", { source: "web" });
    assert.ok((await env.productStore.listManualFiles()).some(file => file.path === "input/manual/33333333-选址 笔记.pdf.md"), "a file lands among the materials that reach every Product's input");
  } finally { await env.close(); }
});

test("A Run the provider refuses is a failed Assistant with a code, in the view and in the Run's end, until the next message", async () => {
  const env = await setup({ assistant: (_context, call) => call === 1 ? { fail: '429 {"error":{"message":"Your account org-abc123<ak-secret9> is suspended due to insufficient balance"}}' } : { text: "好了" } });
  const consoleError = console.error;
  console.error = () => undefined;
  try {
    await env.assistant.submit(ACCOUNT, { source: "web", text: "你好" });
    await waitFor(async () => !(await env.assistant.view(ACCOUNT)).running);
    const view = await env.assistant.view(ACCOUNT);
    assert.equal(view.failure?.code, "upstream_error");
    assert.match(view.failure?.message ?? "", /not a problem with your account. Reference: err_[0-9a-f]{12}\./);
    assert.equal(view.failure?.message.includes(view.failure.reference!), true);
    assert.deepEqual(view.messages.map(message => message.role), ["expert"], "the message is kept; there is no reply");
    const end = (await env.log.after(`assistant:${ACCOUNT}`, "0", 5000)).map(entry => entry.event).find(event => event.type === "run_end");
    assert.deepEqual([end?.status, (end?.error as { code: string }).code], ["failed", "upstream_error"]);
    assert.doesNotMatch(JSON.stringify([view.failure, end]), /org-abc123|ak-secret9|suspended|insufficient balance/);
    await env.assistant.submit(ACCOUNT, { source: "web", text: "再试" });
    await waitFor(async () => !(await env.assistant.view(ACCOUNT)).running);
    assert.equal((await env.assistant.view(ACCOUNT)).failure, undefined, "a new turn that succeeds clears it");
  } finally { console.error = consoleError; await env.close(); }
});
