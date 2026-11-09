import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BackgroundCompactor, CompactionAborted, CompactionStrategy, policyFor,
  type CompactionAdapter, type CompactionPolicy, type Entry
} from "./compactionStrategy.js";

type Msg = { role: Entry["role"]; text: string; tokens: number; callIds?: string[]; resultFor?: string; toolName?: string; paths?: Entry["paths"]; sender?: string; pruned?: boolean };

/** A test-only model provider: it answers from a script, never from a real model. */
function adapter(answers: Array<string | Error | (() => Promise<string>)>) {
  const asked: Array<{ instructions: string; messages: Msg[]; previous?: string }> = [];
  const port: CompactionAdapter<Msg> = {
    describe: (message) => message,
    prune: (message, placeholder) => ({ ...message, text: placeholder, tokens: 20, pruned: true }),
    summaryMessage: (summary, tokensBefore) => ({ role: "summary", text: summary, tokens: Math.ceil(summary.length / 4), ...(tokensBefore ? {} : {}) }),
    async summarize(input) {
      asked.push({ instructions: input.instructions, messages: input.messages, previous: input.previous });
      const answer = answers.shift() ?? "## Goal\nfallback";
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer() : answer;
    }
  };
  return { port, asked };
}

const policy = (overrides: Partial<CompactionPolicy> = {}): CompactionPolicy => ({ ...policyFor(10_000, { outputTokens: 1_000 }), ...overrides });
const user = (text: string, extra: Partial<Msg> = {}): Msg => ({ role: "user", text, tokens: 100, ...extra });
const answer = (text: string): Msg => ({ role: "assistant", text, tokens: 100 });
const call = (id: string, extra: Partial<Msg> = {}): Msg => ({ role: "assistant", text: "", tokens: 50, callIds: [id], ...extra });
const result = (id: string, tokens: number, name = "file_read"): Msg => ({ role: "tool", text: "x".repeat(tokens), tokens, resultFor: id, toolName: name });
const live = (): { now: number; cacheTouchedAt: number; signal: AbortSignal } => ({ now: 1_000, cacheTouchedAt: 1_000, signal: new AbortController().signal });
const cold = () => ({ ...live(), now: 10_000_000 });

test("the policy derives from the model window, not from a fixed count", () => {
  const small = policyFor(32_000);
  const large = policyFor(256_000);
  assert.ok(small.trigger < large.trigger && small.tail < large.tail && small.prune < large.prune);
  assert.ok(large.trigger < 256_000 && large.tail > 0);
  assert.equal(policyFor(256_000, { outputTokens: 32_768 }).trigger, 256_000 - 32_768 - 25_600);
});

test("old tool results are pruned only after the cache expired; a live cache keeps the prefix byte for byte", async () => {
  const history = [user("start"), call("a"), result("a", 3_000), call("b"), result("b", 3_000), user("now"), answer("done")];
  const { port } = adapter([]);
  const strategy = new CompactionStrategy(port, policy({ prune: 1_000, trigger: 50_000, tail: 300 }));
  assert.deepEqual(await strategy.compact(history, live()), { kind: "none" });
  const outcome = await strategy.compact(history, cold());
  assert.equal(outcome.kind, "pruned");
  if (outcome.kind !== "pruned") return;
  assert.equal(outcome.pruned, 2);
  assert.ok(outcome.tokensAfter < outcome.tokensBefore);
  assert.match(outcome.messages[2]!.text, /Tool result pruned: file_read/);
  assert.equal(outcome.messages[1], history[1]);
  assert.deepEqual(outcome.messages.slice(5), history.slice(5));
});

test("summarizing follows pruning and never separates a tool call from its results", async () => {
  const history = [user("start"), call("a"), result("a", 800), call("b"), result("b", 800), result("b2", 800), answer("mid"), user("tail question"), call("c"), result("c", 200)];
  history[3] = { ...call("b"), callIds: ["b", "b2"] };
  const { port, asked } = adapter(["## Goal\nsummary"]);
  const strategy = new CompactionStrategy(port, policy({ prune: 500, trigger: 1_000, tail: 600 }));
  const outcome = await strategy.compact(history, live());
  assert.equal(outcome.kind, "summarized");
  if (outcome.kind !== "summarized") return;
  const kept = outcome.messages.slice(1);
  for (const message of kept) if (message.role === "tool") assert.ok(kept.some((other) => other.callIds?.includes(message.resultFor!)), "a kept result keeps its call");
  assert.equal(kept[0]!.role === "tool", false);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.messages.some((message) => message.role === "tool" && message.resultFor === "c"), false);
});

test("a summary keeps unfinished requests, file paths, senders and identifiers; one retry restores what the model dropped", async () => {
  const id = "3f2b8c1e-aaaa-4bbb-8ccc-1234567890ab";
  const history = [
    user("Alice: please reconcile order 88231045 for ticket ABC-123", { sender: "Alice" }),
    answer("done with the first"),
    user(`Bob: also check ${id} and https://example.com/report?id=7`, { sender: "Bob" }),
    call("r", { paths: [{ path: "notes/plan.md", mode: "read" }, { path: "out/result.csv", mode: "write" }] }),
    result("r", 400),
    user("filler question", {}), answer("filler answer"), user("tail", {}), answer("tail answer")
  ];
  const { port, asked } = adapter(["## Goal\nreconcile things", `## Goal\nAlice 88231045 ABC-123 ${id} https://example.com/report?id=7 notes/plan.md out/result.csv Bob Alice: please reconcile order 88231045 for ticket ABC-123 Bob: also check ${id} https://example.com/report?id=7`]);
  const strategy = new CompactionStrategy(port, policy({ prune: 100, trigger: 300, tail: 250 }));
  const outcome = await strategy.compact(history, live());
  assert.equal(outcome.kind, "summarized");
  if (outcome.kind !== "summarized") return;
  assert.equal(outcome.retried, true);
  assert.equal(asked.length, 2);
  assert.match(asked[1]!.instructions, /88231045/);
  assert.match(asked[1]!.instructions, /notes\/plan\.md/);
  for (const item of ["88231045", "ABC-123", id, "https://example.com/report?id=7", "notes/plan.md", "out/result.csv", "Alice", "Bob"]) assert.ok(outcome.summary.includes(item), item);
});

