import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Api } from "@earendil-works/pi-ai";
import { log } from "../observability/log.js";
import { toolRegistry } from "../tools.js";
import type { ReplayScript, ReplayTurn } from "./script.js";
import { waitRecorded, type ReplayTiming } from "./timing.js";

/** A replayed tool call's id carries its place in the recording, so its result is found by the call itself and not by a counter that a second Run would reset. */
export const replayToolCallId = (index: number): string => `replay-${index}`;
export const replayToolCallIndex = (id: string): number | undefined => {
  const match = /^replay-(\d+)$/.exec(id);
  return match ? Number(match[1]) : undefined;
};

/** The name the model sees for a runtime tool name (`box.bash` is `bash`): the registry's, so the Agent's tool list finds it. */
const modelToolName = (runtimeName: string): string => toolRegistry.get(runtimeName)?.model?.name ?? runtimeName;

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const pieces = (text: string, size: number): string[] => {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
};

export type ReplayStreamOptions = { timing: ReplayTiming; chunkChars?: number; modelToolName?: (runtimeName: string) => string };

/**
 * The model of a load-test Run: turn N of the recording is the N-th assistant message of the conversation, so the same
 * conversation always maps to the same turn, whichever process answers and however many Runs it took. Calls that offer no tools
 * (a budget-exhausted last call) and calls past the recording get its closing text. Each call streams like a provider would:
 * `start` at once, then the thinking, the text and the tool-call arguments in small deltas spread over the recorded duration.
 */
export function replayStreamFn(script: ReplayScript, options: ReplayStreamOptions): StreamFn {
  const chunk = options.chunkChars ?? 16;
  const toolName = options.modelToolName ?? modelToolName;
  const last = script.turns[script.turns.length - 1]!;
  const closing: ReplayTurn = { duration_ms: last.duration_ms, text: last.text, tool_calls: [] };
  // Where each turn's tool calls begin in the recording's flat list.
  const firstCall: number[] = [];
  script.turns.reduce((count, turn) => { firstCall.push(count); return count + turn.tool_calls.length; }, 0);

  return (model: Model<Api>, context, streamOptions) => {
    const out = createAssistantMessageEventStream();
    const signal = streamOptions?.signal;
    const index = context.messages.filter((message) => message.role === "assistant").length;
    const offersTools = (context.tools?.length ?? 0) > 0;
    const turn = offersTools ? script.turns[index] ?? closing : closing;
    const base = firstCall[index] ?? 0;
    const replayed = turn === closing ? "closing" : index;
    log.info("load_test_replay", { kind: "model_turn", turn: replayed, recorded_turns: script.turns.length, duration_ms: turn.duration_ms, speed: options.timing.speed });

    void (async () => {
      const content: AssistantMessage["content"] = [];
      const partial = (): AssistantMessage => ({
        role: "assistant", content: [...content], api: model.api, provider: model.provider, model: model.id,
        usage: zeroUsage, stopReason: "pending", timestamp: Date.now()
      });
      // The deltas of the turn, in order, so the recorded duration can be spread across them.
      type Step = () => void;
      const steps: Step[] = [];
      const open = (): void => { out.push({ type: "start", partial: partial() }); };
      let at = 0;
      if (turn.thinking) {
        const i = at++;
        let thinking = "";
        steps.push(() => { content[i] = { type: "thinking", thinking }; out.push({ type: "thinking_start", contentIndex: i, partial: partial() }); });
        for (const piece of pieces(turn.thinking, chunk)) steps.push(() => { thinking += piece; content[i] = { type: "thinking", thinking }; out.push({ type: "thinking_delta", contentIndex: i, delta: piece, partial: partial() }); });
        steps.push(() => out.push({ type: "thinking_end", contentIndex: i, content: thinking, partial: partial() }));
      }
      if (turn.text) {
        const i = at++;
        let text = "";
        steps.push(() => { content[i] = { type: "text", text }; out.push({ type: "text_start", contentIndex: i, partial: partial() }); });
        for (const piece of pieces(turn.text, chunk)) steps.push(() => { text += piece; content[i] = { type: "text", text }; out.push({ type: "text_delta", contentIndex: i, delta: piece, partial: partial() }); });
        steps.push(() => out.push({ type: "text_end", contentIndex: i, content: text, partial: partial() }));
      }
      turn.tool_calls.forEach((call, k) => {
        const i = at++;
        const toolCall = { type: "toolCall" as const, id: replayToolCallId(base + k), name: toolName(call.name), arguments: call.arguments };
        steps.push(() => { content[i] = { ...toolCall, arguments: {} }; out.push({ type: "toolcall_start", contentIndex: i, partial: partial() }); });
        for (const piece of pieces(JSON.stringify(call.arguments), chunk)) steps.push(() => out.push({ type: "toolcall_delta", contentIndex: i, delta: piece, partial: partial() }));
        steps.push(() => { content[i] = toolCall; out.push({ type: "toolcall_end", contentIndex: i, toolCall, partial: partial() }); });
      });

      try {
        open();
        // A wait before each delta; the start/end bookkeeping steps share the wait of the delta that follows them.
        const deltas = steps.length || 1;
        const each = turn.duration_ms / deltas;
        for (const step of steps) { await waitRecorded(options.timing, each, signal); step(); }
        if (!steps.length) await waitRecorded(options.timing, turn.duration_ms, signal);
        const message: AssistantMessage = { ...partial(), stopReason: turn.tool_calls.length ? "toolUse" : "stop" };
        out.push({ type: "done", reason: turn.tool_calls.length ? "toolUse" : "stop", message });
      } catch (error) {
        const aborted = signal?.aborted === true;
        out.push({ type: "error", reason: aborted ? "aborted" : "error", error: { ...partial(), stopReason: aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error) } });
      } finally {
        out.end();
      }
    })();
    return out;
  };
}
