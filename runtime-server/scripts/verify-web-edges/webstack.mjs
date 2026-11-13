import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { Stack } from "../verify-surfaces/lib/stack.mjs";
import { ManagedProcess } from "../verify-surfaces/lib/processes.mjs";
import { freePort, until } from "../verify-surfaces/lib/util.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const dashboardRoot = path.join(repoRoot, "creator-dashboard");

/**
 * VERIFICATION TOOL ONLY. The surfaces Stack (real Registry, real Runtime, throwaway Postgres) plus the real creator-dashboard
 * server (`node server.mjs`, serving the real built web client) in front of it, standing where the web origin stands in production.
 * Nothing here is a product, and nothing stands in for one: the browser talks to the real Dashboard, which talks to the real Registry/Runtime.
 */
export class WebStack {
  static async start(options = {}) {
    const stack = await Stack.start({ name: "web-edges", ...options });
    const web = new WebStack(stack);
    try { await web.startDashboard(); } catch (error) { await stack.down().catch(() => undefined); throw error; }
    return web;
  }

  constructor(stack) { this.stack = stack; }
  get url() { return `http://127.0.0.1:${this.port}`; }

  async startDashboard() {
    this.port = await freePort();
    const state = path.join(this.stack.root, "dashboard");
    mkdirSync(state, { recursive: true });
    const env = {
      PATH: process.env.PATH ?? "", NODE_ENV: "development",
      HATCH_CREATOR_DASHBOARD_API_PORT: String(this.port), HATCH_CREATOR_DASHBOARD_API_HOST: "127.0.0.1",
      HATCH_PUBLIC_ORIGIN: this.url, HATCH_REGISTRY_URL: this.stack.registryUrl, HATCH_RUNTIME_URL: this.stack.url,
      HATCH_COMMERCE_LEDGER_PATH: path.join(state, "ledger.jsonl"), HATCH_PORTAL_STATE_PATH: path.join(state, "portal-state.json"),
      HATCH_PORTAL_TELEMETRY_PATH: path.join(state, "telemetry.jsonl")
    };
    this.dashboard = new ManagedProcess("dashboard", process.execPath, [path.join(dashboardRoot, "server.mjs")], { cwd: dashboardRoot, env });
    await until("the Dashboard", async () => { if (!this.dashboard.alive) throw new Error(`dashboard exited:\n${this.dashboard.tail(3000)}`); return (await fetch(`${this.url}/healthz`)).ok; }, { timeoutMs: 60_000 });
  }

  /** Every server log, by process, for scanning. */
  logs() {
    return { dashboard: this.dashboard.output, registry: this.stack.registry.output, ...Object.fromEntries(this.stack.runtimes.map((r) => [r.id, r.proc.output])) };
  }

  async down() { await this.dashboard?.stop().catch(() => undefined); await this.stack.down(); }
}
