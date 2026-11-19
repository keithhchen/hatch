import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "./agentRuntime.js";
import { chatCompactionStrategy } from "./compaction.js";
import { creatorModelToolName } from "./creatorTools.js";
import { llmProfile, type RuntimeLlmProfileName } from "./llmProfiles.js";
import { InMemoryModelRoleResolver } from "./modelRoles.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import type { OutboundMessage, RunStart } from "./protocol.js";
import { renderSkillsSection } from "./skills.js";

/**
 * A real Run against a real provider with a tiny budget, so one Run summarizes several times: the summaries are real model
 * calls, and every request after a summary replays the kept tail (DeepSeek/Kimi `reasoning_content`, Gemini `thoughtSignature`).
 * Opt-in, because it spends money: HATCH_REAL_MODEL_COMPACTION=kimi-k3.1-pro,deepseek-flash-thinking,gemini-3.8-flash
 */
const profiles = (process.env.HATCH_REAL_MODEL_COMPACTION ?? "").split(",").filter(Boolean) as RuntimeLlmProfileName[];
const RECORDS = 8;
const WORDS = ["amber", "birch", "cobalt", "dune", "ember", "fjord", "garnet", "harbor"];
const codeWord = (n: number): string => `CW${n}-${WORDS[n - 1]}`;

for (const name of profiles.length ? profiles : ["kimi-k3.1-pro" as const]) {
  test(`real ${name}: one Run summarizes several times and still finishes with every record`, { skip: !profiles.length, timeout: 900_000 }, async () => {
    const profile = llmProfile(name);
    const definition = { id: "read_record", description: "Read one student record by number.", input_schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } };
    const tool = creatorModelToolName(definition.id);
    const summaries: number[] = [];
    const strategy = chatCompactionStrategy(profile, { budget: { trigger: 6_000, hard: 6_000, prune: 1_000_000, tail: 1_500 } });
    const compactions: Array<{ kind: string; ms: number; before: number; after: number }> = [];
    const read: number[] = [];
    const input = {
      type: "client.message", run_id: `run_real_${name}`, conversation_id: `conversation_real_${name}`,
      message: { role: "user", content: `Brief: read student records 1 to ${RECORDS} with read_record, strictly one call per turn, in order. Each record ends with a code word. After the last record, reply with only the ${RECORDS} code words in order, comma separated.` }
    } as RunStart;
    const ctx = {
      state: { status: "running" }, messages: [input.message], clientTools: [],
      sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) },
      externalToolDefinitions: [definition], allowedExternalTools: [tool],
      toolCallLimit: { max: 30, uncounted: [] },
      serverTools: {
        executeCreatorTool: async (_tool: unknown, args: { n?: number }) => {
          const n = Number(args?.n);
          read.push(n);
          return { record: n, notes: `Student ${n} transcript and essay notes. `.repeat(220), code_word: codeWord(n) };
        }
      },
      compactMessagesIfNeeded: async (messages: Parameters<NonNullable<RunContext["compactMessagesIfNeeded"]>>[0]) => {
        const started = Date.now();
        const outcome = await strategy.compact(messages, { now: started, cacheTouchedAt: started, signal: new AbortController().signal });
        if (outcome.kind === "none") return undefined;
        compactions.push({ kind: outcome.kind, ms: Date.now() - started, before: outcome.tokensBefore, after: outcome.tokensAfter });
        if (outcome.kind === "summarized") { summaries.push(outcome.summary.length); if (process.env.HATCH_PRINT_SUMMARIES) console.log(JSON.stringify(outcome.summary)); }
        return outcome.messages as never;
      }
    } as unknown as RunContext;
    const models = new InMemoryModelRoleResolver({ roles: { chat: name } as never });
    const runtime = new PiAgentRuntime({ models });
    const events: OutboundMessage[] = [];
    for await (const event of runtime.run(input, ctx)) events.push(event);
    const reply = events.flatMap((event) => event.type === "assistant.delta" && event.delta.kind === "text" ? [event.delta.content] : []).join("");
    const errors = events.filter((event) => event.type === "turn.failed");
    console.log(JSON.stringify({ name, read, compactions, reply: reply.slice(0, 400), errors }));
    assert.deepEqual(errors, []);
    assert.ok(events.some((event) => event.type === "turn.completed"), "the Run finished");
    assert.ok(compactions.filter((c) => c.kind === "summarized").length >= 2, `summarized ${compactions.length} times`);
    assert.ok(compactions.every((c) => c.kind !== "degraded"), "no summary failed");
    for (let n = 1; n <= RECORDS; n++) assert.ok(read.includes(n), `record ${n} was read`);
    // The last records are in the verbatim tail; the first ones live only in the summaries.
    const found = Array.from({ length: RECORDS }, (_, i) => reply.includes(codeWord(i + 1)));
    console.log(JSON.stringify({ name, codeWordsKept: found }));
    assert.ok(found.every(Boolean), "every record's code word reached the final reply");
  });
}
