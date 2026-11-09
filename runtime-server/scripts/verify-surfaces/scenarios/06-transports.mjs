import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Scenario } from "../lib/scenario.mjs";
import { Auth, ChatApi, ChatSocket, StudioApi, StudioSocket } from "../lib/clients.mjs";
import { sleep } from "../lib/util.mjs";
import { StalledSse, SseCollector, bytesSha, cursorReport, median, sameBytes, settled, stall, timeTo, unstall } from "../lib/transport-helpers.mjs";

const CHAT_PROMPT = "List the integers from 1 to 150 separated by single spaces. Output only the numbers, no other words.";
const STUDIO_PROMPT = "List the integers from 1 to 150 separated by single spaces. Output only the numbers, no other words.";
/** One token per event in Studio, so a long answer is what can make a stalled consumer fall a megabyte behind. */
const STUDIO_LONG_PROMPT = "List the integers from 1 to 1500 separated by single spaces. Output only the numbers, no other words.";

/**
 * One Run, two systems. A Target hides what differs (Chat on the Runtime, Studio's Assistant on the Registry) so the same
 * observation code runs against both: four observers attached before the message, then compared against the durable journal.
 */
class ChatTarget {
  name = "chat";
  constructor(stack, owner) { this.stack = stack; this.owner = owner; this.auth = Auth.bearer(owner.apiKey); this.api = new ChatApi(stack.url, this.auth); }
  async prepare() {
    this.productId ??= await this.stack.product(this.owner, { name: "Transports Expert", system: "You are a transcription machine. You output exactly what the user asks for and nothing else, however long." });
    this.conversation = await this.api.create(this.productId);
    this.cursor0 = (await this.api.snapshot(this.conversation, this.productId)).json.cursor;
    return this.cursor0;
  }
  startSse(after) { const abort = new AbortController(); return new SseCollector(this.api.events(this.conversation, this.productId, { after, signal: abort.signal }), abort); }
  stalledSse(after) { return new StalledSse(this.stack.url, `/v1/conversations/${this.conversation}/events?product_id=${this.productId}&after_cursor=${after}`, this.auth.headers()); }
  async openWs(after, stream) {
    const socket = await ChatSocket.open(this.stack.url, { auth: this.auth, productId: this.productId, conversationId: this.conversation, firstMessage: true });
    socket.subscribe({ stream, after });
    return socket;
  }
  async send(prompt) {
    const started = Date.now();
    const sent = await this.api.send(this.conversation, this.productId, { content: prompt, wait: 120 });
    return { ms: Date.now() - started, status: sent.status, reply: sent.json?.reply, runId: sent.json?.run?.id ?? sent.json?.run_id };
  }
  async history() { const messages = await this.api.messages(this.conversation, this.productId); return messages.filter((m) => m.role === "assistant").at(-1)?.content; }
  async truth(after) { const r = await this.api.call("GET", `/v1/conversations/${this.conversation}/events${this.api.q(this.productId, { after_cursor: String(after) })}`); return { cursors: (r.json?.events ?? []).map((e) => e.cursor), head: r.json?.cursor, types: (r.json?.events ?? []).map((e) => e.type) }; }
  sseCursor(frame) { return frame.event === "journal.event" ? frame.json.cursor : undefined; }
  wsCursor(frame) { return frame.type === "journal.event" ? frame.cursor : undefined; }
  isPartial(json) { return json?.type === "assistant.delta"; }
  sseDelta(frame) { return frame.json?.type === "assistant.delta" && frame.json.delta?.kind === "text" ? frame.json.delta.content : undefined; }
  wsDelta(frame) { return frame.type === "assistant.delta" && frame.delta?.kind === "text" ? frame.delta.content : undefined; }
  wsPartial(frame) { return frame.type === "assistant.delta"; }
  /** The journal says an assistant message exists; its text is read from history afterwards. */
  assistantCommitted(cursorsAndFrames) { return cursorsAndFrames.some((f) => (f.type ?? f.json?.type) === "journal.event" && (f.journal_type ?? f.json?.journal_type) === "message.created" && (f.payload ?? f.json?.payload)?.role === "assistant"); }
  /** The terminal journal cursor of the Run, for catch-up. */
  caughtUp(cursors, head) { return cursors.includes(head); }
  async close() {}
}

