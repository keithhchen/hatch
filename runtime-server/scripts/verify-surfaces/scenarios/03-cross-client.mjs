import { Scenario } from "../lib/scenario.mjs";
import { Auth, ChatApi, ChatSocket, StudioApi, StudioSocket } from "../lib/clients.mjs";
import { CliProcess, FrameRecorder, Trace, chatText, compareText, cursorProblems, cursorsAgainst, fromChat, fromStudio, isCompleteList, listPrompt, newToken, spread, waitMs } from "../lib/resume-helpers.mjs";
import { sleep } from "../lib/util.mjs";

const LINES = 60;
const OPEN_B_AFTER_MS = 1500;
const A_RETURNS_AFTER_MS = 1200;
const PROGRESS_LIMIT_MS = 2000;
const ROUNDS = { chat: Number(process.env.CHAT_ROUNDS ?? 2), studio: Number(process.env.STUDIO_ROUNDS ?? 1) };

class Discarded extends Error {}
const chatFrame = (f) => fromChat(f.json);
const studioSse = (f) => (f.event === "accepted" || f.event === "done" ? { other: true } : fromStudio(f.id, f.json));
const studioWs = (f) => (f.type === "event" ? fromStudio(f.cursor, f.event) : { other: true });

/** One surface (Chat or one Studio target) seen through the three things every client needs: start, snapshot, follow. */
class ChatSurface {
  constructor(stack, owner, productId) {
    this.name = "chat"; this.stack = stack; this.owner = owner; this.productId = productId;
    this.api = new ChatApi(stack.url, Auth.bearer(owner.apiKey));
    this.web = new ChatApi(stack.url, Auth.browserCookie(owner.session));
    this.normalise = chatFrame;
  }
  async prepare() { this.conversation = await this.api.create(this.productId); return this; }
  /** Client A: Web, one HTTP request that sends the message and streams the Run. */
  async startA(content) {
    const controller = new AbortController();
    const { frames } = await this.web.sendSse(this.conversation, this.productId, { content, signal: controller.signal, client: "web" });
    return new FrameRecorder(frames, controller);
  }
  async snapshot() { const r = (await this.api.snapshot(this.conversation, this.productId)).json; const run = r.runs?.at(-1); return { cursor: Number(r.cursor), partial: run?.partial_output ?? "", at: Date.now() }; }
  /** Live events after `after` (a cursor), by query or by Last-Event-ID; with neither, from now. */
  async follow({ after, lastEventId } = {}) {
    const controller = new AbortController();
    const { frames } = lastEventId !== undefined
      ? await this.api.stream("GET", `/v1/conversations/${this.conversation}/events${this.api.q(this.productId)}`, { headers: { "last-event-id": String(lastEventId) }, signal: controller.signal })
      : await this.api.events(this.conversation, this.productId, { after, signal: controller.signal });
    return new FrameRecorder(frames, controller);
  }
  async finished() {
    const runs = (await this.api.runs(this.conversation, this.productId)).json?.runs ?? [];
    const done = await waitMs(async () => ["completed", "failed", "cancelled", "interrupted"].includes((await this.api.run(this.conversation, this.productId, runs.at(-1).id)).json?.run?.status), { timeoutMs: 120_000, everyMs: 150 });
    return done !== undefined;
  }
  async finalText() { const m = (await this.api.messages(this.conversation, this.productId)).filter((x) => x.role === "assistant" && chatText(x).trim()); return { count: m.length, text: chatText(m.at(-1) ?? {}) }; }
  /** The journal after a cursor: what a client resuming there must receive, durable events only. */
  async journalAfter(cursor) { return ((await this.api.call("GET", `/v1/conversations/${this.conversation}/events${this.api.q(this.productId, { after_cursor: String(cursor) })}`)).json?.events ?? []).map((e) => Number(e.cursor)); }
  lastCursor(trace) { return trace.cursors.at(-1); }
  // Client B transports
  async openSocket() { const socket = await ChatSocket.open(this.stack.url, { auth: Auth.bearer(this.owner.apiKey), productId: this.productId, conversationId: this.conversation, firstMessage: true }); return socket; }
  subscribe(socket, after) { socket.subscribe({ stream: true, after }); }
  socketTrace(socket, startedAt, seed) { const t = new Trace(startedAt); if (seed) t.seed(seed.text, seed.at); for (const f of socket.frames) t.add(f.type === "assistant.delta" || f.type === "journal.event" ? fromChat(f) : { other: true }, f.__at); return t; }
  cli(args) { return new CliProcess(this.stack, this.owner.apiKey, ["conversation", "watch", this.conversation, "--product", this.productId, ...args]); }
}

