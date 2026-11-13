#!/usr/bin/env node
/**
 * Surfaces verification tool (NOT a product, NOT product UAT). Runs real-API scenarios against an isolated local stack of the
 * real Registry and Runtime and writes one result file per scenario to ./results; `report.mjs` merges them into report.md.
 *
 *   agentsecrets exec --profile hatch --provider gemini -- agentsecrets exec --profile hatch --provider kimi -- \
 *     node scripts/verify-surfaces/run.mjs [--only 1,4] [--list]
 *
 * Requires `npm run build` first (it starts dist/registryServer.js and dist/index.js).
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ScenarioRunner } from "./lib/scenario.mjs";
import { Stack } from "./lib/stack.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const only = flag("only")?.split(",").map((s) => s.trim());

const scenarios = [];
for (const file of readdirSync(path.join(here, "scenarios")).filter((f) => f.endsWith(".mjs")).sort()) {
  const mod = await import(pathToFileURL(path.join(here, "scenarios", file)).href);
  for (const scenario of [].concat(mod.default)) scenarios.push(scenario);
}
if (args.includes("--list")) { for (const s of scenarios) console.log(`${s.id}\t${s.title}`); process.exit(0); }

const selected = scenarios.filter((s) => !only || only.includes(String(s.id)));
const runner = new ScenarioRunner({
  createStack: (scenario) => Stack.start({ name: `s${scenario.id}`, llmProfile: process.env.VERIFY_LLM_PROFILE || "gemini-api", ...(scenario.stackOptions ?? {}) })
});
mkdirSync(path.join(here, "results"), { recursive: true });
for (const scenario of selected) {
  const result = await runner.runOne(scenario);
  writeFileSync(path.join(here, "results", `scenario-${String(scenario.id).padStart(2, "0")}.json`), JSON.stringify(result, null, 2));
}
