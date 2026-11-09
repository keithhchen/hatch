import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { CLI_BIN } from "./clients.mjs";
import { sleep } from "./util.mjs";

/** Helpers for scenarios 2 (close a client mid-Run) and 3 (cross-client resume). Verification tool only. */

export const newToken = () => randomUUID().slice(0, 8).toUpperCase();
/** A long-ish answer so streaming takes seconds. Its first line carries a token and the numbering ends at `lines`, so a complete reply is recognisable. */
export const listPrompt = (token, lines = 40) => `Start with the line LIST-${token} and then write a numbered list of ${lines} short lines, one short sentence each, about different fruits. Output nothing else.`;
export const isCompleteList = (text, token, lines = 40) => text.includes(`LIST-${token}`) && new RegExp(`(^|\\n)${lines}\\.`).test(text);

export const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const median = (values) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : undefined; };
export const spread = (values) => ({ n: values.length, min: Math.min(...values), median: median(values), max: Math.max(...values) });

/** Text of a Chat history message, whichever of its fields carries it. */
export const chatText = (message) => message.content ?? message.text ?? (Array.isArray(message.parts) ? message.parts.map((p) => p.text ?? "").join("") : "") ?? "";

// ── What a client sees of a Run: normalised events of Chat (journal.event / assistant.delta) and Studio (log events) ──

export const fromChat = (json) => {
  if (json?.type === "assistant.delta") return json.delta?.kind === "text" ? { delta: json.delta.content, offset: json.delta.offset } : { other: true };
  if (json?.type === "journal.event") return { cursor: Number(json.cursor), tag: json.journal_type, ended: json.journal_type === "run.state" && TERMINAL.has(json.payload?.status) };
  return { other: true };
};
export const fromStudio = (cursor, event) => event?.type === "delta" ? { cursor: Number(cursor), delta: String(event.text ?? ""), tag: "delta" } : { cursor: Number(cursor), tag: event?.type, ended: event?.type === "run_end", messageEnd: event?.type === "message_end" };

/** Everything one client saw: the text it assembled, its cursors, and when the first progress and the end arrived. */
export class Trace {
  constructor(startedAt = Date.now()) { this.startedAt = startedAt; this.text = ""; this.deltas = 0; this.cursors = []; this.tags = []; this.firstEventMs = undefined; this.firstTextMs = undefined; this.firstLiveMs = undefined; this.endedMs = undefined; }
  add(norm, at = Date.now()) {
    if (norm.other && norm.delta === undefined && norm.cursor === undefined) { this.firstEventMs ??= at - this.startedAt; return; }
    this.firstEventMs ??= at - this.startedAt;
    if (norm.delta !== undefined || norm.cursor !== undefined) this.firstLiveMs ??= at - this.startedAt;
    // A delta that says where it sits in the Run's text is joined by that position: what the client holds is skipped.
    if (norm.offset !== undefined && norm.delta !== undefined) norm = { ...norm, delta: norm.delta.slice(Math.max(0, this.text.length - norm.offset)) };
    if (norm.delta !== undefined && norm.delta !== "") { this.text += norm.delta; this.deltas += 1; this.firstTextMs ??= at - this.startedAt; }
    if (norm.cursor !== undefined) { this.cursors.push(norm.cursor); this.tags.push(norm.tag); }
    if (norm.messageEnd) { this.lastMessage = this.text; this.text = ""; }
    if (norm.ended) this.endedMs ??= at - this.startedAt;
  }
  /** The text of the last finished message, else what is in progress. */
  get endText() { return this.lastMessage ?? this.text; }
  /** Prior text the client already holds (a snapshot's partial output) counts as progress at `at`. */
  seed(text, at = Date.now()) { if (text) { this.text = text + this.text; this.firstTextMs ??= at - this.startedAt; this.firstEventMs ??= at - this.startedAt; } }
}

/** Cursors must climb by exactly one: nothing missing, nothing twice. `from` is the cursor the client resumed after. */
export function cursorProblems(cursors, from) {
  const problems = [];
  let previous = from;
  for (const cursor of cursors) {
    if (previous !== undefined && cursor === previous) problems.push(`duplicate ${cursor}`);
    else if (previous !== undefined && cursor < previous) problems.push(`out of order ${cursor} after ${previous}`);
    else if (previous !== undefined && cursor > previous + 1) problems.push(`gap ${previous + 1}..${cursor - 1}`);
    previous = cursor;
  }
  return problems;
}