class StudioSurface {
  constructor(stack, kind) { this.name = `studio.${kind}`; this.stack = stack; this.kind = kind; this.normalise = studioSse; }
  async prepare() {
    this.account = await this.stack.account(`studio-${this.kind}`);
    this.studio = new StudioApi(this.stack.url, Auth.bearer(this.account.session));
    if (this.kind === "worker") {
      const created = await this.studio.call("POST", "/v1/creator/products", { body: { name: "Resume Probe", promise: "Answers during a verification run." } });
      this.productId = created.json?.product?.product_id;
      if (!this.productId) throw new Error(`product create failed: ${created.status} ${created.text.slice(0, 200)}`);
    }
    this.path = this.kind === "assistant" ? "/v1/creator/assistant/conversation" : this.studio.workerPath(this.productId, "interview");
    this.target = this.kind === "assistant" ? { assistant: true } : { product_id: this.productId, worker: "interview" };
    return this;
  }
  async startA(content) {
    const controller = new AbortController();
    const { frames } = await this.studio.stream("POST", `${this.path}/messages`, { body: { content, client: { client: "web" } }, signal: controller.signal });
    return new FrameRecorder(frames, controller);
  }
  async snapshot() { const r = (await this.studio.call("GET", `${this.path}/snapshot`)).json; return { cursor: Number(r.cursor), partial: r.partial ?? "", at: Date.now(), raw: r }; }
  async follow({ after, lastEventId } = {}) {
    const controller = new AbortController();
    const { frames } = lastEventId !== undefined
      ? await this.studio.stream("GET", `${this.path}/events`, { headers: { "last-event-id": String(lastEventId) }, signal: controller.signal })
      : await this.studio.stream("GET", `${this.path}/events${after !== undefined ? `?after=${after}` : ""}`, { signal: controller.signal });
    return new FrameRecorder(frames, controller);
  }
  async finished() { return (await waitMs(async () => (await this.studio.call("GET", `${this.path}/messages`)).json?.status !== "running", { timeoutMs: 180_000, everyMs: 200 })) !== undefined; }
  async finalText() { const m = ((await this.studio.call("GET", `${this.path}/messages`)).json?.messages ?? []).filter((x) => x.role === "assistant"); return { count: m.length, text: m.at(-1)?.text ?? "" }; }
  lastCursor(trace) { return trace.cursors.at(-1); }
  async openSocket() { return StudioSocket.open(this.stack.url, { auth: Auth.bearer(this.account.session) }); }
  subscribe(socket) { socket.subscribe("s1", this.target, { stream: true }); }
  socketTrace(socket, startedAt) {
    const t = new Trace(startedAt);
    for (const f of socket.frames) {
      if (f.type === "snapshot") { t.add({ other: true }, f.__at); t.seed(f.snapshot.partial, f.__at); t.snapshotCursor = Number(f.snapshot.cursor); }
      else if (f.type === "event") t.add(fromStudio(f.cursor, f.event), f.__at);
    }
    return t;
  }
}
class CrossClient extends Scenario {
  constructor() { super({ id: 3, title: "Cross-client resume: start on A, open B mid-Run, return to A: text continuity and time to progress" }); }

