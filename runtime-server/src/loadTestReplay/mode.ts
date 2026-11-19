import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ProductCapabilities } from "../agentBox/capabilities.js";
import type { ReportEmailContext } from "../agentBox/tools.js";
import { log } from "../observability/log.js";
import { SiteResearchMode } from "../siteTools/tools.js";
import type { ToolDefinition } from "../tools.js";
import { LOAD_TEST_REPLAY_CAPABILITY, readReplayScript, type ReplayScript } from "./script.js";
import { replayStreamFn } from "./stream.js";
import { realTiming, type ReplayTiming } from "./timing.js";
import { ReplayToolRunner, type ReplayTools } from "./tools.js";

export type LoadTestReplayDeps = {
  capabilities: ProductCapabilities;
  /** The Agent's own computer tools' registry entries (`AgentBoxMode.definitions()`): replay stands in for them, so their names must resolve. */
  boxDefinitions: ToolDefinition[];
  /** Saves the recorded report as the buyer's file and publishes it, the report email included (`AgentBoxMode.publishBytes`). */
  publish(owner: { productId: string; userId: string }, email: ReportEmailContext | undefined, name: string, html: Buffer, title: string): Promise<{ page_id: string; url: string }>;
  timing?: ReplayTiming;
  chunkChars?: number;
  readScript?: (corpusRoot: string | undefined) => Promise<ReplayScript>;
};

/** What a load-test Run is given instead of a model and tools. */
export type ReplayTurnSetup = { stream: StreamFn; tools: ReplayTools; extraTools: string[] };

const unused = { run: async (): Promise<never> => { throw new Error("load_test_replay never calls a real site lookup"); } };

/**
 * Load-test replay: a Product with the `load_test_replay` capability row runs on a recording of one real Run (`runtime/replay.json`
 * in its Corpus). There is no other way in: no environment variable, no flag on any other Product. A Product without the row gets undefined here,
 * so its Runs are untouched; and the `replay` model profile refuses to run without the setup this returns.
 * The server's own work (event log, streaming, page, signed link, report email) is real; the model and the outside tools are the recording.
 */
export class LoadTestReplay {
  private readonly scripts = new Map<string, Promise<ReplayScript>>();
  constructor(private readonly deps: LoadTestReplayDeps) {}

  /** Registry entries for the tool names a recording uses, so the Agent can call them where the real box and site tools are not configured. */
  definitions(): ToolDefinition[] {
    return [...this.deps.boxDefinitions, ...new SiteResearchMode(this.deps.capabilities, { page_speed: unused, place_search: unused, ip_info: unused }).definitions()];
  }

  async turnFor(owner: { productId: string; userId: string; corpusRoot?: string; email?: ReportEmailContext }): Promise<ReplayTurnSetup | undefined> {
    if (!await this.deps.capabilities.has(owner.productId, LOAD_TEST_REPLAY_CAPABILITY)) return undefined;
    const script = await this.script(owner.corpusRoot);
    const timing = this.deps.timing ?? realTiming();
    log.info("load_test_replay", { kind: "run_setup", product_id: owner.productId, turns: script.turns.length, tool_calls: script.tool_calls.length, speed: timing.speed });
    const publish = (html: Buffer, title: string) => this.deps.publish(owner, owner.email, "report.html", html, title);
    return {
      stream: replayStreamFn(script, { timing, ...this.deps.chunkChars ? { chunkChars: this.deps.chunkChars } : {} }),
      tools: new ReplayToolRunner(script, timing, publish),
      extraTools: [...new Set(script.tool_calls.map((call) => call.name).filter((name) => /^(box|site)\./.test(name)))]
    };
  }

  /** Read once per Corpus: a released Corpus never changes, and every Run of a load test reads the same file. */
  private script(corpusRoot: string | undefined): Promise<ReplayScript> {
    const key = corpusRoot ?? "";
    const known = this.scripts.get(key);
    if (known) return known;
    const read = (this.deps.readScript ?? readReplayScript)(corpusRoot);
    this.scripts.set(key, read);
    read.catch(() => { if (this.scripts.get(key) === read) this.scripts.delete(key); });
    return read;
  }
}
