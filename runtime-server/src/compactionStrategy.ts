import { randomUUID } from "node:crypto";
import type { UsageSink } from "./usage/usage.js";

/**
 * One compaction strategy for Chat and Studio. It knows nothing about either:
 * each system supplies a CompactionAdapter that describes its messages and
 * performs the model call. The strategy decides what to prune, where to cut,
 * what must survive, and how to fail.
 */

/** What the strategy needs to know about one message. */
export type Entry = {
  role: "user" | "assistant" | "tool" | "summary";
  tokens: number;
  /** What the model reads: images as path labels, never a system reminder. */
  text: string;
  /** Assistant: the tool calls it makes. */
  callIds?: string[];
  /** Tool result: the call it answers. */
  resultFor?: string;
  toolName?: string;
  /** Files an assistant message's tool calls read or write. */
  paths?: Array<{ path: string; mode: "read" | "write" }>;
  /** User: who wrote it, when it is not the owner. */
  sender?: string;
  pruned?: boolean;
};

export type SummarizeInput<M> = { messages: M[]; previous?: string; instructions: string; signal: AbortSignal; /** Told of each model call the summary makes. */ usage?: UsageSink };

export interface CompactionAdapter<M> {
  describe(message: M): Entry;
  /** The same tool result with its content replaced by a placeholder; the call id stays. */
  prune(message: M, placeholder: string): M;
  summaryMessage(summary: string, tokensBefore: number): M;
  /** The model call. A test adapter answers without a model. */
  summarize(input: SummarizeInput<M>): Promise<string>;
}

/** Durable memory written before history is replaced, if the conversation type has a memory layer. */
export interface CompactionMemory<M> {
  flush(dropped: M[], signal: AbortSignal): Promise<void>;
}

export type CompactionPolicy = {
  /** Summarize at or above this many tokens. */
  trigger: number;
  /** Where the next reply no longer fits: a turn that is about to run waits for a summary only from here. */
  hard: number;
  /** Prune old tool results at or above this many tokens, once the provider cache has expired. */
  prune: number;
  /** Verbatim tail kept after a summary. */
  tail: number;
  cacheTtlMs: number;
  minPruneTokens: number;
  timeoutMs: number;
  maxOverflowRetries: number;
};

const DEFAULT_OUTPUT_TOKENS = 16_384;

/** Everything derives from the model's window; nothing is a fixed token count. */
export function policyFor(contextWindow: number, options: { outputTokens?: number; cacheTtlMs?: number; timeoutMs?: number } = {}): CompactionPolicy {
  if (!Number.isFinite(contextWindow) || contextWindow < 4_096) throw new Error("A context window of at least 4096 tokens is required");
  const reserve = (options.outputTokens ?? DEFAULT_OUTPUT_TOKENS) + Math.floor(contextWindow * 0.1);
  const trigger = Math.max(1_024, contextWindow - reserve);
  return {
    trigger,
    hard: Math.max(trigger, contextWindow - (options.outputTokens ?? DEFAULT_OUTPUT_TOKENS) - Math.floor(contextWindow * 0.05)),
    prune: Math.floor(contextWindow * 0.5),
    tail: Math.floor(contextWindow * 0.15),
    cacheTtlMs: options.cacheTtlMs ?? 5 * 60_000,
    minPruneTokens: 256,
    timeoutMs: options.timeoutMs ?? 120_000,
    maxOverflowRetries: 2
  };
}

export type CompactionRequest = {
  now: number;
  /** When the provider last saw this prefix; the cache is alive for `cacheTtlMs` after. */
  cacheTouchedAt?: number;
  signal: AbortSignal;
  /** Compact whatever the size: a manual request, or recovery from a provider overflow. */
  force?: boolean;
  /** A turn is waiting: summarize only at the hard limit, because a summary costs a model call and a new message would pay for it. Pruning is free and still runs. */
  turnWaiting?: boolean;
  /** Recovery halves the tail on every attempt. */
  tailScale?: number;
  /** A failed summary normally degrades to a bounded tail. A user who asked for it gets the error instead. */
  onFailure?: "degrade" | "throw";
  /** Who pays for the summary. */
  usage?: UsageSink;
};

export type CompactionOutcome<M> =
  | { kind: "none" }
  | { kind: "pruned"; messages: M[]; tokensBefore: number; tokensAfter: number; pruned: number }
  | { kind: "summarized"; messages: M[]; summary: string; tokensBefore: number; tokensAfter: number; replaced: number; retried: boolean }
  | { kind: "degraded"; messages: M[]; tokensBefore: number; tokensAfter: number; dropped: number; reason: string };

