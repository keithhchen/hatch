import { Scenario } from "../lib/scenario.mjs";
import { Auth, ChatApi, ChatSocket, StudioApi, StudioSocket } from "../lib/clients.mjs";
import { CliProcess, TERMINAL, chatText, fromChat, fromStudio, isCompleteList, listPrompt, newToken, waitMs } from "../lib/resume-helpers.mjs";
import { sleep } from "../lib/util.mjs";

const RUN_TIMEOUT_MS = 180_000;

/** Waits for a client to have visibly received reply text, so closing it is "mid-Run". Resolves with the moment it closed. */
async function untilFirstText(frames, normalise) {
  for await (const frame of frames) { const n = normalise(frame); if (n.delta) return; }
  throw new Error("stream ended before any reply text arrived");
}

// ── Chat (Runtime): Web = HTTP SSE with cookie + Origin; Desktop = /v1/runtime WebSocket; CLI = `hatch ask --stream` ──

class ChatClosers {
  constructor(stack, owner, productId) { this.stack = stack; this.owner = owner; this.productId = productId; this.bearer = new ChatApi(stack.url, Auth.bearer(owner.apiKey)); }

  async web(conversation, content) {
    const controller = new AbortController();
    const api = new ChatApi(this.stack.url, Auth.browserCookie(this.owner.session));
    const { frames } = await api.sendSse(conversation, this.productId, { content, signal: controller.signal, client: "web" });
    let runId;
    await untilFirstText(frames, (f) => { runId ??= f.json?.run_id; return fromChat(f.json); });
    const closedAt = Date.now(); controller.abort();
    return { closedAt, runId };
  }

  async ws(conversation, content) {
    const socket = await ChatSocket.open(this.stack.url, { auth: Auth.bearer(this.owner.apiKey), productId: this.productId, conversationId: conversation, firstMessage: true });
    const { runId } = socket.message(content);
    await socket.waitFor("first reply text", (f) => f.type === "assistant.delta" && f.delta?.kind === "text" && f.delta.content, 120_000);
    const closedAt = Date.now(); socket.terminate();
    return { closedAt, runId };
  }

  /** Control: a Web client that stays connected until the Run ends. Shows a failure is not about closing. */
  async stay(conversation, content) {
    const api = new ChatApi(this.stack.url, Auth.browserCookie(this.owner.session));
    const { frames } = await api.sendSse(conversation, this.productId, { content, client: "web" });
    for await (const _ of frames) { /* until the server ends the stream */ }
    return { closedAt: Date.now(), control: true };
  }

  async cli(conversation, content) {
    const cli = new CliProcess(this.stack, this.owner.apiKey, ["ask", content, "--product", this.productId, "--conversation", conversation, "--stream"]);
    await cli.waitOutput("first reply text", (out) => out.trim().length > 0);
    const closedAt = cli.kill9(); await cli.exited;
    return { closedAt, runId: undefined };
  }

  /** Verifies everything the user asked for about the Run, from the product's own state. */
  async verify(label, conversation, closed, token, content, rec) {
    const { closedAt, runId } = closed;
    const api = this.bearer;
    const statusAtClose = (await api.runs(conversation, this.productId)).json?.runs?.at(-1)?.status;
    rec.measure(`${label}.status_at_close`, statusAtClose);
    if (!closed.control) rec.check(`${label}: closed while the Run was still going`, ["queued", "running"].includes(statusAtClose), statusAtClose);
    const runs = (await api.runs(conversation, this.productId)).json?.runs ?? [];
    const id = runId ?? runs.at(-1)?.id;
    let finalStatus; let waited;
    waited = await waitMs(async () => { const r = (await api.run(conversation, this.productId, id)).json?.run; finalStatus = r?.status; return TERMINAL.has(r?.status); }, { timeoutMs: RUN_TIMEOUT_MS, everyMs: 100 });
    const run = (await api.run(conversation, this.productId, id)).json?.run;
    rec.check(`${label}: Run reaches completed`, run?.status === "completed", { status: run?.status, run_id: id, reason: run?.interrupted_reason });
    const afterClose = run?.completed_at ? Date.parse(run.completed_at) - closedAt : undefined;
    rec.measure(`${label}.run_completed_after_close_ms`, afterClose);
    rec.measure(`${label}.polled_until_terminal_ms`, waited);
    const allRuns = (await api.runs(conversation, this.productId)).json?.runs ?? [];
    rec.check(`${label}: exactly one Run in the conversation`, allRuns.length === 1, allRuns.map((r) => ({ id: r.id, status: r.status })));
    const history = await api.messages(conversation, this.productId);
    const users = history.filter((m) => m.role === "user");
    const assistants = history.filter((m) => m.role === "assistant" && chatText(m).trim());
    rec.check(`${label}: the user message exists once`, users.length === 1 && chatText(users[0]).includes(token), { users: users.length });
    rec.check(`${label}: the assistant reply exists exactly once`, assistants.length === 1, { assistants: assistants.length, ids: assistants.map((m) => m.id) });
    rec.check(`${label}: the reply is complete (LIST token and all 40 lines)`, assistants.length > 0 && isCompleteList(chatText(assistants.at(-1)), token, 40), chatText(assistants.at(-1) ?? {}).slice(-80));
    const journal = (await api.call("GET", `/v1/conversations/${conversation}/events?product_id=${this.productId}&after_cursor=0`)).json?.events ?? [];
    const cancels = journal.filter((e) => /cancel/i.test(e.type) || (e.type === "run.state" && e.payload?.status === "cancelled"));
    rec.check(`${label}: no cancel was recorded`, cancels.length === 0 && run?.status !== "cancelled", cancels.map((e) => e.type));
    rec.evidenceOf(`${label}.ids`, { conversation, run_id: id, journal_types: journal.map((e) => e.type) });
    if (run?.status !== "completed") rec.evidenceOf(`${label}.not_completed`, { run, journal: journal.map((e) => ({ cursor: e.cursor, type: e.type, payload: e.payload })), history });
  }
}