test("what a stubborn model still omits after the retry is appended as written", async () => {
  const history = [user("Fix ticket XYZ-9 in src/app.ts", {}), call("w", { paths: [{ path: "src/app.ts", mode: "write" }] }), result("w", 300), answer("ok"), user("more", {}), answer("fine"), user("tail", {}), answer("end")];
  const { port } = adapter(["## Goal\nvague", "## Goal\nstill vague"]);
  const strategy = new CompactionStrategy(port, policy({ prune: 50, trigger: 200, tail: 150 }));
  const outcome = await strategy.compact(history, live());
  assert.equal(outcome.kind, "summarized");
  if (outcome.kind !== "summarized") return;
  assert.match(outcome.summary, /## Preserved details/);
  assert.match(outcome.summary, /Files written: src\/app\.ts/);
  assert.match(outcome.summary, /XYZ-9/);
});

test("durable memory is written before history is replaced", async () => {
  const order: string[] = [];
  const { port } = adapter([async () => { order.push("summary"); return "## Goal\nx"; }] as never);
  const strategy = new CompactionStrategy(port, policy({ prune: 50, trigger: 200, tail: 150 }), { flush: async (dropped) => { order.push(`memory:${dropped.length}`); } });
  const history = [user("a"), answer("b"), user("c"), answer("d"), user("e"), answer("f"), user("g")];
  await strategy.compact(history, live());
  assert.deepEqual(order.slice(0, 2), ["memory:" + order[0]!.split(":")[1], "summary"]);
  assert.ok(order[0]!.startsWith("memory:"));
});

test("a failed summary degrades to a bounded verbatim tail with a note of what was dropped", async () => {
  const history = Array.from({ length: 10 }, (_, index) => (index % 2 ? answer(`a${index}`) : user(`q${index}`)));
  const { port } = adapter([new Error("model down")]);
  const strategy = new CompactionStrategy(port, policy({ prune: 100, trigger: 500, tail: 400 }));
  const outcome = await strategy.compact(history, live());
  assert.equal(outcome.kind, "degraded");
  if (outcome.kind !== "degraded") return;
  assert.ok(outcome.dropped > 0);
  assert.match(outcome.messages[0]!.text, new RegExp(`${outcome.dropped} earlier messages were dropped`));
  assert.deepEqual(outcome.messages.slice(1), history.slice(history.length - (outcome.messages.length - 1)));
  assert.ok(outcome.tokensAfter < outcome.tokensBefore);
});

test("a timeout degrades; a preempting caller aborts instead", async () => {
  const history = Array.from({ length: 10 }, (_, index) => (index % 2 ? answer(`a${index}`) : user(`q${index}`)));
  const hang = (signal: AbortSignal) => () => new Promise<string>((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const slow = adapter([]);
  slow.port.summarize = (input) => hang(input.signal)();
  const timed = await new CompactionStrategy(slow.port, policy({ prune: 100, trigger: 500, tail: 400, timeoutMs: 20 })).compact(history, live());
  assert.equal(timed.kind, "degraded");
  const controller = new AbortController();
  const pending = new CompactionStrategy(slow.port, policy({ prune: 100, trigger: 500, tail: 400 })).compact(history, { ...live(), signal: controller.signal });
  controller.abort(new Error("new message"));
  await assert.rejects(pending, CompactionAborted);
});

test("a forced compaction keeps less tail when the history fits it, and a user who asked gets the error, not a degraded tail", async () => {
  const history = [user("a"), answer("b"), user("c"), answer("d")];
  const { port } = adapter(["## Goal\nx", new Error("provider down")]);
  const strategy = new CompactionStrategy(port, policy());
  assert.ok(strategy.cutFor(history, 150) >= strategy.cutFor(history, 300));
  const outcome = await strategy.compact(history, { ...live(), force: true });
  assert.equal(outcome.kind, "summarized");
  assert.ok(outcome.kind === "summarized" && outcome.replaced >= 1 && outcome.messages.length < history.length + 1);
  await assert.rejects(strategy.compact(history, { ...live(), force: true, onFailure: "throw" }), /provider down/);
  assert.deepEqual(await strategy.compact([user("only")], { ...live(), force: true }), { kind: "none" });
});

test("a new message preempts background compaction and waits for it to end", async () => {
  const background = new BackgroundCompactor<string>();
  const events: string[] = [];
  background.schedule("c", async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push("job ended");
  });
  assert.equal(background.schedule("c", async () => { events.push("duplicate"); }), false);
  await background.preempt("c");
  events.push("message proceeds");
  assert.deepEqual(events, ["job ended", "message proceeds"]);
  assert.equal(background.has("c"), false);
});