  async run(stack, rec) {
    this.rec = rec; this.samples = [];
    const owner = await stack.account("owner");
    const productId = await stack.product(owner);
    rec.note(`Prompt: LIST-<token> then a numbered list of ${LINES} short lines (a Run that streams for several seconds). B opens ${OPEN_B_AFTER_MS} ms after A's list started streaming; A is dropped when B opens and returns ${A_RETURNS_AFTER_MS} ms later. Trials of one round run in parallel on one Stack, so timings include that contention.`);
    rec.note("Chat WebSocket has no snapshot frame: B-over-WS takes the snapshot over HTTP (cursor + the Run's partial_output), then conversation.subscribe(stream:true, after_cursor). B-over-CLI is `hatch conversation watch` (no snapshot, no cursor: 'from now'). Studio has no CLI watch.");
    const chat = () => new ChatSurface(stack, owner, productId);
    const studio = (k) => new StudioSurface(stack, k);

    for (let round = 0; round < ROUNDS.chat; round++) {
      const trials = [{ bKind: "sse", aStrategy: "control" }];
      for (const bKind of ["sse", "ws", "cli"]) for (const aStrategy of ["after_cursor", "last-event-id", "snapshot-then-attach", "attach-then-snapshot"]) trials.push({ bKind, aStrategy });
      await this.round(chat, trials);
    }
    for (let round = 0; round < ROUNDS.studio; round++) {
      const trials = [];
      for (const k of ["assistant", "worker"]) for (const bKind of ["sse", "ws"]) for (const aStrategy of ["after_cursor", "last-event-id", "snapshot-then-attach"]) trials.push({ bKind, aStrategy, make: () => studio(k) });
      await this.round(chat, trials);
    }
    this.report();
  }

  async round(chat, trials) {
    const settled = await Promise.allSettled(trials.map((t) => this.trial(t.make ? t.make() : chat(), t)));
    settled.forEach((outcome, i) => {
      if (outcome.status === "rejected" && outcome.reason instanceof Discarded) { this.rec.note(`Trial discarded, not a product result: ${outcome.reason.message}`); this.discarded = (this.discarded ?? 0) + 1; return; }
      if (outcome.status === "rejected") this.rec.check(`trial ${trials[i].bKind}/${trials[i].aStrategy} ran`, false, String(outcome.reason?.stack ?? outcome.reason).slice(0, 500));
    });
  }

  async trial(surface, { bKind, aStrategy }) {
    await surface.prepare();
    const token = newToken();
    const sent = Date.now();
    const A = await surface.startA(listPrompt(token, LINES));
    // Mid-Run: A is streaming the answer itself (the list header has arrived) and has been for a moment.
    const streaming = await waitMs(() => { if (A.ended) return true; const t = A.trace(surface.normalise, sent); return t.text.includes(`LIST-${token}`) && t.firstTextMs !== undefined && Date.now() - sent - t.firstTextMs >= OPEN_B_AFTER_MS; }, { timeoutMs: 120_000, everyMs: 50 });
    if (streaming === undefined || A.ended) { const t = A.trace(surface.normalise, sent); A.abort(); throw new Discarded(`${surface.name}: A never reached mid-Run streaming (frames ${A.frames.length}, text ${JSON.stringify(t.text.slice(0, 80))}, last ${JSON.stringify(A.frames.at(-1)?.json ?? A.error?.message).slice(0, 160)})`); }
    const bResult = await this.openB(surface, bKind, () => A.trace(surface.normalise, sent).text.length);
    if (aStrategy === "control") await A.done; else { A.abort(); await A.done; }
    const aTrace = A.trace(surface.normalise, sent);
    const aHeld = aTrace.text;
    const aLastCursor = surface.lastCursor(aTrace);
    await sleep(A_RETURNS_AFTER_MS);
    const aResult = aStrategy === "control" ? undefined : await this.returnA(surface, aStrategy, aHeld, aLastCursor);
    const settled = await surface.finished();
    const final = await surface.finalText();
    await sleep(500);
    aResult?.follower?.abort();
    await this.close(bResult);
    const complete = isCompleteList(final.text, token, LINES);
    const label = `${surface.name}`;
    const record = { surface: label, bKind, aStrategy, complete, finalLength: final.text.length, assistantMessages: final.count, settled };
    // B
    const bTrace = bResult.trace();
    record.B = { firstTextMs: bTrace.firstTextMs, firstEventMs: bTrace.firstEventMs, firstLiveMs: bTrace.firstLiveMs, ...(await this.judge(surface, bResult, bTrace, final.text)) };
    // A returned
    if (aResult) {
      const aTraceBack = aResult.trace();
      record.A = { firstTextMs: aTraceBack.firstTextMs, firstEventMs: aTraceBack.firstEventMs, firstLiveMs: aTraceBack.firstLiveMs, ...(await this.judge(surface, aResult, aTraceBack, final.text)) };
    } else {
      const full = A.trace(surface.normalise, sent);
      record.control = compareText("", full.endText, final.text);
    }
    this.samples.push(record);
  }

