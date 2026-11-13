#!/usr/bin/env node
/**
 * Web edge-case suite (VERIFICATION TOOL, not a product, not prod UAT). Drives the real creator-dashboard web chat in a real
 * browser against the real Dashboard, Registry, Runtime and a throwaway Postgres, with the real model. Needs `npm run build` in
 * runtime-server and `npx vite build` in creator-dashboard first.
 *
 *   CHROMIUM=<chrome-headless-shell, if Playwright's own revision is not installed> \
 *   agentsecrets exec --profile hatch --provider gemini -- agentsecrets exec --profile hatch --provider kimi -- \
 *     node scripts/verify-web-edges/run.mjs [--only 1a,7] [--list]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebStack } from "./webstack.mjs";
import { Client, World, launch } from "./browser.mjs";
import { audit, compareToServer, logLines, suspiciousLogs } from "./audit.mjs";
import { scenarios } from "./scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : undefined;
if (args.includes("--list")) { for (const s of scenarios) console.log(`${s.id}\t${s.title}`); process.exit(0); }
const resultsDir = path.join(here, "results");
mkdirSync(path.join(resultsDir, "shots"), { recursive: true });

const web = await WebStack.start({ llmProfile: process.env.HATCH_LLM_PROFILE || "gemini-api" });
const browser = await launch();
const results = [];
try {
  for (const scenario of scenarios.filter((s) => !only || only.includes(s.id))) {
    const since = new Date().toISOString();
    const opened = []; const notes = [];
    const world = await World.create(web, `edge${scenario.id}`);
    const ctx = {
      web, world, note: (text) => notes.push(text), shot: (name) => path.join(resultsDir, "shots", `${scenario.id}-${name}.png`),
      async open(options = {}) { const client = await Client.open(web, browser, world, options); opened.push(client); return client; },
      async restartRuntime({ kill, outage = 0 }) {
        const [instance] = web.stack.liveRuntimes();
        // Rolling, as a deploy is: the new process is up before the old one goes, so chats never face a moment with no Runtime.
        if (!outage) await web.stack.startRuntime();
        if (kill) await web.stack.killRuntime(instance); else await web.stack.stopRuntime(instance);
        if (outage) { await new Promise((resolve) => setTimeout(resolve, outage)); await web.stack.startRuntime(); }
      },
      /** Session expiry: the Registry no longer honours the browser's web session. The API key the harness reads truth with is kept. */
      async expireWebSessions() { await web.stack.registryPool.query("UPDATE account_sessions SET revoked_at = now() WHERE account_id = $1 AND client_type <> 'api_key' AND revoked_at IS NULL", [world.owner.id]); }
    };
    process.stderr.write(`[${scenario.id}] ${scenario.title} ...\n`);
    const started = Date.now();
    let outcome; let error;
    try { outcome = await scenario.run(ctx); } catch (thrown) { error = thrown; }
    const clients = outcome?.clients ?? opened;
    const result = { id: scenario.id, title: scenario.title, durationMs: Date.now() - started, notes, findings: [], evidence: {} };
    try {
      for (const client of clients) await client.shot(path.join(resultsDir, "shots", `${scenario.id}-${client.label}-final.png`));
      const extra = [...(outcome?.extra ?? [])];
      if (error) extra.push({ kind: "scenario-error", detail: String(error.stack ?? error).slice(0, 600) });
      if (outcome && !outcome.skipUi) for (const client of clients) { const cmp = await compareToServer(client, world, outcome.conversationId); extra.push(...cmp.problems); result.evidence[`ui:${client.label}`] = cmp.ui.map((m) => `${m.role}${m.state ? `[${m.state}]` : ""}: ${m.text.slice(0, 70)}`); result.evidence.server = cmp.server.map((m) => `${m.role}: ${m.text.slice(0, 70)}`); }
      else if (outcome?.conversationId) result.evidence.server = (await world.messages(outcome.conversationId)).map((m) => `${m.role}: ${m.text.slice(0, 70)}`);
      result.findings = audit({ clients, world, conversationId: outcome?.conversationId, web, since, expected: outcome?.expected, uiPicture: extra });
      result.evidence.alerts = clients.flatMap((c) => c.watch.alerts.map((a) => `[${c.label} +${a.at}] ${a.text}`));
      result.evidence.frames = clients.map((c) => ({ client: c.label, frames: c.watch.frames.map((f) => `${f.at} ${f.socket}${f.dir} ${f.type}${f.code ? ` ${f.code}` : ""}${f.status ? ` ${f.status}` : ""}${f.run ? ` ${f.run}` : ""}`) }));
      result.evidence.http = clients.flatMap((c) => c.watch.http.map((h) => `[${c.label} +${h.at}] ${h.method} ${h.status} ${h.url}`));
      result.evidence.requests = clients.map((c) => ({ client: c.label, requests: c.watch.requests }));
      result.evidence.console = clients.flatMap((c) => c.watch.console.map((m) => `[${c.label} +${m.at}] ${m.type}: ${m.text}`));
      result.evidence.serverLogs = suspiciousLogs(logLines(web, since)).map((l) => `${l.source}: ${l.line.slice(0, 260)}`);
    } catch (thrown) { result.findings.push({ kind: "audit-error", detail: String(thrown.stack ?? thrown).slice(0, 600) }); }
    result.verdict = result.findings.length ? "DEFECT" : "PASS";
    process.stderr.write(`[${scenario.id}] ${result.verdict} (${Math.round(result.durationMs / 1000)} s)${result.findings.map((f) => `\n    - ${f.kind}: ${f.detail.slice(0, 220)}`).join("")}\n`);
    results.push(result);
    for (const client of opened) await client.close();
    writeFileSync(path.join(resultsDir, `scenario-${scenario.id}.json`), JSON.stringify(result, null, 2));
  }
} finally {
  await browser.close().catch(() => undefined);
  await web.down();
}
const table = ["| # | Scenario | Verdict | Findings |", "|---|---|---|---|", ...results.map((r) => `| ${r.id} | ${r.title} | ${r.verdict} | ${r.findings.map((f) => `${f.kind}: ${f.detail.replace(/\|/g, "/").slice(0, 160)}`).join("<br>") || "none"} |`)];
writeFileSync(path.join(resultsDir, "report.md"), `# Web edge cases: local real-stack run (not prod UAT)\n\n${table.join("\n")}\n`);