// ── Studio (Registry): Web = HTTP SSE with a Bearer session; WS = Studio socket; CLI = `hatch chat|assistant --stream` ──

class StudioTarget {
  constructor(kind, studio, productId) { this.kind = kind; this.studio = studio; this.productId = productId; this.worker = "interview"; }
  send(content, extra = {}) { return this.kind === "assistant" ? this.studio.sendAssistant({ content, ...extra }) : this.studio.sendWorker(this.productId, this.worker, { content, ...extra }); }
  messagesNow() { return this.kind === "assistant" ? this.studio.messagesAssistant() : this.studio.messagesWorker(this.productId, this.worker); }
  events(options) { return this.kind === "assistant" ? this.studio.eventsAssistant(options) : this.studio.eventsWorker(this.productId, this.worker, options); }
  get path() { return this.kind === "assistant" ? "/v1/creator/assistant/conversation" : this.studio.workerPath(this.productId, this.worker); }
  get wsTarget() { return this.kind === "assistant" ? { assistant: true } : { product_id: this.productId, worker: this.worker }; }
  cliArgs(content) { return this.kind === "assistant" ? ["assistant", content, "--stream"] : ["chat", this.productId, this.worker, content, "--stream"]; }
}

class StudioClosers {
  constructor(stack) { this.stack = stack; }

  /** A fresh account (an Assistant is one conversation per account) with its own Product for the worker case. */
  async target(kind) {
    const account = await this.stack.account(`studio-${kind}`);
    const studio = new StudioApi(this.stack.url, Auth.bearer(account.session));
    let productId;
    if (kind === "worker") {
      const created = await studio.call("POST", "/v1/creator/products", { body: { name: "Close Client Probe", promise: "Answers during a verification run." } });
      productId = created.json?.product?.product_id;
      if (!productId) throw new Error(`product create failed: ${created.status} ${created.text.slice(0, 200)}`);
    }
    return { account, target: new StudioTarget(kind, studio, productId) };
  }

  async web({ target }, content) {
    const controller = new AbortController();
    const { frames } = await target.studio.stream("POST", `${target.path}/messages`, { body: { content, client: { client: "web" } }, signal: controller.signal });
    await untilFirstText(frames, (f) => (f.event === "accepted" ? { other: true } : fromStudio(f.id, f.json)));
    const closedAt = Date.now(); controller.abort();
    return { closedAt };
  }

  async ws({ account, target }, content) {
    const socket = await StudioSocket.open(this.stack.url, { auth: Auth.bearer(account.session) });
    const sent = await target.send(content);
    socket.subscribe("s1", target.wsTarget, { stream: true, after: "0" });
    await socket.waitFor("first reply text", (f) => f.type === "event" && f.event?.type === "delta" && f.event.text, RUN_TIMEOUT_MS);
    const closedAt = Date.now(); socket.terminate();
    return { closedAt, sendStatus: sent.status };
  }

  /** `hatch ... --stream`. The CLI may die on its own before any text (see the defect check); then that exit is the close. */
  async cli({ account, target }, content, rec, label) {
    const cli = new CliProcess(this.stack, account.apiKey, target.cliArgs(content));
    await cli.waitOutput("first reply text", (out) => out.trim().length > 0, RUN_TIMEOUT_MS).catch(() => undefined);
    const crashed = Boolean(cli.exit) && cli.exit.signal === null;
    const closedAt = crashed ? cli.exit.at : cli.kill9(); await cli.exited;
    rec.measure(`${label}.cli_exit`, { code: cli.exit.code, signal: cli.exit.signal, stdout_bytes: cli.out.length, stderr: cli.err.slice(0, 200) });
    if (crashed && !rec.defects.some((d) => d.title.startsWith("hatch chat/assistant --stream"))) rec.defect({
      title: "hatch chat/assistant --stream crashes on the first Studio event",
      severity: "medium",
      expected: "`hatch assistant <msg> --stream` and `hatch chat <product> <worker> <msg> --stream` print the reply as it arrives (the CLI help says so).",
      actual: `The CLI exits 1 with: ${cli.err.trim().slice(0, 160)}. Studio SSE frames carry no \`event:\` name, so RunObserver (packages/hatch-cli/src/run.js) takes each as event "message", returns undefined for it, and stdout.write(undefined) throws. The Run itself is unaffected and completes.`,
      repro: "hatch assistant \"hi\" --stream (any Studio worker or the Assistant, plain output, not --json)"
    });
    rec.check(`${label}: the CLI streamed reply text and was then killed (not crashed)`, !crashed && cli.out.trim().length > 0, { exit: cli.exit, stderr: cli.err.slice(0, 200) });
    return { closedAt };
  }