  // ── B opens ───────────────────────────────────────────────────────────

  async openB(surface, bKind, aLength) {
    const t0 = Date.now();
    if (bKind === "sse") {
      const snap = await surface.snapshot();
      const stale = aLength() - snap.partial.length;
      const follower = await surface.follow({ after: snap.cursor });
      return { kind: bKind, follower, stale, from: snap.cursor, held: snap.partial, seeded: true, trace: () => follower.trace(surface.normalise, t0, { text: snap.partial, at: snap.at }) };
    }
    if (bKind === "ws" && surface.name === "chat") {
      const snap = await surface.snapshot();
      const socket = await surface.openSocket();
      surface.subscribe(socket, snap.cursor);
      return { kind: bKind, socket, from: snap.cursor, held: snap.partial, seeded: true, trace: () => surface.socketTrace(socket, t0, { text: snap.partial, at: snap.at }) };
    }
    if (bKind === "ws") {
      const socket = await surface.openSocket();
      surface.subscribe(socket);
      await socket.waitFor("snapshot", (f) => f.type === "snapshot", 20_000);
      const snapshot = socket.frames.find((f) => f.type === "snapshot").snapshot;
      return { kind: bKind, socket, from: Number(snapshot.cursor), held: snapshot.partial ?? "", seeded: true, trace: () => surface.socketTrace(socket, t0) };
    }
    const cli = surface.cli([]);
    return { kind: bKind, cli, from: undefined, held: "", seeded: false, trace: () => { const t = new Trace(t0); if (cli.out) t.add({ delta: cli.out }, cli.firstOutAt); return t; } };
  }

  async close(b) { b.follower?.abort(); b.socket?.close(); if (b.cli) { if (!b.cli.exit) b.cli.kill9(); await b.cli.exited; } }

  /** What a client assembled: what it held when the live part began, plus the live part, against the stored message. */
  async judge(surface, b, trace, final) {
    // The CLI ends its output with one newline of its own; it is not part of the reply.
    const live = b.cli ? b.cli.out.replace(/\n$/, "") : b.seeded ? trace.endText.slice(b.held.length) : trace.endText;
    const out = { text: compareText(b.held, live, final), held_chars: b.held.length, deltas: trace.deltas, ...(b.stale !== undefined ? { partial_stale_chars: b.stale } : {}) };
    if (b.from !== undefined) {
      out.cursors = surface.name === "chat" ? cursorsAgainst(trace.cursors, await surface.journalAfter(b.from)) : cursorProblems(trace.cursors, b.from);
      out.cursor_count = trace.cursors.length;
    }
    return out;
  }

  // ── A returns ─────────────────────────────────────────────────────────

  async returnA(surface, strategy, heldBefore, lastCursor) {
    const t0 = Date.now();
    if (strategy === "after_cursor" || strategy === "last-event-id") {
      const follower = await surface.follow(strategy === "after_cursor" ? { after: lastCursor } : { lastEventId: lastCursor });
      // The client keeps the text it already showed; offsets in Chat deltas let it join the replay without repeats.
      return { held: heldBefore, seeded: true, from: lastCursor, follower, trace: () => follower.trace(surface.normalise, t0, { text: heldBefore, at: t0 }) };
    }
    if (strategy === "snapshot-then-attach") {
      const snap = await surface.snapshot(); const follower = await surface.follow({ after: snap.cursor });
      return { held: snap.partial, seeded: true, from: snap.cursor, follower, trace: () => follower.trace(surface.normalise, t0, { text: snap.partial, at: snap.at }) };
    }
    // attach-then-snapshot: attach live first (from now), then take the snapshot and add what arrives to its partial
    const follower = await surface.follow({});
    const snap = await surface.snapshot();
    return { held: snap.partial, seeded: true, from: undefined, follower, trace: () => follower.trace(surface.normalise, t0, { text: snap.partial, at: snap.at }) };
  }

  // ── Reporting ─────────────────────────────────────────────────────────