class StudioTarget {
  name = "studio";
  constructor(stack, owner) { this.stack = stack; this.owner = owner; this.auth = Auth.bearer(owner.apiKey); this.api = new StudioApi(stack.registryUrl, this.auth); }
  async prepare() { this.cursor0 = (await this.api.snapshotAssistant()).json.cursor; return this.cursor0; }
  startSse(after) { const abort = new AbortController(); return new SseCollector(this.api.eventsAssistant({ after, signal: abort.signal }), abort); }
  stalledSse(after) { return new StalledSse(this.stack.registryUrl, `/v1/creator/assistant/conversation/events?after=${after}`, this.auth.headers()); }
  async openWs(after, stream) {
    const socket = await StudioSocket.open(this.stack.registryUrl, { auth: this.auth, firstMessage: true });
    socket.subscribe("obs", { assistant: true }, { stream, after });
    return socket;
  }
  async send(prompt, { poll = false } = {}) {
    const started = Date.now();
    if (poll) {
      // A long answer outlasts the 120 s maximum of ?wait, so the Run is timed until the conversation is idle again.
      const sent = await this.api.sendAssistant({ content: prompt });
      for (;;) {
        const { json } = await this.api.messagesAssistant();
        if (json?.status === "idle" && json.messages?.at(-1)?.role === "assistant") return { ms: Date.now() - started, status: 200, reply: json.messages.at(-1).text, runId: sent.json?.run_id };
        if (Date.now() - started > 600_000) return { ms: Date.now() - started, status: 504 };
        await sleep(250);
      }
    }
    const sent = await this.api.sendAssistant({ content: prompt, wait: 120 });
    return { ms: Date.now() - started, status: sent.status, reply: sent.json?.reply?.text, runId: sent.json?.run_id };
  }
  async history() { return (await this.api.messagesAssistant()).json?.messages?.filter((m) => m.role === "assistant").at(-1)?.text; }
  async truth(after) {
    const abort = new AbortController();
    const collector = new SseCollector(this.api.eventsAssistant({ after, signal: abort.signal }), abort);
    await sleep(500); await settled(() => collector.frames.length, 1_000); collector.stop();
    const cursors = collector.frames.filter((f) => f.id !== undefined).map((f) => f.id);
    return { cursors, head: cursors.at(-1), types: collector.frames.filter((f) => f.id !== undefined).map((f) => f.json?.type) };
  }
  async stalledReplayFromStart() {
    const socket = await StudioSocket.open(this.stack.registryUrl, { auth: this.auth, firstMessage: true });
    stall(socket);
    socket.subscribe("late", { assistant: true }, { stream: true, after: "0" });
    return socket;
  }
  rawStalledFromStart() {
    const url = new URL(this.stack.registryUrl);
    const script = fileURLToPath(new URL("../lib/stalled_ws_client.py", import.meta.url));
    const env = { PATH: process.env.PATH, HOST: url.hostname, PORT: url.port, PATH_: "/v1/creator/studio/ws", TOKEN: this.owner.apiKey, SUBSCRIBE_JSON: JSON.stringify({ type: "subscribe", id: "raw", target: { assistant: true }, stream: true, after: "0" }), STALL_SECONDS: "8" };
    return new Promise((resolve) => {
      const child = spawn("python3", ["-I", script], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.on("exit", () => { try { resolve(JSON.parse(out)); } catch { resolve({ error: out.slice(0, 200) }); } });
    });
  }
  sseCursor(frame) { return frame.id; }
  wsCursor(frame) { return frame.type === "event" ? frame.cursor : undefined; }
  isPartial(json) { return json?.type === "delta" || json?.type === "thinking"; }
  sseDelta(frame) { return frame.json?.type === "delta" ? frame.json.text : undefined; }
  wsDelta(frame) { return frame.type === "event" && frame.event?.type === "delta" ? frame.event.text : undefined; }
  wsPartial(frame) { return frame.type === "event" && (frame.event?.type === "delta" || frame.event?.type === "thinking"); }
  assistantCommitted() { return true; }
  caughtUp(cursors, head) { return cursors.includes(head); }
}

/** The four observers of one Run plus the bookkeeping to read what each saw. */
class Observation {
  constructor(target) { this.target = target; }
  async attach(after) {
    this.sse = this.target.startSse(after);
    this.wsStream = await this.target.openWs(after, true);
    this.wsPlain = await this.target.openWs(after, false);
    await sleep(400);
  }
  cursors() {
    const t = this.target;
    return {
      sse: this.sse.frames.map((f) => t.sseCursor(f)).filter((c) => c !== undefined).map(Number),
      wsStream: this.wsStream.frames.map((f) => t.wsCursor(f)).filter((c) => c !== undefined).map(Number),
      wsPlain: this.wsPlain.frames.map((f) => t.wsCursor(f)).filter((c) => c !== undefined).map(Number)
    };
  }
  text() {
    const t = this.target;
    return {
      sse: this.sse.frames.map((f) => t.sseDelta(f)).filter((x) => x !== undefined).join(""),
      wsStream: this.wsStream.frames.map((f) => t.wsDelta(f)).filter((x) => x !== undefined).join("")
    };
  }
  close() { this.sse.stop(); this.wsStream.close(); this.wsPlain.close(); }
}

const say = (text) => process.stderr.write(`[6] ${new Date().toISOString().slice(11, 19)} ${text}\n`);

class Transports extends Scenario {
  constructor() { super({ id: 6, title: "Transports: one Run observed by HTTP, SSE, WS streaming and WS non-streaming; slow consumer" }); }