/** Aborting the caller's signal means "stop now"; it is never turned into a degraded result. */
export class CompactionAborted extends Error {
  constructor(message = "Compaction was preempted") {
    super(message);
    this.name = "CompactionAborted";
  }
}

const IDENTIFIER_PATTERNS = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /https?:\/\/[^\s)>\]"'`]+/g,
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  /\b[a-z][a-z0-9]{1,12}_[A-Za-z0-9]{6,}\b/g,
  /\b[A-Z]{2,10}-\d{1,8}\b/g,
  /\b[0-9a-f]{12,}\b/gi,
  /\b\d{6,}\b/g
];
const MAX_IDENTIFIERS = 100;

export type Preserved = {
  unfinished: string[];
  read: string[];
  written: string[];
  senders: string[];
  identifiers: string[];
};

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();
const isFinalAnswer = (entry: Entry): boolean => entry.role === "assistant" && !entry.callIds?.length && entry.text.trim().length > 0;

const PATH_LIKE = /(?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+/g;

/**
 * What a summary must not lose, computed from the first `head` messages, the ones it replaces: code decides
 * this, not the model. Whether a request was answered looks at every message, because the answer may be in the tail.
 */
export function preservedFrom(entries: Entry[], head = entries.length): Preserved {
  const unfinished: string[] = [];
  entries.slice(0, head).forEach((entry, index) => {
    if (entry.role !== "user") return;
    const answered = entries.slice(index + 1).some((later, offset) => isFinalAnswer(later) && !entries.slice(index + 1, index + 1 + offset).some((between) => between.role === "user"));
    if (!answered) unfinished.push(collapse(entry.text));
  });
  const replaced = entries.slice(0, head);
  const paths = (mode: "read" | "write") => [...new Set(replaced.flatMap((entry) => entry.paths ?? []).filter((path) => path.mode === mode).map((path) => path.path))];
  const identifiers = new Set<string>();
  // Newest first, so the cap keeps the identifiers the work is most likely still about. Tool results are excluded: they would flood the list.
  for (const entry of [...replaced].reverse()) {
    if (entry.role === "tool") continue;
    // An earlier summary carries its paths as text.
    for (const pattern of entry.role === "summary" ? [...IDENTIFIER_PATTERNS, PATH_LIKE] : IDENTIFIER_PATTERNS) for (const match of entry.text.match(pattern) ?? []) if (identifiers.size < MAX_IDENTIFIERS) identifiers.add(match);
  }
  return {
    unfinished,
    read: paths("read"),
    written: paths("write"),
    senders: [...new Set(replaced.flatMap((entry) => entry.sender ?? []))],
    identifiers: [...identifiers]
  };
}

/** What a finished summary still lacks. */
export function missingFrom(summary: string, preserved: Preserved): Preserved {
  const lower = summary.toLowerCase();
  const compact = collapse(summary).toLowerCase();
  const lacks = (item: string): boolean => !lower.includes(item.toLowerCase());
  return {
    unfinished: preserved.unfinished.filter((request) => !compact.includes(request.toLowerCase())),
    read: preserved.read.filter(lacks),
    written: preserved.written.filter(lacks),
    senders: preserved.senders.filter(lacks),
    identifiers: preserved.identifiers.filter(lacks)
  };
}

const isEmpty = (preserved: Preserved): boolean => Object.values(preserved).every((list) => list.length === 0);

const render = (preserved: Preserved): string => [
  preserved.unfinished.length ? `Unfinished user requests (verbatim):\n${preserved.unfinished.map((request) => `- ${request}`).join("\n")}` : "",
  preserved.read.length ? `Files read: ${preserved.read.join(", ")}` : "",
  preserved.written.length ? `Files written: ${preserved.written.join(", ")}` : "",
  preserved.senders.length ? `Senders: ${preserved.senders.join(", ")}` : "",
  preserved.identifiers.length ? `Identifiers: ${preserved.identifiers.join(", ")}` : ""
].filter(Boolean).join("\n");

const INSTRUCTIONS = "Keep the structured format. Preserve exactly: every unfinished user request, every file path read or written, who said what when more than one person wrote, and every identifier (ids, urls, numbers, names) as written. Never invent work that was not done.";

export class CompactionStrategy<M> {
  constructor(
    private readonly adapter: CompactionAdapter<M>,
    readonly policy: CompactionPolicy,
    private readonly memory?: CompactionMemory<M>
  ) {}

  tokensOf(messages: M[]): number {
    return messages.reduce((sum, message) => sum + this.adapter.describe(message).tokens, 0);
  }

  private cold(request: Pick<CompactionRequest, "now" | "cacheTouchedAt">): boolean {
    return request.now - (request.cacheTouchedAt ?? Number.NEGATIVE_INFINITY) > this.policy.cacheTtlMs;
  }

  private limit(request: Pick<CompactionRequest, "turnWaiting">): number {
    return request.turnWaiting ? this.policy.hard : this.policy.trigger;
  }

  /** Whether any stage has work: cheap, so a caller announces `compacting` only when something will happen. */
  wants(messages: M[], request: Pick<CompactionRequest, "now" | "cacheTouchedAt" | "force" | "turnWaiting">): boolean {
    if (request.force) return true;
    const entries = messages.map((message) => this.adapter.describe(message));
    const tokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
    if (tokens >= this.limit(request)) return true;
    if (tokens < this.policy.prune || !this.cold(request)) return false;
    const cut = this.cutFor(entries, this.policy.tail);
    return entries.some((entry, index) => index < cut && this.prunable(entry));
  }

  private prunable(entry: Entry): boolean {
    return entry.role === "tool" && !entry.pruned && entry.tokens >= this.policy.minPruneTokens;
  }

  /** The stage order is fixed: prune old tool results (only once the cache has expired), then summarize. */
  async compact(messages: M[], request: CompactionRequest): Promise<CompactionOutcome<M>> {
    if (!this.wants(messages, request)) return { kind: "none" };
    const entries = messages.map((message) => this.adapter.describe(message));
    const tokensBefore = entries.reduce((sum, entry) => sum + entry.tokens, 0);
    let cut = this.cutFor(entries, Math.floor(this.policy.tail * (request.tailScale ?? 1)));
    // Asked to compact a history that fits the tail: keep only the last turn, so there is something older to summarize.
    if (request.force && cut <= 0) cut = this.cutFor(entries, 0);
    // Everything is the tail: there is nothing older to prune or summarize unless the context really is too big.
    if (cut <= 0 && tokensBefore < this.limit(request)) return { kind: "none" };
    let current = messages;
    let pruned = 0;
    if (this.cold(request)) ({ messages: current, pruned } = this.prune(messages, entries, cut));
    const afterPrune = this.tokensOf(current);
    if (!request.force && afterPrune < this.limit(request)) {
      return pruned ? { kind: "pruned", messages: current, tokensBefore, tokensAfter: afterPrune, pruned } : { kind: "none" };
    }
    try {
      return await this.summarize(messages, current, entries, cut, tokensBefore, request.signal, request.usage);
    } catch (error) {
      if (request.signal.aborted) throw new CompactionAborted(String(request.signal.reason ?? "aborted"));
      if (request.onFailure === "throw") throw error;
      return this.degrade(messages, entries, tokensBefore, Math.floor(this.policy.tail * (request.tailScale ?? 1) / 2), error instanceof Error ? error.message : String(error));
    }
  }

  /** The first index of the verbatim tail: a boundary that never separates a tool call from its results. */
  cutFor(entries: Entry[], budget: number): number {
    let tokens = 0;
    let index = entries.length;
    while (index > 0 && (tokens + entries[index - 1]!.tokens <= budget || index === entries.length)) { tokens += entries[index - 1]!.tokens; index--; }
    while (index > 0 && entries[index]?.role === "tool") index--;
    return index;
  }

  private prune(messages: M[], entries: Entry[], cut: number): { messages: M[]; pruned: number } {
    let pruned = 0;
    const next = messages.map((message, index) => {
      const entry = entries[index]!;
      if (index >= cut || !this.prunable(entry)) return message;
      pruned++;
      return this.adapter.prune(message, `[Tool result pruned: ${entry.toolName ?? "tool"}, about ${entry.tokens} tokens. Run the tool again if the output is needed.]`);
    });
    return { messages: next, pruned };
  }

  private async summarize(original: M[], current: M[], entries: Entry[], cut: number, tokensBefore: number, caller: AbortSignal, usage?: UsageSink): Promise<CompactionOutcome<M>> {
    if (cut <= 0) throw new Error("There is nothing older than the verbatim tail to summarize");
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new CompactionTimeout()), this.policy.timeoutMs);
    const signal = AbortSignal.any([caller, timeout.signal]);
    try {
      const head = current.slice(0, cut);
      const headEntries = entries.slice(0, cut);
      const previous = headEntries[0]?.role === "summary" ? headEntries[0].text : undefined;
      const body = previous ? head.slice(1) : head;
      const preserved = preservedFrom(entries, cut);
      await this.memory?.flush(original.slice(0, cut), signal).catch((error: unknown) => { if (signal.aborted) throw error; });
      const ask = (instructions: string) => { signal.throwIfAborted(); return this.adapter.summarize({ messages: body, previous, instructions, signal, usage }); };
      let summary = await ask(`${INSTRUCTIONS}\n${render(preserved)}`);
      const lacking = missingFrom(summary, preserved);
      let retried = false;
      if (!isEmpty(lacking)) {
        retried = true;
        summary = await ask(`${INSTRUCTIONS}\nThe previous attempt left these out; include all of them:\n${render(lacking)}`);
      }
      // The retry can fall short too; what is still missing is appended as written, so nothing is lost.
      const still = missingFrom(summary, preserved);
      if (!isEmpty(still)) summary = `${summary}\n\n## Preserved details\n${render(still)}`;
      const messages = [this.adapter.summaryMessage(summary, tokensBefore), ...current.slice(cut)];
      return { kind: "summarized", messages, summary, tokensBefore, tokensAfter: this.tokensOf(messages), replaced: cut, retried };
    } finally {
      clearTimeout(timer);
    }
  }

  /** On failure or timeout: a bounded verbatim tail and a note of what was dropped. */
  private degrade(messages: M[], entries: Entry[], tokensBefore: number, budget: number, reason: string): CompactionOutcome<M> {
    const cut = this.cutFor(entries, budget);
    const dropped = cut;
    const tail = messages.slice(cut).map((message, offset) => {
      const entry = entries[cut + offset]!;
      return entry.role === "tool" && entry.tokens > budget ? this.adapter.prune(message, `[Tool result pruned: ${entry.toolName ?? "tool"}, about ${entry.tokens} tokens.]`) : message;
    });
    const note = `${dropped} earlier message${dropped === 1 ? " was" : "s were"} dropped to fit the context window and cannot be recovered.`;
    const next = dropped > 0 ? [this.adapter.summaryMessage(note, tokensBefore), ...tail] : tail;
    return { kind: "degraded", messages: next, tokensBefore, tokensAfter: this.tokensOf(next), dropped, reason };
  }
}