  report() {
    const { rec, samples } = this;
    rec.evidenceOf("samples", samples);
    rec.measure("trials_kept", samples.length); rec.measure("trials_discarded", this.discarded ?? 0);
    const surfaces = [...new Set(samples.map((s) => s.surface))];
    for (const surface of surfaces) {
      const stale = samples.filter((s) => s.surface === surface && s.B?.partial_stale_chars !== undefined).map((s) => s.B.partial_stale_chars);
      if (stale.length) rec.measure(`${surface}.snapshot_partial_chars_behind_the_live_stream_at_open`, spread(stale));
    }
    for (const surface of surfaces) {
      const mine = samples.filter((s) => s.surface === surface);
      rec.check(`${surface}: every trial's final message is the complete list and there is one assistant reply`, mine.every((s) => s.complete && s.settled), mine.filter((s) => !s.complete).map((s) => `${s.bKind}/${s.aStrategy}`));
      const control = mine.find((s) => s.control);
      if (control) rec.check(`${surface}: control (A never leaves) assembles exactly the stored message`, control.control.kind === "exact", control.control);
      // B: open mid-Run
      for (const bKind of [...new Set(mine.map((s) => s.bKind))]) {
        const bs = mine.filter((s) => s.bKind === bKind && s.B);
        const firstText = bs.map((s) => s.B.firstTextMs).filter((v) => v !== undefined);
        rec.measure(`${surface}.B.${bKind}.first_text_ms`, firstText.length ? spread(firstText) : undefined);
        const firstLive = bs.map((s) => s.B.firstLiveMs).filter((v) => v !== undefined);
        rec.measure(`${surface}.B.${bKind}.first_live_event_ms`, firstLive.length ? spread(firstLive) : undefined);
        rec.check(`${surface}: B over ${bKind} shows progress within ${PROGRESS_LIMIT_MS} ms (all ${bs.length} trials)`, firstText.length === bs.length && Math.max(...firstText) < PROGRESS_LIMIT_MS, firstText);
        const exact = bs.filter((s) => s.B.text.kind === "exact").length;
        rec.measure(`${surface}.B.${bKind}.text_vs_stored`, this.tally(bs.map((s) => s.B.text)));
        rec.check(`${surface}: B over ${bKind} assembles exactly the stored message (no missing or duplicated text)`, exact === bs.length, this.tally(bs.map((s) => s.B.text)));
        const cursorBs = bs.filter((s) => s.B.cursors);
        if (cursorBs.length) rec.check(`${surface}: B over ${bKind}: cursors strictly increasing, none missing or duplicated`, cursorBs.every((s) => s.B.cursors.length === 0), cursorBs.flatMap((s) => s.B.cursors));
      }
      // A returns
      for (const strategy of [...new Set(mine.map((s) => s.aStrategy))].filter((s) => s !== "control")) {
        const as = mine.filter((s) => s.aStrategy === strategy && s.A);
        const firstText = as.map((s) => s.A.firstTextMs).filter((v) => v !== undefined);
        rec.measure(`${surface}.A_return.${strategy}.first_text_ms`, firstText.length ? spread(firstText) : undefined);
        const firstLive = as.map((s) => s.A.firstLiveMs).filter((v) => v !== undefined);
        rec.measure(`${surface}.A_return.${strategy}.first_live_event_ms`, firstLive.length ? spread(firstLive) : undefined);
        rec.check(`${surface}: A returning by ${strategy} shows progress within ${PROGRESS_LIMIT_MS} ms (all ${as.length} trials)`, firstText.length === as.length && Math.max(...firstText) < PROGRESS_LIMIT_MS, firstText);
        rec.measure(`${surface}.A_return.${strategy}.text_vs_stored`, this.tally(as.map((s) => s.A.text)));
        rec.check(`${surface}: A returning by ${strategy} assembles exactly the stored message`, as.every((s) => s.A.text.kind === "exact"), this.tally(as.map((s) => s.A.text)));
        const cursorAs = as.filter((s) => s.A.cursors);
        if (cursorAs.length) rec.check(`${surface}: A returning by ${strategy}: cursors strictly increasing, none missing or duplicated`, cursorAs.every((s) => s.A.cursors.length === 0), cursorAs.flatMap((s) => s.A.cursors));
      }
    }
    this.defects(surfaces);
  }