  async run(stack, rec) {
    const owner = await stack.account("owner");
    for (const target of [new ChatTarget(stack, owner), new StudioTarget(stack, owner)]) {
      await this.observeFourWays(target, rec);
      await this.slowConsumer(target, rec);
    }
    rec.note("Chat observers send nothing: the sender is the HTTP POST ?wait=110; WS observers authenticate with the token in the hello (Bearer is only accepted on Studio upgrade). Studio target is the Assistant conversation on the Registry; Product worker conversations need a running pipeline and were not used.");
    rec.note("Cursor truth: Chat = GET events?after_cursor=<before> (JSON replay of the journal); Studio = a replayed SSE from the same cursor. Delta text is rebuilt from live deltas; the non-streaming WS observer reads the final text from history after its journal shows the assistant message.");
  }

  async observeFourWays(target, rec) {
    const n = target.name;
    say(`${n}: four observers`);
    const after = await target.prepare();
    const observation = new Observation(target);
    await observation.attach(after);
    say(`${n}: attached, sending`);
    const sent = await target.send(target.name === "chat" ? CHAT_PROMPT : STUDIO_PROMPT);
    say(`${n}: sent in ${sent.ms} ms status ${sent.status}`);
    rec.measure(`${n}_http_wait_ms`, sent.ms);
    if (!rec.check(`${n}: HTTP wait returned the final result (200 with reply)`, sent.status === 200 && sent.reply, { status: sent.status })) { observation.close(); return; }
    const truth = await target.truth(after);
    const caught = {
      sse: await timeTo(() => target.caughtUp(observation.cursors().sse, Number(truth.head))),
      wsStream: await timeTo(() => target.caughtUp(observation.cursors().wsStream, Number(truth.head))),
      wsPlain: await timeTo(() => target.caughtUp(observation.cursors().wsPlain, Number(truth.cursors.at(-1))))
    };
    rec.measure(`${n}_observer_catch_up_ms`, caught);
    await sleep(500);
    const stored = await target.history();
    const text = observation.text();
    const cursors = observation.cursors();
    const truthNumbers = truth.cursors.map(Number);
    // Streaming observers see every durable event; the plain WS observer sees every durable event too (Studio: minus the partial types).
    const partialTypes = new Set(["delta", "thinking"]);
    const durableTruth = target.name === "studio" ? truth.cursors.filter((_, i) => !partialTypes.has(truth.types[i])).map(Number) : truthNumbers;
    rec.evidenceOf(`${n}_final_sha256`, { reply: bytesSha(sent.reply ?? ""), stored: bytesSha(stored ?? ""), sse: bytesSha(text.sse), wsStream: bytesSha(text.wsStream) });
    rec.measure(`${n}_reply_chars`, (sent.reply ?? "").length);
    rec.check(`${n}: HTTP reply byte-identical to stored history`, sameBytes(sent.reply, stored), { reply: (sent.reply ?? "").slice(0, 60), stored: (stored ?? "").slice(0, 60) });
    rec.check(`${n}: SSE deltas concatenate to the same bytes as the reply`, sameBytes(text.sse, sent.reply), { sse: text.sse.slice(0, 60), len: [text.sse.length, (sent.reply ?? "").length] });
    rec.check(`${n}: WS stream:true deltas concatenate to the same bytes as the reply`, sameBytes(text.wsStream, sent.reply), { ws: text.wsStream.slice(0, 60), len: [text.wsStream.length, (sent.reply ?? "").length] });
    const plainPartials = observation.wsPlain.frames.filter((f) => target.wsPartial(f));
    rec.measure(`${n}_wsPlain_frame_types`, [...new Set(observation.wsPlain.frames.map((f) => f.type === "event" ? `event:${f.event?.type}` : f.type))]);
    rec.check(`${n}: WS stream:false delivered zero token-level partials`, plainPartials.length === 0 && observation.wsPlain.frames.length > 1, { partials: plainPartials.length, frames: observation.wsPlain.frames.length });
    rec.check(`${n}: WS stream:false observer reads the same final bytes from history once its journal shows the message`, target.assistantCommitted(observation.wsPlain.frames) && sameBytes(stored, sent.reply));
    const reports = { sse: cursorReport(cursors.sse, truthNumbers), wsStream: cursorReport(cursors.wsStream, truthNumbers), wsPlain: cursorReport(cursors.wsPlain, durableTruth) };
    rec.measure(`${n}_cursor_reports`, reports);
    rec.measure(`${n}_journal_cursors`, { count: truthNumbers.length, first: truthNumbers[0], last: truthNumbers.at(-1) });
    for (const [which, report] of Object.entries(reports)) rec.check(`${n}: ${which} cursors strictly increasing and gap-free versus the journal`, report.ok, report);
    // Reconnect by cursor: an observer that resumes from the middle gets exactly the rest.
    const middle = durableTruth[Math.floor(durableTruth.length / 2)];
    const resumed = await target.openWs(middle, true);
    await sleep(1_500);
    const resumedCursors = resumed.frames.map((f) => target.wsCursor(f)).filter((c) => c !== undefined).map(Number);
    resumed.close();
    const suffix = truthNumbers.filter((c) => c > middle);
    rec.check(`${n}: resuming by cursor delivers exactly the events after it`, JSON.stringify(resumedCursors) === JSON.stringify(suffix), { after: middle, got: resumedCursors.length, want: suffix.length });
    observation.close();
  }