  /** `hatch ... --wait=60` (no streaming) killed with SIGKILL a few seconds into the turn. */
  async cliWait({ account, target }, content) {
    const args = target.cliArgs(content).map((a) => (a === "--stream" ? "--wait=120" : a));
    const cli = new CliProcess(this.stack, account.apiKey, args);
    await sleep(3000);
    const closedAt = cli.kill9(); await cli.exited;
    return { closedAt };
  }

  async verify(label, { target }, { closedAt }, token, rec) {
    const state = async () => (await target.messagesNow()).json;
    const atClose = (await state())?.status;
    rec.measure(`${label}.status_at_close`, atClose);
    rec.check(`${label}: closed while the turn was still running`, atClose === "running", atClose);
    const waited = await waitMs(async () => (await state())?.status !== "running", { timeoutMs: RUN_TIMEOUT_MS, everyMs: 100 });
    rec.measure(`${label}.turn_finished_after_close_ms`, waited === undefined ? undefined : Date.now() - closedAt - 0);
    const { status, messages = [] } = await state();
    rec.check(`${label}: conversation ends idle (not failed)`, status === "idle", status);
    const users = messages.filter((m) => m.role === "user" && String(m.text).includes(token));
    const replies = messages.filter((m) => m.role === "assistant" && isCompleteList(String(m.text), token, 25));
    rec.check(`${label}: the user message exists once`, users.length === 1, { users: users.length });
    rec.check(`${label}: the assistant reply exists exactly once`, replies.length === 1, { replies: replies.length, assistant_tails: messages.filter((m) => m.role === "assistant").map((m) => String(m.text).slice(-90)) });
    // The log: one run_end, completed, and no stop of any kind (this scenario never calls stop).
    const controller = new AbortController();
    const { frames } = await target.events({ after: "0", signal: controller.signal });
    const events = [];
    const timer = setTimeout(() => controller.abort(), 15_000);
    for await (const frame of frames) { events.push(frame.json); if (frame.json?.type === "run_end") break; }
    clearTimeout(timer); controller.abort();
    const ends = events.filter((e) => e?.type === "run_end");
    rec.check(`${label}: the log has one run_end and it is completed`, ends.length === 1 && ends[0].status === "completed", ends);
    rec.evidenceOf(`${label}.event_types`, [...new Set(events.map((e) => e?.type))]);
  }
}

class CloseClient extends Scenario {
  constructor() { super({ id: 2, title: "Close a client mid-Run (Web, Desktop WebSocket, CLI): the Run completes, the reply exists once" }); }

  async run(stack, rec) {
    const owner = await stack.account("owner");
    const productId = await stack.product(owner);
    const chat = new ChatClosers(stack, owner, productId);
    const studio = new StudioClosers(stack);
    rec.note("Chat prompt asks for a 40 line list starting with LIST-<token> (Studio: 25 lines); each client is closed at its first visible reply text. Every case has its own conversation (Studio: own account, and own Product for the worker case). Cases run in parallel in one Stack.");
    rec.note("Studio has no WebSocket send: the 'ws' client sends over HTTP (202) and observes over the Studio socket, which is then terminated. Studio worker = `interview` of a Product created through POST /v1/creator/products.");

    const jobs = [];
    for (const client of ["stay", "web", "ws", "cli"]) jobs.push(this.chatCase(chat, client, rec));
    for (const client of process.env.CHAT_ONLY ? [] : ["web", "ws", "cli", "cliWait"]) for (const kind of ["assistant", "worker"]) jobs.push(this.studioCase(studio, kind, client, rec));
    const settled = await Promise.allSettled(jobs);
    for (const outcome of settled) if (outcome.status === "rejected") rec.check("a case ran to its verification", false, String(outcome.reason?.stack ?? outcome.reason).slice(0, 600));
  }

  async chatCase(chat, client, rec) {
    const label = `chat.${client}`; const token = newToken();
    try {
      const conversation = await chat.bearer.create(chat.productId);
      const content = listPrompt(token);
      const closed = await chat[client](conversation, content);
      await chat.verify(label, conversation, closed, token, content, rec);
    } catch (error) { rec.check(`${label}: case ran`, false, String(error?.stack ?? error).slice(0, 500)); }
  }

  async studioCase(studio, kind, client, rec) {
    const label = `studio.${kind}.${client.toLowerCase().replace("wait", "-wait")}`; const token = newToken();
    try {
      const scope = await studio.target(kind);
      const closed = await studio[client](scope, listPrompt(token, 25), rec, label);
      await studio.verify(label, scope, closed, token, rec);
    } catch (error) { rec.check(`${label}: case ran`, false, String(error?.stack ?? error).slice(0, 500)); }
  }
}
export default new CloseClient();