/** `held` is text a client had before the live part (a prior stream or a snapshot's partial); `live` what it then received. */
export function compareText(held, live, final) {
  const assembled = held + live;
  if (assembled === final) return { kind: "exact", missing: 0, duplicated: 0 };
  if (final.startsWith(held) && final.endsWith(live)) {
    const delta = final.length - assembled.length;
    if (delta > 0) return { kind: "missing", missing: delta, duplicated: 0, lost: final.slice(held.length, final.length - live.length).slice(0, 80) };
    return { kind: "duplicated", missing: 0, duplicated: -delta };
  }
  return { kind: "mismatch", missing: undefined, duplicated: undefined, heldTail: held.slice(-40), liveHead: live.slice(0, 40), liveTail: live.slice(-40), finalTail: final.slice(-40), liveInFinal: final.includes(live), finalLen: final.length };
}

/** Waits until `probe` is truthy; returns the elapsed ms, undefined on timeout. */
export async function waitMs(probe, { timeoutMs = 120_000, everyMs = 100 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { if (await probe()) return Date.now() - started; await sleep(everyMs); }
  return undefined;
}

/** The real `hatch` CLI as a child process, plain (not --json) so a stream prints as it arrives. */
export class CliProcess {
  constructor(stack, apiKey, args) {
    const home = path.join(stack.root, `cli-home-${randomUUID().slice(0, 6)}`);
    mkdirSync(home, { recursive: true });
    this.out = ""; this.err = ""; this.firstOutAt = undefined; this.startedAt = Date.now(); this.waiters = [];
    this.child = spawn(process.execPath, [CLI_BIN, ...args], { env: { PATH: process.env.PATH, HOME: home, HATCH_API_URL: stack.url, HATCH_API_KEY: apiKey }, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout.on("data", (d) => { this.firstOutAt ??= Date.now(); this.out += d; this.tick(); });
    this.child.stderr.on("data", (d) => { this.err += d; });
    this.exited = new Promise((resolve) => this.child.on("exit", (code, signal) => { this.exit = { code, signal, at: Date.now() }; this.tick(); resolve(this.exit); }));
  }
  tick() { this.waiters = this.waiters.filter((w) => !w()); }
  /** Resolves when the output satisfies `predicate`; rejects on exit or timeout. */
  waitOutput(what, predicate, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI: timed out waiting for ${what}; out=${JSON.stringify(this.out.slice(0, 200))} err=${JSON.stringify(this.err.slice(0, 300))}`)), timeoutMs);
      const check = () => { if (predicate(this.out)) { clearTimeout(timer); resolve(this.out); return true; } if (this.exit) { clearTimeout(timer); reject(new Error(`CLI exited (${this.exit.code}/${this.exit.signal}) before ${what}; out=${JSON.stringify(this.out.slice(0, 200))} err=${JSON.stringify(this.err.slice(0, 300))}`)); return true; } return false; };
      if (!check()) this.waiters.push(check);
    });
  }
  kill9() { const at = Date.now(); this.child.kill("SIGKILL"); return at; }
}

/** Cursors a client received against the cursors the product's journal lists after the resume point: same set, in order. */
export function cursorsAgainst(received, listed) {
  const problems = [];
  for (let i = 1; i < received.length; i++) if (received[i] <= received[i - 1]) problems.push(`not strictly increasing at ${received[i - 1]} -> ${received[i]}`);
  const missing = listed.filter((c) => !received.includes(c)); const extra = received.filter((c) => !listed.includes(c));
  if (missing.length) problems.push(`missing ${missing.join(",")}`);
  if (extra.length) problems.push(`not in the journal ${extra.join(",")}`);
  return problems;
}

/** Records the frames of an async stream in the background so a scenario can inspect them at any moment. */
export class FrameRecorder {
  constructor(frames, controller) { this.frames = []; this.controller = controller; this.done = (async () => { try { for await (const frame of frames) this.frames.push(frame); } catch (error) { this.error = error; } this.ended = true; })(); }
  abort() { this.controller.abort(); }
  /** A Trace built from the frames so far. */
  trace(normalise, startedAt, seed) { const t = new Trace(startedAt); if (seed) t.seed(seed.text, seed.at); for (const f of this.frames) t.add(normalise(f), f.at); return t; }
}
