import { log } from "../observability/log.js";
import type { ReplayScript } from "./script.js";
import { replayToolCallIndex } from "./stream.js";
import { waitRecorded, type ReplayTiming } from "./timing.js";

/** The tools whose real work is replaced by their recording: the Agent's computer, site research, web search and attachments. */
export const REPLAYED_TOOL = /^(box\.|site\.|attachments\.|hatch\.web_search$|web\.search$)/;

/** Publishes the recorded report for real: a saved file, a page row, a signed link and the report email. */
export type ReplayPublisher = (html: Buffer, title: string) => Promise<{ page_id: string; url: string }>;

export type ReplayTools = {
  handles(name: string): boolean;
  run(name: string, args: Record<string, unknown>, signal?: AbortSignal, toolCallId?: string): Promise<Record<string, unknown>>;
};

/**
 * The server tools of a load-test Run. A call is answered with the recorded result of the same call after the recorded duration:
 * found by the replayed call's own id (its place in the recording), else by tool name, the first recorded call of that name this
 * turn has not used. `box.publish_html` is the exception: it publishes the recorded report through the real path, which is the load under test.
 */
export class ReplayToolRunner implements ReplayTools {
  private readonly used = new Set<number>();
  constructor(private readonly script: ReplayScript, private readonly timing: ReplayTiming, private readonly publish: ReplayPublisher) {}

  handles(name: string): boolean { return REPLAYED_TOOL.test(name); }

  async run(name: string, args: Record<string, unknown>, signal?: AbortSignal, toolCallId?: string): Promise<Record<string, unknown>> {
    const started = Date.now();
    if (name === "box.publish_html") {
      // The recording's duration is the real tool's, which this call now spends itself; only the page's title is the model's.
      const title = typeof args.title === "string" && args.title.trim() ? args.title : this.script.publish.title;
      const page = await this.publish(Buffer.from(this.script.publish.html, "utf8"), title);
      log.info("load_test_replay", { kind: "tool", tool: name, real_publish: true, page_id: page.page_id, ms: Date.now() - started });
      return page;
    }
    const found = this.recorded(name, toolCallId);
    if (!found) {
      log.warn("load_test_replay", { kind: "tool", tool: name, recorded: false });
      return { status: "error", error: { code: "load_test_replay_no_recording", message: `The load-test recording has no result for ${name}.` } };
    }
    await waitRecorded(this.timing, found.duration_ms, signal);
    log.info("load_test_replay", { kind: "tool", tool: name, duration_ms: found.duration_ms, speed: this.timing.speed, is_error: found.is_error });
    return found.result;
  }

  private recorded(name: string, toolCallId: string | undefined) {
    const { tool_calls: calls } = this.script;
    const byOrder = toolCallId === undefined ? undefined : replayToolCallIndex(toolCallId);
    if (byOrder !== undefined && calls[byOrder]?.name === name) { this.used.add(byOrder); return calls[byOrder]; }
    const byName = calls.findIndex((call, index) => call.name === name && !this.used.has(index));
    if (byName < 0) return undefined;
    this.used.add(byName);
    return calls[byName];
  }
}
