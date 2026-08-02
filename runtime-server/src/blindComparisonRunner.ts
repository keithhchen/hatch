import "dotenv/config";

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { KIMI_TEMPERATURE, KIMI_THINKING, requireKimiProviderConfig } from "./kimiProvider.js";
import { CreatorReleasePublicSchema, CreatorReleaseResolver } from "./release.js";
import { materializeCreatorRelease } from "./releaseMaterialization.js";

type HeldOut = { id: string; category: string; input: string; expected_behavior: string; observable_checks: string[] };
type Candidate = { id: string; response: string };
type Judgment = { id: string; candidate_passed: boolean; baseline_passed: boolean; candidate_score: number; baseline_score: number; rationale: string };

const args = parseArgs(process.argv.slice(2));
const releaseDirectory = path.resolve(args.release);
const publicRelease = CreatorReleasePublicSchema.parse(JSON.parse(await readFile(path.join(releaseDirectory, "public.json"), "utf8")));
if (path.basename(releaseDirectory) !== publicRelease.digest || path.basename(path.dirname(releaseDirectory)) !== publicRelease.release_id) {
  throw new Error("--release must be the exact immutable release directory");
}
const heldOut = JSON.parse(await readFile(args.heldOut, "utf8")) as HeldOut[];
if (!Array.isArray(heldOut) || heldOut.length === 0 || heldOut.some((item) => !item.id || !item.input || !Array.isArray(item.observable_checks))) {
  throw new Error("--held-out must contain release-only evals with observable checks");
}
const resolver = new CreatorReleaseResolver(path.dirname(path.dirname(releaseDirectory)));
const release = await resolver.resolve(publicRelease.release_id, publicRelease.digest);
const provider = requireKimiProviderConfig();
const client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL });

const candidate: Candidate[] = [];
const baseline: Candidate[] = [];
for (const item of heldOut) {
  const materialized = await materializeCreatorRelease(release, item.input, []);
  candidate.push({ id: item.id, response: await complete(client, provider.model, materialized.systemPrompt, item.input) });
  baseline.push({ id: item.id, response: await complete(client, provider.model, genericSystemPrompt(), item.input) });
}

const judgments: Judgment[] = [];
for (const item of heldOut) {
  const creator = candidate.find((row) => row.id === item.id)!;
  const generic = baseline.find((row) => row.id === item.id)!;
  const reverse = Number.parseInt(shortHash(item.id).slice(0, 2), 16) % 2 === 1;
  const first = reverse ? generic.response : creator.response;
  const second = reverse ? creator.response : generic.response;
  const verdict = await judge(client, provider.model, item, first, second);
  judgments.push({
    id: item.id,
    candidate_passed: reverse ? verdict.b_passed : verdict.a_passed,
    baseline_passed: reverse ? verdict.a_passed : verdict.b_passed,
    candidate_score: reverse ? verdict.b_score : verdict.a_score,
    baseline_score: reverse ? verdict.a_score : verdict.b_score,
    rationale: verdict.rationale
  });
}
const candidateRate = judgments.filter((row) => row.candidate_passed).length / judgments.length;
const baselineRate = judgments.filter((row) => row.baseline_passed).length / judgments.length;
const report = {
  kind: "blind_observable_check_comparison",
  release_id: publicRelease.release_id,
  release_digest: publicRelease.digest,
  model: provider.model,
  blind_labeling: true,
  creator_private_assets_exposed_to_baseline: false,
  expected_checks_exposed_to_candidate_or_baseline: false,
  held_out_inputs_sha256: digest(JSON.stringify(heldOut)),
  candidate_sha256: digest(JSON.stringify(candidate)),
  baseline_sha256: digest(JSON.stringify(baseline)),
  cases: heldOut.map((item) => ({ id: item.id, category: item.category, candidate: candidate.find((row) => row.id === item.id), baseline: baseline.find((row) => row.id === item.id), judgment: judgments.find((row) => row.id === item.id) })),
  summary: { creator_agent: { pass_rate: candidateRate }, generic_baseline: { pass_rate: baselineRate }, delta: candidateRate - baselineRate },
  gate: { passed: candidateRate >= 0.8 && candidateRate > baselineRate },
  passed: candidateRate >= 0.8 && candidateRate > baselineRate
};
await atomicJson(args.output, report);
process.stdout.write(`${JSON.stringify({ passed: report.passed, release_id: report.release_id, release_digest: report.release_digest, summary: report.summary }, null, 2)}\n`);
if (!report.passed) process.exitCode = 2;

function parseArgs(values: string[]): { release: string; heldOut: string; output: string } {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]; const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error("Usage: blindComparisonRunner --release <dir> --held-out <evals.json> --output <comparison.json>");
    options.set(key, value);
  }
  const release = options.get("--release"); const heldOut = options.get("--held-out"); const output = options.get("--output");
  if (!release || !heldOut || !output) throw new Error("Usage: blindComparisonRunner --release <dir> --held-out <evals.json> --output <comparison.json>");
  return { release, heldOut, output };
}

async function complete(client: OpenAI, model: string, system: string, input: string): Promise<string> {
  const request: any = { model, temperature: KIMI_TEMPERATURE, ...(KIMI_THINKING.type === "disabled" ? {} : { thinking: KIMI_THINKING }), max_completion_tokens: 1800, messages: [{ role: "system", content: system }, { role: "user", content: input }] };
  const response = await client.chat.completions.create(request);
  const content = response.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new Error("Kimi comparison candidate returned no response");
  return content;
}

function genericSystemPrompt(): string {
  return "You are a helpful general-purpose assistant. Answer the user directly using only the information in their message. Do not claim access to files, courses, Creator methods, hidden policies, or private context.";
}

async function judge(client: OpenAI, model: string, item: HeldOut, answerA: string, answerB: string): Promise<{ a_passed: boolean; b_passed: boolean; a_score: number; b_score: number; rationale: string }> {
  const request: any = {
    model, temperature: KIMI_TEMPERATURE, ...(KIMI_THINKING.type === "disabled" ? {} : { thinking: KIMI_THINKING }), response_format: { type: "json_object" }, max_completion_tokens: 1200,
    messages: [{ role: "system", content: "You are an independent release evaluator. Judge two anonymous answers only against the supplied observable checks. Do not reward length, style, or hidden knowledge. Return JSON {a_passed:boolean,b_passed:boolean,a_score:number,b_score:number,rationale:string}; scores are 0 to 1." }, { role: "user", content: JSON.stringify({ probe: item.input, expected_behavior: item.expected_behavior, observable_checks: item.observable_checks, answer_a: answerA, answer_b: answerB }) }]
  };
  const response = await client.chat.completions.create(request);
  const raw = response.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Kimi blind judge returned no JSON");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (typeof value.a_passed !== "boolean" || typeof value.b_passed !== "boolean" || typeof value.a_score !== "number" || typeof value.b_score !== "number" || typeof value.rationale !== "string") throw new Error("Kimi blind judge returned invalid JSON");
  return value as { a_passed: boolean; b_passed: boolean; a_score: number; b_score: number; rationale: string };
}

function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function shortHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function atomicJson(file: string, value: unknown): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temp, file); }
