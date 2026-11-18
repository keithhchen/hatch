import type { OutboundMessage } from "../protocol.js";
import { VisibleParts } from "./visibleParts.js";

/** What a page needs to show a Run in progress exactly as it has been so far: the shape of a saved reply, plus where in the Run's events it stands. */
export type LiveRun = {
  run_id: string;
  /** The number of the last event of the Run this account holds; every event of the Run carries its own `seq`, and a page skips the ones it holds. */
  seq: number;
  content: string;
  parts: unknown[];
  tool_calls: Record<string, unknown>[];
  skill_events: Record<string, unknown>[];
  skill_runs: Record<string, unknown>[];
};

const defined = (event: Record<string, unknown>): Record<string, unknown> => {
  const { type: _type, seq: _seq, ...fields } = event;
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
};

/**
 * One Run's events folded into the state a page would have shown by now. Events are numbered by the Run's executor;
 * an account that missed one (a relay that dropped it, an instance that joined late) is not `complete` and is never served.
 */
export class RunLedger {
  seq = 0;
  complete = true;
  /** The Run is over: events that still carry its id (a compaction after the reply) are numbered on, and no longer shown. */
  ended = false;

  end(): void {
    this.ended = true;
    this.visible = new VisibleParts(); this.text = ""; this.tools = new Map(); this.skillEvents = new Map(); this.skillRuns = new Map();
  }
  private visible = new VisibleParts();
  private text = "";
  private tools = new Map<string, Record<string, unknown>>();
  private skillEvents = new Map<string, Record<string, unknown>>();
  private skillRuns = new Map<string, Record<string, unknown>>();

  constructor(readonly runId: string) {}

  accept(event: Record<string, unknown>): void {
    if (this.ended) { if (typeof event.seq === "number") this.seq = event.seq; return; }
    if (typeof event.seq !== "number" || event.seq !== this.seq + 1) this.complete = false;
    if (typeof event.seq === "number") this.seq = event.seq;
    const message = event as unknown as OutboundMessage;
    try { this.visible.accept(message); } catch { this.complete = false; }
    switch (message.type) {
      case "assistant.delta":
        if (message.delta.kind === "text") this.text += message.delta.content;
        break;
      case "tool_call.delta":
        this.tools.set(message.tool_call_id, { ...this.tools.get(message.tool_call_id), ...defined(event) });
        break;
      case "skill.activated":
      case "skill.invoked": {
        const fields = defined(event);
        this.skillEvents.set([message.type, message.name, message.reason, fields.source_tool_call_id ?? ""].join(":"), fields);
        break;
      }
      case "skill.run":
        this.skillRuns.set(message.skill_run_id, defined(event));
        break;
    }
  }

  view(): LiveRun {
    return {
      run_id: this.runId, seq: this.seq, content: this.text, parts: this.visible.view(),
      tool_calls: [...this.tools.values()], skill_events: [...this.skillEvents.values()], skill_runs: [...this.skillRuns.values()]
    };
  }
}
