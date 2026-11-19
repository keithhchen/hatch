import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** The capability row that switches load-test replay on for one Product. Never granted to a Product real buyers use. */
export const LOAD_TEST_REPLAY_CAPABILITY = "load_test_replay";

const ToolCall = z.object({ id: z.string().optional(), name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) });
const Turn = z.object({
  duration_ms: z.number().nonnegative(),
  thinking: z.string().optional(),
  text: z.string().default(""),
  tool_calls: z.array(ToolCall).default([])
});
const RecordedTool = z.object({ name: z.string().min(1), duration_ms: z.number().nonnegative(), result: z.record(z.string(), z.unknown()), is_error: z.boolean().default(false) });

/** One real Run, recorded by scripts/record-replay.mjs: `runtime/replay.json` in the test Product's Corpus. */
export const ReplayScriptSchema = z.object({
  version: z.literal(1),
  turns: z.array(Turn).min(1),
  /** Every tool call of the Run, in the order the model requested them: the flattening of turns[].tool_calls. */
  tool_calls: z.array(RecordedTool),
  /** The report the Run published: replay really publishes it. */
  publish: z.object({ title: z.string(), html: z.string().min(1) })
}).passthrough();

export type ReplayScript = z.infer<typeof ReplayScriptSchema>;
export type ReplayTurn = ReplayScript["turns"][number];

export function parseReplayScript(raw: unknown): ReplayScript {
  const script = ReplayScriptSchema.parse(raw);
  const requested = script.turns.reduce((count, turn) => count + turn.tool_calls.length, 0);
  if (requested !== script.tool_calls.length) throw new Error(`replay.json has ${requested} requested tool calls in its turns but ${script.tool_calls.length} recorded results`);
  return script;
}

/** The Product's recording, from its Corpus beside `runtime/progress.json`. A missing or broken file is an error, never an empty replay. */
export async function readReplayScript(corpusRoot: string | undefined): Promise<ReplayScript> {
  if (!corpusRoot) throw new Error("load_test_replay: the Product has no Corpus to read runtime/replay.json from");
  return parseReplayScript(JSON.parse(await readFile(path.join(corpusRoot, "runtime", "replay.json"), "utf8")));
}