  /**
   * A consumer that stops reading must not slow a Run. Alternating trials with and without a stalled WS and a stalled SSE
   * consumer attached from before the message; afterwards the stalled consumers resume so we can see what piled up for them.
   */
  async slowConsumer(target, rec) {
    const n = target.name;
    const trials = n === "chat" ? 4 : 3;
    const prompt = n === "chat" ? CHAT_PROMPT : STUDIO_LONG_PROMPT;
    const plain = []; const withSlow = []; const evidence = [];
    for (let i = 0; i < trials * 2; i++) {
      const slow = i % 2 === 1;
      say(`${n}: trial ${i + 1} slow=${slow}`);
      const after = await target.prepare();
      let slowWs; let slowSse;
      if (slow) {
        slowWs = await target.openWs(after, true);
        stall(slowWs);
      }
      const sending = target.send(prompt, { poll: true });
      if (slow) {
        // The SSE response only starts when the server first writes to it, so the stalled reader joins once the Run has produced events.
        await sleep(1_200);
        slowSse = target.stalledSse(after);
        const status = await Promise.race([slowSse.opened, sleep(10_000).then(() => "no headers in 10 s")]);
        say(`${n}: slow sse ${status}`);
      }
      const sent = await sending;
      say(`${n}: trial sent ${sent.ms} ms status ${sent.status}`);
      (slow ? withSlow : plain).push(sent.ms);
      if (slow) {
        unstall(slowWs);
        const sseBytes = await slowSse.drain(2_000);
        await sleep(1_000);
        const piled = slowWs.frames.length;
        const entry = { runMs: sent.ms, wsClosed: slowWs.closed, wsFramesThatPiledUp: piled, sseClosed: slowSse.closed, sseBytesThatPiledUp: sseBytes };
        if (slowWs.closed) {
          // Reconnect by cursor: from the last event it saw, the consumer gets exactly the rest.
          const seen = slowWs.frames.map((f) => target.wsCursor(f)).filter((c) => c !== undefined).map(Number);
          const last = Math.max(Number(after), ...seen);
          const again = await target.openWs(typeof after === "number" ? last : String(last), true);
          await sleep(2_500);
          const got = again.frames.map((f) => target.wsCursor(f)).filter((c) => c !== undefined).map(Number);
          const truth = (await target.truth(after)).cursors.map(Number).filter((c) => c > last);
          entry.reconnect = { from: last, got: got.length, want: truth.length, exact: JSON.stringify(got) === JSON.stringify(truth) };
          again.close();
        }
        evidence.push(entry);
        slowWs.close(); slowSse.destroy();
      }
    }
    rec.measure(`${n}_run_ms_without_slow`, plain);
    rec.measure(`${n}_run_ms_with_slow`, withSlow);
    rec.measure(`${n}_run_ms_median`, { without: median(plain), with: median(withSlow) });
    rec.measure(`${n}_slow_consumer_trials`, evidence);
    rec.check(`${n}: a stalled consumer does not delay the Run (median with <= 1.5 x median without + 3 s)`, median(withSlow) <= median(plain) * 1.5 + 3_000, { without: median(plain), with: median(withSlow) });
    const dropped = evidence.filter((e) => e.wsClosed?.code === 1013).length;
    const destroyed = evidence.filter((e) => e.sseClosed && e.sseClosed.complete === false).length;
    rec.measure(`${n}_slow_ws_closed_1013_trials`, `${dropped}/${evidence.length}`);
    rec.measure(`${n}_slow_sse_destroyed_trials`, `${destroyed}/${evidence.length}`);
    if (n === "chat") rec.check(`chat: a consumer that stops reading is disconnected (WS close 1013 / SSE destroyed) rather than buffered without bound`, dropped > 0 || destroyed > 0, { evidence: evidence.slice(0, 2) });
    else rec.note(`studio: during the live Runs the stalled Node clients were not dropped (${median(evidence.map((e) => e.wsFramesThatPiledUp))} frames / ~${median(evidence.map((e) => e.sseBytesThatPiledUp))} SSE bytes piled up): the operating system's socket buffers absorbed them below the server's 1 MB limit. That is a limit of this stimulus, not a verdict; the drop itself is checked below with a raw TCP consumer whose receive buffer is 4 KB.`);
    const reconnects = evidence.filter((e) => e.reconnect);
    if (n === "chat" && !dropped && !destroyed) rec.defect({ title: "Chat never disconnects a stalled consumer: its limit is 160 MB per connection", severity: "medium", expected: "Spec: a slow consumer is disconnected and reconnects by cursor (Studio does this at 1 MB)", actual: `Stalled Chat WS and SSE consumers stayed connected through every Run (${evidence.length} trials, 0 closes) while ${median(evidence.map((e) => e.wsFramesThatPiledUp))} frames / ${median(evidence.map((e) => e.sseBytesThatPiledUp))} SSE bytes piled up unread. The limit is maxSocketBufferedBytes / maxStreamBufferedBytes, default 160 MB, and index.ts refuses any configured value below MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES (160 MB), so it cannot be lowered: each stalled consumer can hold up to 160 MB of Runtime memory before it is dropped; no realistic answer reaches it, so the 1013 / destroy path was not reachable from outside`, repro: "run.mjs --only 6: chat_slow_consumer_trials" });
    if (n === "studio") await this.lateJoiner(target, rec);
    if (reconnects.length) rec.check(`${n}: a disconnected consumer reconnects by cursor and gets exactly the events it missed`, reconnects.every((e) => e.reconnect.exact), reconnects.map((e) => e.reconnect));
  }
  /**
   * The Studio log now holds several long Runs of one-token events. A consumer that joins from the start and never reads
   * falls a megabyte behind at once: it must be dropped with 1013 (WS) / destroyed (SSE) and resume by cursor.
   */
  async lateJoiner(target, rec) {
    const truth = (await target.truth("0")).cursors.map(Number);
    const raw = await target.rawStalledFromStart();
    rec.measure("studio_late_joiner_raw_tcp", { journal_events: truth.length, ...raw });
    const dropped = raw.close_code === 1013;
    rec.check("studio: a raw TCP consumer (4 KB receive buffer) that joins from the start and never reads is closed with 1013 (slow consumer)", dropped, { raw, journal_events: truth.length });
    if (dropped) {
      const last = Number(raw.last_cursor ?? 0);
      const again = await target.openWs(String(last), true);
      await settled(() => again.frames.length, 1_500);
      const got = again.frames.map((f) => target.wsCursor(f)).filter((c) => c !== undefined).map(Number);
      const want = truth.filter((c) => c > last);
      rec.check("studio: the dropped consumer resumes by cursor and gets exactly what it missed", JSON.stringify(got.slice(0, want.length)) === JSON.stringify(want), { from: last, got: got.length, want: want.length });
      again.close();
    }
  }
}

export default new Transports();