class CompactionTimeout extends Error {
  constructor() {
    super("Compaction timed out");
    this.name = "CompactionTimeout";
  }
}

/** A durable compaction id: events, the transcript checkpoint and the channel's one notice all carry it. */
export const newCompactionId = (): string => `cmp_${randomUUID().replaceAll("-", "")}`;

/**
 * Background work that yields to a new message. `preempt` aborts the job and
 * waits for it to end, so nothing is half-written when the message proceeds.
 */
export class BackgroundCompactor<K> {
  private readonly jobs = new Map<K, { controller: AbortController; done: Promise<void>; timer?: NodeJS.Timeout }>();

  /** Starts `run` after `delayMs` unless a job for this key is already pending. A job that returns `{ again }` runs once more after that many ms. */
  schedule(key: K, run: (signal: AbortSignal) => Promise<void | { again: number }>, delayMs = 0): boolean {
    if (this.jobs.has(key)) return false;
    const controller = new AbortController();
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const job: { controller: AbortController; done: Promise<void>; timer?: NodeJS.Timeout } = { controller, done };
    this.jobs.set(key, job);
    const start = (): void => {
      let again: number | undefined;
      void (async () => { try { if (!controller.signal.aborted) again = (await run(controller.signal))?.again; } catch { /* the job reports its own failure */ } })()
        .finally(() => {
          if (this.jobs.get(key) === job) this.jobs.delete(key);
          release();
          if (again !== undefined && !controller.signal.aborted) this.schedule(key, run, again);
        });
    };
    if (delayMs > 0) { job.timer = setTimeout(start, delayMs); job.timer.unref(); } else start();
    return true;
  }

  async preempt(key: K): Promise<void> {
    const job = this.jobs.get(key);
    if (!job) return;
    job.controller.abort(new CompactionAborted());
    if (job.timer) { clearTimeout(job.timer); this.jobs.delete(key); return; }
    await job.done;
  }

  /** Waits for a job that is running to finish; one that is only waiting for its delay is cancelled, since it has not begun. */
  async settle(key: K): Promise<void> {
    const job = this.jobs.get(key);
    if (job && !job.timer) await job.done;
    else await this.preempt(key);
  }

  has(key: K): boolean { return this.jobs.has(key); }

  async drain(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map((key) => this.preempt(key)));
  }
}