  tally(texts) {
    const out = { exact: 0, missing: 0, duplicated: 0, mismatch: 0, missing_chars: [], duplicated_chars: [] };
    for (const t of texts) { out[t.kind] += 1; if (t.kind === "missing") out.missing_chars.push(t.missing); if (t.kind === "duplicated") out.duplicated_chars.push(t.duplicated); }
    return out;
  }

  defects(surfaces) {
    const { rec, samples } = this;
    const chatSamples = samples.filter((s) => s.surface === "chat");
    const lost = (strategy, field) => chatSamples.filter((s) => s[field] && s.aStrategy === strategy && s[field].text.kind !== "exact");
    const cursorOnly = ["after_cursor", "last-event-id"].flatMap((st) => lost(st, "A"));
    if (cursorOnly.length) rec.defect({
      title: "Chat: a client that resumes by cursor loses the text streamed while it was away",
      severity: "high",
      expected: "Spec: any client resumes from a cursor and sees no missing text (live deltas reach every observer).",
      actual: `Resuming at the last cursor (after_cursor / Last-Event-ID) replays only durable journal events. Text deltas carry no cursor and are not replayed, so ${cursorOnly.length} of ${chatSamples.filter((s) => ["after_cursor", "last-event-id"].includes(s.aStrategy) && s.A).length} returning clients assembled a reply with missing text (missing chars: ${cursorOnly.map((s) => s.A.text.missing).join(", ")}). The CLI's own resumable() stream uses exactly this path.`,
      repro: "POST a long message with Accept: text/event-stream, drop the connection mid-stream, reconnect with GET events?after_cursor=<last cursor> (or Last-Event-ID), compare the concatenated deltas with the stored assistant message."
    });
    const snapshotMiss = ["snapshot-then-attach", "attach-then-snapshot"].flatMap((st) => lost(st, "A"));
    if (snapshotMiss.length) rec.defect({
      title: "Chat: snapshot + live events cannot be joined without gaps or duplicates",
      severity: "high",
      expected: "Snapshot (partial output + cursor) then events after that cursor gives continuous text.",
      actual: `The snapshot's partial_output is saved at most once a second and live deltas have no cursor or offset, so the join is inexact: ${snapshotMiss.length} of ${chatSamples.filter((s) => ["snapshot-then-attach", "attach-then-snapshot"].includes(s.aStrategy) && s.A).length} returning clients got missing or duplicated text (${JSON.stringify(this.tally(snapshotMiss.map((s) => s.A.text)))}).`,
      repro: "While a Run streams, GET snapshot (runs[].partial_output, cursor), then GET events?after_cursor=<cursor> with Accept: text/event-stream; concatenate partial_output and the following deltas and compare with the stored message."
    });
    const watch = chatSamples.filter((s) => s.bKind === "cli" && s.B && s.B.text.kind !== "exact");
    if (watch.length) rec.defect({
      title: "hatch conversation watch started mid-Run prints only text from now",
      severity: "medium",
      expected: "Opening a conversation on another client mid-Run shows the answer so far.",
      actual: `watch has no snapshot step; ${watch.length} of ${chatSamples.filter((s) => s.bKind === "cli").length} watchers printed only the tail (missing chars ${watch.map((s) => s.B.text.missing ?? "?").join(", ")}).`,
      repro: "hatch ask <long prompt> --product P --conversation C --wait=1 ; hatch conversation watch C --product P two seconds later."
    });
    const wsOrSse = chatSamples.filter((s) => ["sse", "ws"].includes(s.bKind) && s.B && s.B.text.kind !== "exact");
    if (wsOrSse.length) rec.defect({
      title: "Chat: a client opened mid-Run (snapshot then subscribe) shows missing or duplicated text",
      severity: "high",
      expected: "Snapshot partial output plus the following events equals the stored reply.",
      actual: `${wsOrSse.length} of ${chatSamples.filter((s) => ["sse", "ws"].includes(s.bKind) && s.B).length} B clients (SSE / WebSocket) were not exact: ${JSON.stringify(this.tally(wsOrSse.map((s) => s.B.text)))}.`,
      repro: "Same as above, from a second client while the first is still streaming."
    });
  }
}
export default new CrossClient();
