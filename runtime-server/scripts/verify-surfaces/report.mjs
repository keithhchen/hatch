#!/usr/bin/env node
/** Merges results/scenario-*.json into report.md (human) and report.json (machine). Run after run.mjs. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "results");
const results = readdirSync(dir).filter((f) => f.startsWith("scenario-") && f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"))).filter((r) => r.id !== 0);
const meta = JSON.parse(readFileSync(path.join(here, "run-meta.json"), "utf8"));

const SEVERITY = { high: 0, medium: 1, low: 2 };
const defects = results.flatMap((r) => (r.defects ?? []).map((d) => ({ scenario: r.id, ...d }))).sort((a, b) => (SEVERITY[a.severity] ?? 1) - (SEVERITY[b.severity] ?? 1));
const blocked = results.filter((r) => r.status === "BLOCKED");
const count = (status) => results.filter((r) => r.status === status).length;

writeFileSync(path.join(here, "report.json"), JSON.stringify({ evidence_level: "real integration (local stack, fake platform, real models); not product UAT", ...meta, generated_at: new Date().toISOString(), totals: { pass: count("PASS"), fail: count("FAIL"), blocked: count("BLOCKED") }, scenarios: results, defects }, null, 2));

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const json = (value) => `\`${JSON.stringify(value)}\``;
const lines = [];
lines.push("# Surfaces verification report", "");
lines.push(`Generated ${new Date().toISOString()} at commit ${meta.commit}. Every result below is labelled **real integration**: the real \`dist/registryServer.js\` and \`dist/index.js\` over HTTP and WebSocket, a throwaway Postgres 16, real model calls (${meta.models}), and a local fake platform. **None of it is product UAT.**`, "");
lines.push(`Totals: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("BLOCKED")} BLOCKED of ${results.length}.`, "");
lines.push("## Scenarios", "", "| # | Scenario | Result | Evidence level | Key measurements |", "|---|---|---|---|---|");
for (const r of results) {
  const keys = Object.entries(r.measurements ?? {}).slice(0, 6).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join("; ");
  lines.push(`| ${r.id} | ${cell(r.title)} | **${r.status}** | real integration | ${cell(keys)} |`);
}
lines.push("", "## Defects, highest first", "");
if (!defects.length) lines.push("None recorded.", "");
defects.forEach((d, i) => {
  lines.push(`### D${i + 1} [${d.severity}] ${d.title} (scenario ${d.scenario})`, "", `- Expected: ${d.expected}`, `- Actual: ${d.actual}`, `- Reproduction: ${d.repro}`, "");
});
lines.push("## Blocked", "");
if (!blocked.length) lines.push("None.", "");
for (const r of blocked) lines.push(`- Scenario ${r.id} (${r.title}): ${r.reason}`);
lines.push("", "## Scenario detail", "");
for (const r of results) {
  lines.push(`### ${r.id}. ${r.title}`, "", `Result: **${r.status}** (${Math.round(r.durationMs / 1000)} s). Evidence level: real integration.`, "");
  if (r.reason) lines.push(`Reason: ${r.reason.split("\n")[0]}`, "");
  if (r.checks?.length) { lines.push("| Check | | Detail |", "|---|---|---|"); for (const c of r.checks) lines.push(`| ${cell(c.name)} | ${c.ok ? "ok" : "**FAILED**"} | ${cell(c.detail === undefined ? "" : json(c.detail)).slice(0, 400)} |`); lines.push(""); }
  if (Object.keys(r.measurements ?? {}).length) { lines.push("Measurements:", ""); for (const [k, v] of Object.entries(r.measurements)) lines.push(`- ${k}: ${json(v)}`); lines.push(""); }
  if (r.notes?.length) { lines.push("Notes:", ""); for (const n of r.notes) lines.push(`- ${n}`); lines.push(""); }
}
lines.push("## How this was set up (what is and is not the product)", "",
  "- Accounts are created through the real `/v1/auth/signup`; API keys through `/v1/auth/api-keys`. A \"browser session\" is the same session token sent as the `hatch_session` cookie from an allowed Origin (Runtime) or as a Bearer token (Registry, which has no cookie door).",
  "- The Expert Product release is written to the Runtime corpus root and the Registry release store directly (the way `chat/processes.e2e.test.ts` does). The Creator Factory publish path is not exercised.",
  "- Org and public Connections are inserted as rows. There is no product API for creating them yet. Only the `self` link-code flow is a product path.",
  "- The fake platform exists only in this tool. It records outbound calls, injects 429, timeouts, and revocation, and serves as the web-search provider. The adapters are the real ones; a preload rewrites only their host.",
  "- A path-routing edge stands where Caddy stands so the `hatch` CLI (one base URL) and the Registry's call into Chat share one address and a Runtime instance can be killed behind it.", "",
  "## What cannot be proved without a real platform", "",
  "- That a real Telegram, Feishu or WeCom server signs, retries, orders and rate-limits as the local formats assume (retry timing, event ordering, redelivery after timeouts, group mention rules).",
  "- That a real platform's idempotency, message-edit, reply-window and rate-limit behaviour matches the adapters' `ChannelCapabilities`.",
  "- Real OAuth and install flows, tenant revocation, webhook registration, file downloads from the platform's CDN, and real network latency and loss.",
  "- That any real account, device, native bridge, packaged Desktop build or OS behaves as the protocol clients here do. No Desktop app was run.",
  "- Provider behaviour beyond the sampled runs: a model's cache hit rate and answer quality vary with provider load and time.",
  "- Production topology: one Postgres, no OSS, no multi-host network partitions, no real load balancer.", "");
writeFileSync(path.join(here, "report.md"), lines.join("\n"));
console.log(`report.md and report.json written: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("BLOCKED")} BLOCKED`);
