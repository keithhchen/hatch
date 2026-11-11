import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RECORDER_PRELOAD = path.join(here, "modelRecorder.preload.mjs");
const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : "";

/** One real model call as the Runtime sent it, read from the recorder's JSONL (see modelRecorder.preload.mjs). */
export class ModelCall {
  constructor(request, usageRecord) {
    this.id = request.id; this.at = request.at; this.url = request.url;
    this.body = JSON.parse(request.body);
    this.usageRecord = usageRecord;
    const { body } = this;
    this.openai = Array.isArray(body.messages);
    this.messages = this.openai ? body.messages : body.contents ?? [];
    this.tools = body.tools ?? [];
    this.system = this.openai ? textOf(body.messages.find((m) => m.role === "system" || m.role === "developer")?.content) : textOf(body.systemInstruction?.parts);
  }
  get toolsSha() { return sha(this.tools); }
  get systemSha() { return sha(this.system); }
  get toolNames() { return this.tools.flatMap((t) => t.function?.name ?? t.functionDeclarations?.map((d) => d.name) ?? t.name ?? []); }
  get conversation() { return this.openai ? this.messages.filter((m) => m.role !== "system" && m.role !== "developer") : this.messages; }
  messageText(message) { return this.openai ? textOf(message?.content) : textOf(message?.parts); }
  get last() { return this.conversation.at(-1); }
  get lastText() { return this.messageText(this.last); }
  /** How many messages of the conversation carry a reminder, and whether the last one does. */
  get reminderMessages() { return this.conversation.filter((m) => this.messageText(m).includes("<system-reminder>")).length; }
  get reminderIsLast() { return this.lastText.includes("<system-reminder>"); }
  /** The conversation without the closing reminder message, serialized: what a cache can keep from one call to the next. */
  get stablePrefix() { return JSON.stringify(this.reminderIsLast ? this.conversation.slice(0, -1) : this.conversation); }
  /** The same conversation with every text-parts content flattened to a string: what a tokenizing cache sees. */
  get normalizedConversation() { return this.conversation.map((m) => Array.isArray(m.content) && m.content.every((part) => part?.type === "text") ? { ...m, content: textOf(m.content) } : m); }
  get normalizedStablePrefix() { const c = this.normalizedConversation; return JSON.stringify(this.reminderIsLast ? c.slice(0, -1) : c); }
  get toolResults() { return this.openai ? this.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content)) : this.messages.flatMap((m) => (m.parts ?? []).filter((p) => p.functionResponse).map((p) => JSON.stringify(p.functionResponse))); }
  get toolCalls() { return this.openai ? this.messages.flatMap((m) => (m.tool_calls ?? []).map((c) => ({ name: c.function?.name, args: c.function?.arguments }))) : this.messages.flatMap((m) => (m.parts ?? []).filter((p) => p.functionCall).map((p) => ({ name: p.functionCall.name, args: JSON.stringify(p.functionCall.args) }))); }
  /** Provider usage, normalized. `cached` is what the provider says it served from its cache. */
  get usage() {
    const u = this.usageRecord?.usage;
    if (!u) return undefined;
    if (u.promptTokenCount !== undefined) return { prompt: u.promptTokenCount, cached: u.cachedContentTokenCount ?? 0, completion: u.candidatesTokenCount, raw: u };
    return { prompt: u.prompt_tokens, cached: u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0, completion: u.completion_tokens, raw: u };
  }
}

/** The model calls one Stack's Runtime made, in order. */
export class ModelRecords {
  constructor(file = path.join(os.tmpdir(), "hatch-verify-model-calls.jsonl")) { this.file = file; }
  /** Starts a clean record; call it when the scenario runs, before any model call. */
  reset() { writeFileSync(this.file, ""); }
  /** Stack options that make the Runtime record its model calls. */
  stackOptions() { return { runtimeNodeArgs: ["--import", RECORDER_PRELOAD], runtimeEnv: { VERIFY_MODEL_RECORD: this.file } }; }
  calls() {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const usage = new Map(lines.filter((l) => l.kind === "usage").map((l) => [l.id, l]));
    return lines.filter((l) => l.kind === "request").map((l) => new ModelCall(l, usage.get(l.id)));
  }
  count() { return this.calls().length; }
  since(count) { return this.calls().slice(count); }
}

export function commonPrefix(a, b) { let i = 0; const n = Math.min(a.length, b.length); while (i < n && a[i] === b[i]) i++; return i; }
