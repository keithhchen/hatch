/**
 * Private Creator Factory executor.
 *
 * This is deliberately not a semantic distillation script. The executing
 * Kimi agent reads the Creator Factory Skill and ordinary normalized material,
 * makes every semantic judgment, then emits the private compiler contract.
 * This process only provides bounded file I/O, invokes deterministic intake /
 * compiler gates, and asks the same agent to repair a rejected private pack.
 * Creators never see or fill this contract.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { KIMI_TEMPERATURE, KIMI_THINKING, requireKimiProviderConfig } from "./kimiProvider.js";

const execFile = promisify(execFileCallback);
// A repair is deliberately a small agent-authored patch, never a local
// "best effort" rewrite of Creator material. This gives the semantic executor
// several chances to satisfy hard provenance gates without re-distilling the
// entire course on every compiler error.
const MAX_REPAIR_ATTEMPTS = 5;
const MAX_REPAIR_COMPLETION_TOKENS = 12_000;
const SOURCE_PACK_SCHEMA = "hatch.creator-factory.private-source-pack.v1";
const SOURCE_PACK_PATCH_SCHEMA = "hatch.creator-factory.private-source-pack-patch.v1";
const DEFAULT_FACTORY_REQUEST_TIMEOUT_MS = 8 * 60_000;

type IntakeDocument = {
  source_id: string;
  extracted_path: string;
  original_path: string;
  kind: string;
  raw_sha256: string;
};

type Intake = {
  creator_supplied: { product_intent: string };
  documents: IntakeDocument[];
};

type SourceDocument = {
  source_id: string;
  path: string;
  kind: string;
  title: string;
  authority: string;
  content: string;
};

type FactoryEnvelope = {
  schema: typeof SOURCE_PACK_SCHEMA;
  source_manifest: Record<string, unknown>;
  factory_plan: Record<string, unknown>;
  source_documents: SourceDocument[];
  evidence_ledger_markdown: string;
  semantic_audit_markdown: string;
};

type JsonPatchOperation = {
  target: "source_manifest" | "factory_plan";
  op: "add" | "replace" | "remove" | "move";
  path: string;
  from?: string;
  value?: unknown;
};

type SourceReplacement = {
  path: string;
  content: string;
};

type FactoryPatch = {
  schema: typeof SOURCE_PACK_PATCH_SCHEMA;
  operations: JsonPatchOperation[];
  source_replacements: SourceReplacement[];
  evidence_ledger_markdown?: string;
  semantic_audit_markdown?: string;
};

type Arguments = {
  input?: string;
  intent?: string;
  output?: string;
  resume?: string;
  preflight: boolean;
};

class FactoryAgentResponseError extends Error {
  constructor(message: string, readonly rawResponse: string) {
    super(message);
    this.name = "FactoryAgentResponseError";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const factoryRoot = path.join(repoRoot, "creator-agent-factory");
  const intakeScript = path.join(factoryRoot, "scripts", "intake.py");
  const compilerScript = path.join(factoryRoot, "scripts", "factory.py");
  const skill = await readFile(path.join(factoryRoot, "SKILL.md"), "utf8");
  const workflow = await readFile(path.join(factoryRoot, "references", "agent-distillation-workflow.md"), "utf8");
  const contract = await readFile(path.join(factoryRoot, "references", "input-contract.md"), "utf8");
  const corpusContract = await readFile(path.join(repoRoot, "packages", "protocol", "AGENT_CORPUS.md"), "utf8");

  if (args.preflight) {
    const provider = requireKimiProviderConfig();
    console.log(JSON.stringify({
      ready: true,
      agent: "creator-factory-skill-executor",
      model: provider.model,
      semantic_executor: "Kimi agent",
      deterministic_steps: ["intake", "contract validation", "compiler", "release verification"],
      semantic_script: null
    }, null, 2));
    return;
  }

  const output = path.resolve(args.resume ?? args.output!);
  const resumed = Boolean(args.resume);
  if (!resumed) {
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
  }
  const intakeDir = path.join(output, "private-intake");
  const packDir = path.join(output, "private-source-pack");
  const buildDir = path.join(output, "compiled");
  if (!resumed) {
    await run("python3", [intakeScript, "--input", args.input!, "--intent-file", args.intent!, "--output", intakeDir]);
  }

  const intake = await readJson<Intake>(path.join(intakeDir, "intake.json"));
  const sourceBundle = await readNormalizedSources(intakeDir, intake.documents);
  const provider = requireKimiProviderConfig();
  const openai = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL });
  const runId = `factory_${randomUUID()}`;
  const agentSystem = factorySystemPrompt({ skill, workflow, contract, corpusContract });
  let envelope = resumed
    ? await readEnvelopeFromPack(packDir)
    : await askFactoryAgent(openai, provider.model, agentSystem, initialUserPrompt({ intake, sourceBundle }));
  let lastFailure = "";

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    try {
      // This is a mechanical contract projection, not a semantic rewrite. The
      // Factory Agent chose the values; the harness only canonicalizes two
      // documented aliases and single-page PDF provenance from deterministic
      // intake metadata before the compiler reads the pack.
      envelope = normalizePrivateContract(envelope, intake);
      await materializePrivateSourcePack(packDir, envelope);
      await run("python3", [compilerScript, "build", "--source-pack", packDir, "--intake-workspace", intakeDir, "--output", buildDir]);
      const compiledRelease = await readReleaseIdentity(buildDir);
      await run("python3", [compilerScript, "verify", "--release", String(compiledRelease.path)]);
      await writeJson(path.join(output, "agent-run.json"), {
        run_id: runId,
        semantic_executor: "Kimi agent executing creator-agent-factory/SKILL.md",
        provider: "moonshot",
        model: provider.model,
        temperature: KIMI_TEMPERATURE,
        thinking: KIMI_THINKING.type,
        input: {
          raw_material_directory: args.input ? path.resolve(args.input) : "preserved in private-intake",
          intent_file: args.intent ? path.resolve(args.intent) : path.join(intakeDir, "creator-intent.txt"),
          intake_digest: await hashTree(intakeDir)
        },
        private_source_pack_digest: await hashTree(packDir),
        compiled_release: compiledRelease,
        repair_attempts: attempt,
        resumed_from_existing_private_pack: resumed,
        structural_normalizer: "contract-key aliases and single-page PDF provenance only",
        semantic_script: null
      });
      console.log(JSON.stringify({
        passed: true,
        output,
        release: compiledRelease,
        model: provider.model,
        repair_attempts: attempt
      }, null, 2));
      return;
    } catch (error) {
      lastFailure = errorMessage(error);
      if (attempt === MAX_REPAIR_ATTEMPTS) break;
      const exactTraceDiagnostic = [
        await sourceTraceDiagnostic(envelope, intake, intakeDir),
        planSupportDiagnostic(envelope)
      ].join("\n");
      const compactContext = await buildRepairContext({ envelope, intake, intakeDir, failure: lastFailure, exactTraceDiagnostic });
      try {
        const repair = await askFactoryRepairAgent(openai, provider.model, factoryRepairSystemPrompt(), repairUserPrompt({ intake, failure: lastFailure, exactTraceDiagnostic, compactContext }));
        await appendFile(path.join(args.resume ?? args.output!, "agent-repairs.jsonl"), `${JSON.stringify({ attempt: attempt + 1, failure: lastFailure, repair })}\n`, "utf8");
        assertRepairTargetsFailure(repair, lastFailure);
        const patched = applyFactoryPatch(envelope, repair);
        const unresolvedTrace = await sourceTraceDiagnostic(patched, intake, intakeDir);
        if (!unresolvedTrace.startsWith("No exact quotation mismatch")) {
          throw new Error(`The repair patch still retains a quotation that is absent from raw Creator material. Remove or replace every listed claim; do not repeat it. ${unresolvedTrace}`);
        }
        envelope = patched;
        // Persist the Agent-authored private state immediately. If a later
        // repair fails or the process is interrupted, recovery resumes from
        // the latest semantic patch instead of silently replaying an older
        // pack.
        await materializePrivateSourcePack(packDir, envelope);
      } catch (repairError) {
        await appendFile(path.join(args.resume ?? args.output!, "agent-repairs.jsonl"), `${JSON.stringify({
          attempt: attempt + 1,
          apply_error: errorMessage(repairError),
          ...(repairError instanceof FactoryAgentResponseError
            ? { raw_response: repairError.rawResponse }
            : {})
        })}\n`, "utf8");
        throw new Error(`Factory Agent repair could not be applied: ${errorMessage(repairError)}`);
      }
    }
  }

  throw new Error(`Creator Factory agent could not produce a compiler-valid private source pack after ${MAX_REPAIR_ATTEMPTS + 1} attempts: ${lastFailure}`);
}

function parseArgs(argv: string[]): Arguments {
  const values = new Map<string, string>();
  let preflight = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--preflight") {
      preflight = true;
      continue;
    }
    if (!["--input", "--intent-file", "--output", "--resume"].includes(value)) throw new Error(`Unknown argument: ${value}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
    values.set(value, next);
    index += 1;
  }
  if (preflight) return { preflight: true };
  const input = values.get("--input");
  const intent = values.get("--intent-file");
  const output = values.get("--output");
  const resume = values.get("--resume");
  if (resume && (input || intent || output)) {
    throw new Error("--resume is an internal recovery mode and cannot be combined with --input, --intent-file, or --output");
  }
  if (resume) return { resume, preflight: false };
  if (!input || !intent || !output) {
    throw new Error("Usage: factorySkillExecutor --input <creator-material-directory> --intent-file <intent.txt> --output <private-output> [--preflight]");
  }
  return { input, intent, output, preflight: false };
}

function factorySystemPrompt(input: { skill: string; workflow: string; contract: string; corpusContract: string }): string {
  return [
    "You are the single semantic executing Agent for Hatch Creator Factory.",
    "You are not a generic assistant and must not ask the Creator for JSON, prompts, Skills, RAG chunks, Eval schemas, or tool manifests.",
    "Read the supplied ordinary course materials and natural-language intent completely. Make the semantic decisions yourself according to the Factory Skill.",
    "Do not inspect or rely on any prior release, old proof, expected answer, or baseline. Output only the private compiler envelope requested by the user message.",
    "Every Creator-authority claim must be an exact source substring. Derived rules need two or more independent support IDs. Synthetic QA and held-outs must be clearly synthetic.",
    "Purify aggressively: retain only source excerpts needed to substantiate the facts and method that the bounded product uses. Never reproduce a lesson, transcript, or prior deliverable in full merely because it was provided. The private source documents are a compact evidence layer, not a course archive.",
    "Keep Creator authority, Consumer-supplied task material, and generic domain knowledge separate. A bare task label is not evidence for a detailed customary framework. If that missing context would change a Creator's priorities, encode the smallest concrete input required and a useful partial path instead of filling the gap with generic expertise.",
    "Perform both a completeness pass and an adversarial pass before responding. Do not invent authority merely because it would be sensible domain advice.",
    "\n<creator_factory_skill>\n" + input.skill + "\n</creator_factory_skill>",
    "\n<agent_distillation_workflow>\n" + input.workflow + "\n</agent_distillation_workflow>",
    "\n<private_compiler_contract>\n" + input.contract + "\n</private_compiler_contract>",
    "\n<agent_corpus_contract>\n" + input.corpusContract + "\n</agent_corpus_contract>"
  ].join("\n\n");
}

function initialUserPrompt(input: { intake: Intake; sourceBundle: string }): string {
  return [
    "Execute the Skill now. The following is the complete normalized intake. Return one JSON object, no Markdown fence.",
    outputShape(),
    "<creator_intent>", input.intake.creator_supplied.product_intent, "</creator_intent>",
    "<normalized_creator_material>", input.sourceBundle, "</normalized_creator_material>"
  ].join("\n");
}

function factoryRepairSystemPrompt(): string {
  return [
    "You are the same Kimi Creator Factory Skill executor, in bounded repair mode.",
    "Creator input remains ordinary source material; this private patch protocol is internal and never shown to a Creator.",
    "Make the semantic correction yourself. You may not invent Creator authority, silently preserve a failed quotation, or ask the Creator for a schema.",
    "Return only valid JSON matching the requested private patch shape."
  ].join("\n");
}

function repairUserPrompt(input: { intake: Intake; failure: string; exactTraceDiagnostic: string; compactContext: string }): string {
  const traceFailure = !input.exactTraceDiagnostic.startsWith("No exact quotation mismatch");
  const lines = [
    "The deterministic compiler rejected your private source pack. You are still the same Creator Factory Skill executor.",
    "Do not regenerate the pack and do not make the Creator supply anything. Return one failure-scoped semantic repair patch only, no Markdown fence. If several compact evidence documents contain rejected claims, replace each affected document completely rather than returning truncated JSON.",
    repairOutputShape(),
    "Use JSON Pointer paths beginning with `/`. `operations` patch only source_manifest or factory_plan. Use `source_replacements` only for a compact evidence document that must be semantically corrected; include that full replacement document, not a diff.",
    "Repair the stated compiler failure and any directly related contract field you can see. Do not silently weaken a fact solely to make validation pass: re-check it against raw material, then correct or remove it if it is not exact.",
    "Do not repeat previous repairs or edit unrelated QA fields. Every `replace`, `remove`, and `move.from` pointer must already exist in the relevant repair context; use `add` only for a genuinely missing property.",
    "JSON Pointer reminder: each `relevant_plan_rows` item already gives the exact object `path`. If its `value` has an `answer`, the only valid answer-replacement path is `<that exact path>/answer`—there is no `/value` path in the Factory plan. When a deterministic contract diagnostic names an exact `path`, that exact existing path is the only place you may repair; never invent a friendly alias such as `/phase-1` or `/support`.",
    "<compiler_failure>", input.failure, "</compiler_failure>",
    "<deterministic_trace_diagnostic>", input.exactTraceDiagnostic, "</deterministic_trace_diagnostic>",
    "<creator_intent>", input.intake.creator_supplied.product_intent, "</creator_intent>",
    "<relevant_repair_context>", input.compactContext, "</relevant_repair_context>"
  ];
  if (traceFailure) lines.splice(7, 0, "NON-NEGOTIABLE TRACE REPAIR: return `operations: []`. Do not change the Factory plan, QA, Evals, or JSON Pointer fields. Keep the existing claim IDs and replace every affected compact source document in full using only exact substrings from the normalized raw material. A source claim is allowed to remain only if its new excerpt is exact. This repair is evidence correction, not a redesign; a patch with plan operations will be rejected.");
  if (/G09-held-out-separation/.test(input.failure)) lines.splice(7, 0, "G09 PRECISE REPAIR: the held-out IDs are already separate. The missing requirement is a non-empty `observable_checks` string array on every held_out_evals item. Add checks derived from that item's expected_behavior and forbidden behavior. Do not spend this repair changing categories or supports.");
  if (/G10-prompt-purification/.test(input.failure)) lines.splice(7, 0, "G10 PRECISE REPAIR: the system prompt is compiler-generated, not a source document. Never add or replace `sources/system-prompt.md`. Repair only the actual source_manifest or factory_plan field that causes the rendered prompt to fail; keep the repair narrow and evidence-grounded.");
  return lines.join("\n");
}

function outputShape(): string {
  return [
    "Required JSON envelope:",
    '{"schema":"hatch.creator-factory.private-source-pack.v1","source_manifest":{...},"factory_plan":{...},"source_documents":[{"source_id":"from intake","path":"sources/name.md","kind":"text|pdf|video","title":"...","authority":"creator-authored ...","content":"Compact Markdown with exact <!-- claim:S-... --> annotations and only the exact retained excerpts"}],"evidence_ledger_markdown":"...","semantic_audit_markdown":"..."}',
    "Use the compiler's exact field names. In particular source_manifest.product must use `version` (not `semantic_version`) and source_manifest.documents must carry `origin_source_id` and `origin_path` from intake. source_manifest must comply with input-contract.md and use only intake source IDs/provenance. factory_plan must fully comply with input-contract.md. `claim_annotations` is an object keyed by claim ID. `factory_plan.method.quality_bar`, `.omissions`, `.boundaries`, and `.priorities` are flat non-empty arrays of source-fact or derived-rule IDs—never descriptive objects. Every `factory_plan.method.phases` row must use `supports` (a non-empty flat array of existing source-fact or derived-rule IDs; never `supporting_claims`). Every `held_out_evals` row must include `id`, `category` (one of direct|composed|boundary|out_of_scope), `input`, `expected_behavior`, `observable_checks`, `forbidden_behavior`, `supports`, and `generic_baseline_risk`. Preserve all internal fields even when empty arrays would be invalid; fail closed instead of guessing."
  ].join("\n");
}

function repairOutputShape(): string {
  return [
    "Required JSON patch:",
    '{"schema":"hatch.creator-factory.private-source-pack-patch.v1","operations":[{"target":"source_manifest|factory_plan","op":"add|replace|remove|move","path":"/json/pointer","from":"/only/for/move","value":"required except remove/move"}],"source_replacements":[{"path":"sources/existing.md","content":"full corrected compact Markdown"}],"evidence_ledger_markdown":"optional full replacement","semantic_audit_markdown":"optional full replacement"}',
    "An empty array is valid when the previous pack is already correct for that dimension. The patch itself must make at least one change."
  ].join("\n");
}

async function askFactoryAgent(openai: OpenAI, model: string, system: string, user: string): Promise<FactoryEnvelope> {
  // Moonshot's OpenAI-compatible endpoint accepts `thinking`; the SDK's
  // upstream TypeScript surface intentionally does not model provider fields.
  const request: any = {
    model,
    temperature: KIMI_TEMPERATURE,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    response_format: { type: "json_object" },
    max_completion_tokens: 18_000,
    thinking: KIMI_THINKING,
    // A source pack can be large. Streaming prevents the proxy from holding
    // the whole JSON response before any bytes reach the client, while the
    // completed content is still validated as one atomic compiler input.
    stream: true
  };
  const stream = await (openai as any).chat.completions.create(request, {
    signal: factoryRequestSignal()
  });
  let content = "";
  for await (const chunk of stream) {
    content += chunk.choices?.[0]?.delta?.content ?? "";
  }
  if (!content) throw new Error("Kimi Factory Agent returned no private source pack");
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error("Kimi Factory Agent returned invalid JSON"); }
  return validateEnvelope(parsed);
}

async function askFactoryRepairAgent(openai: OpenAI, model: string, system: string, user: string): Promise<FactoryPatch> {
  const request: any = {
    model,
    temperature: KIMI_TEMPERATURE,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    response_format: { type: "json_object" },
    // A provenance failure can span several compact source documents. The old
    // 2k cap truncated a valid agent repair mid-JSON, turning a correct
    // fail-closed rejection into an opaque format failure. This budget still
    // applies only to a bounded patch of the existing private pack.
    max_completion_tokens: MAX_REPAIR_COMPLETION_TOKENS,
    thinking: KIMI_THINKING,
    // Repairs are intentionally small. Unlike first-pass distillation, they
    // should return one bounded patch; non-streaming avoids a provider-side
    // stream that can remain open after the complete JSON is available.
    stream: false
  };
  const completion = await (openai as any).chat.completions.create(request, {
    signal: factoryRequestSignal()
  });
  const content = completion.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("Kimi Factory Agent returned no repair patch");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(content));
  } catch {
    throw new FactoryAgentResponseError("Kimi Factory Agent returned invalid repair JSON", content.slice(0, 16_000));
  }
  return validateFactoryPatch(parsed);
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1] : trimmed;
}

function factoryRequestSignal(): AbortSignal {
  const configured = Number(process.env.HATCH_FACTORY_REQUEST_TIMEOUT_MS ?? DEFAULT_FACTORY_REQUEST_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FACTORY_REQUEST_TIMEOUT_MS;
  return AbortSignal.timeout(timeoutMs);
}

function validateEnvelope(value: unknown): FactoryEnvelope {
  if (!value || typeof value !== "object") throw new Error("Factory Agent envelope must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== SOURCE_PACK_SCHEMA) throw new Error(`Factory Agent must set schema to ${SOURCE_PACK_SCHEMA}`);
  if (!candidate.source_manifest || typeof candidate.source_manifest !== "object") throw new Error("Factory Agent envelope missing source_manifest");
  if (!candidate.factory_plan || typeof candidate.factory_plan !== "object") throw new Error("Factory Agent envelope missing factory_plan");
  if (!Array.isArray(candidate.source_documents) || candidate.source_documents.length === 0) throw new Error("Factory Agent envelope needs source_documents");
  const sourceDocuments = candidate.source_documents.map((document, index) => validateSourceDocument(document, index));
  return {
    schema: SOURCE_PACK_SCHEMA,
    source_manifest: candidate.source_manifest as Record<string, unknown>,
    factory_plan: candidate.factory_plan as Record<string, unknown>,
    source_documents: sourceDocuments,
    evidence_ledger_markdown: requireString(candidate.evidence_ledger_markdown, "evidence_ledger_markdown"),
    semantic_audit_markdown: requireString(candidate.semantic_audit_markdown, "semantic_audit_markdown")
  };
}

function validateFactoryPatch(value: unknown): FactoryPatch {
  if (!value || typeof value !== "object") throw new Error("Factory Agent repair must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== SOURCE_PACK_PATCH_SCHEMA) throw new Error(`Factory Agent repair must set schema to ${SOURCE_PACK_PATCH_SCHEMA}`);
  if (!Array.isArray(candidate.operations) || !Array.isArray(candidate.source_replacements)) {
    throw new Error("Factory Agent repair requires operations and source_replacements arrays");
  }
  const operations = candidate.operations.map((operation, index) => validatePatchOperation(operation, index));
  const sourceReplacements = candidate.source_replacements.map((replacement, index) => validateSourceReplacement(replacement, index));
  const evidenceLedger = normalizeOptionalAudit(candidate.evidence_ledger_markdown);
  const semanticAudit = normalizeOptionalAudit(candidate.semantic_audit_markdown);
  if (evidenceLedger !== undefined && typeof evidenceLedger !== "string") throw new Error("evidence_ledger_markdown must be a string when supplied");
  if (semanticAudit !== undefined && typeof semanticAudit !== "string") throw new Error("semantic_audit_markdown must be a string when supplied");
  if (operations.length === 0 && sourceReplacements.length === 0 && evidenceLedger === undefined && semanticAudit === undefined) {
    throw new Error("Factory Agent repair must make at least one change");
  }
  return {
    schema: SOURCE_PACK_PATCH_SCHEMA,
    operations,
    source_replacements: sourceReplacements,
    evidence_ledger_markdown: evidenceLedger,
    semantic_audit_markdown: semanticAudit
  };
}

function normalizeOptionalAudit(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "string" && value.trim().toLowerCase() === "optional full replacement") return undefined;
  return value as string | undefined;
}

function validatePatchOperation(value: unknown, index: number): JsonPatchOperation {
  if (!value || typeof value !== "object") throw new Error(`operations[${index}] must be an object`);
  const candidate = value as Record<string, unknown>;
  const target = candidate.target;
  const op = candidate.op;
  const patchPath = candidate.path;
  if (target !== "source_manifest" && target !== "factory_plan") throw new Error(`operations[${index}].target is invalid`);
  if (op !== "add" && op !== "replace" && op !== "remove" && op !== "move") throw new Error(`operations[${index}].op is invalid`);
  assertSafeJsonPointer(patchPath, `operations[${index}].path`);
  if ((op === "add" || op === "replace") && !("value" in candidate)) throw new Error(`operations[${index}] requires value`);
  if (op === "move") assertSafeJsonPointer(candidate.from, `operations[${index}].from`);
  return { target, op, path: patchPath, from: typeof candidate.from === "string" ? candidate.from : undefined, value: candidate.value };
}

function validateSourceReplacement(value: unknown, index: number): SourceReplacement {
  if (!value || typeof value !== "object") throw new Error(`source_replacements[${index}] must be an object`);
  const candidate = value as Record<string, unknown>;
  const relativePath = requireString(candidate.path, `source_replacements[${index}].path`);
  if (!relativePath.startsWith("sources/") || relativePath.includes("..") || path.isAbsolute(relativePath)) {
    throw new Error(`source_replacements[${index}].path must be an existing safe sources/ path`);
  }
  return { path: relativePath, content: requireString(candidate.content, `source_replacements[${index}].content`) };
}

function validateSourceDocument(value: unknown, index: number): SourceDocument {
  if (!value || typeof value !== "object") throw new Error(`source_documents[${index}] must be an object`);
  const candidate = value as Record<string, unknown>;
  const relativePath = requireString(candidate.path, `source_documents[${index}].path`);
  if (!relativePath.startsWith("sources/") || relativePath.includes("..") || path.isAbsolute(relativePath)) {
    throw new Error(`source_documents[${index}].path must be a safe sources/ path`);
  }
  return {
    source_id: requireString(candidate.source_id, `source_documents[${index}].source_id`),
    path: relativePath,
    kind: requireString(candidate.kind, `source_documents[${index}].kind`),
    title: requireString(candidate.title, `source_documents[${index}].title`),
    authority: requireString(candidate.authority, `source_documents[${index}].authority`),
    content: requireString(candidate.content, `source_documents[${index}].content`)
  };
}

function assertRepairTargetsFailure(repair: FactoryPatch, failure: string): void {
  const repairsHeldouts = repair.operations.some((operation) =>
    /^\/held_out_evals\/\d+\/observable_checks$/.test(operation.path)
    || (/^\/held_out_evals\/\d+$/.test(operation.path)
      && Boolean(asRecord(operation.value)?.observable_checks)
      && Array.isArray(asRecord(operation.value)?.observable_checks))
  );
  if (/G09-held-out-separation/.test(failure) && !repairsHeldouts) {
    throw new Error("G09 repair must add non-empty observable_checks arrays to held_out_evals; changing categories or supports is not a repair");
  }
}

function applyFactoryPatch(previous: FactoryEnvelope, patch: FactoryPatch): FactoryEnvelope {
  const next = structuredClone(previous);
  const targets: Record<JsonPatchOperation["target"], Record<string, unknown>> = {
    source_manifest: next.source_manifest,
    factory_plan: next.factory_plan
  };
  for (const operation of patch.operations) applyJsonPatchOperation(targets[operation.target], operation);

  const documentsByPath = new Map(next.source_documents.map((document) => [document.path, document]));
  for (const replacement of patch.source_replacements) {
    const document = documentsByPath.get(replacement.path);
    if (!document) throw new Error(`Factory Agent repair cannot add an unproven source document: ${replacement.path}`);
    document.content = replacement.content;
  }
  if (patch.evidence_ledger_markdown !== undefined) next.evidence_ledger_markdown = patch.evidence_ledger_markdown;
  if (patch.semantic_audit_markdown !== undefined) next.semantic_audit_markdown = patch.semantic_audit_markdown;
  return validateEnvelope(next);
}

function normalizePrivateContract(envelope: FactoryEnvelope, intake: Intake): FactoryEnvelope {
  const next = structuredClone(envelope);
  const product = asRecord(next.source_manifest.product);
  if (product && !product.version && typeof product.semantic_version === "string") {
    product.version = product.semantic_version;
    delete product.semantic_version;
  }
  if (product && (product.pricing_model === "fixed" || product.pricing_model === "per_task")) {
    product.pricing_model = "per_delivery";
  }
  if (product && typeof product.presentation === "string") {
    product.presentation = { format: product.presentation };
  }
  // A product boundary can arrive as one Creator-authored sentence. The
  // compiler consumes a list of release-boundary statements, so preserve that
  // exact sentence as its only member rather than treating its characters as
  // individual rules. This is shape canonicalization, not a new boundary.
  if (product && typeof product.boundaries === "string") {
    product.boundaries = [product.boundaries];
  }
  const documents = next.source_manifest.documents;
  const intakeById = new Map(intake.documents.map((document) => [document.source_id, document]));
  if (Array.isArray(documents)) {
    for (const document of documents) {
      const record = asRecord(document);
      if (!record || record.kind !== "pdf" || record.source_location) continue;
      const origin = intakeById.get(typeof record.origin_source_id === "string" ? record.origin_source_id : String(record.source_id ?? ""));
      const pages = asRecord(origin)?.pdf_provenance;
      const pageRows = asRecord(pages)?.pages;
      if (Array.isArray(pageRows) && pageRows.length === 1) {
        const location = asRecord(pageRows[0])?.location;
        if (typeof location === "string" && location) record.source_location = location;
      }
      delete record.page_locations;
    }
  }
  const method = asRecord(next.factory_plan.method);
  if (method && !method.quality_bar && Array.isArray(method.quality_bars)) {
    method.quality_bar = method.quality_bars;
    delete method.quality_bars;
  }
  // The private contract stores a quality bar as evidence IDs. Kimi may
  // include a helpful description beside them; preserve the cited support and
  // discard only that non-contract wrapper. This is canonicalization, not a
  // local semantic decision.
  if (method && !Array.isArray(method.quality_bar)) {
    const qualityBar = asRecord(method.quality_bar);
    if (qualityBar && Array.isArray(qualityBar.support)) {
      method.quality_bar = qualityBar.support;
    } else if (qualityBar && Array.isArray(qualityBar.supports)) {
      method.quality_bar = qualityBar.supports;
    }
  }
  // `priorities` is likewise a citation field in the compiler contract. The
  // Factory Agent may attach a prose label to each priority; preserve the
  // cited facts/rules in declaration order without inventing a new priority.
  if (method && Array.isArray(method.priorities) && method.priorities.some((value) => typeof value !== "string")) {
    const priorityIds = method.priorities.flatMap((value) => {
      if (typeof value === "string") return [value];
      const priority = asRecord(value);
      if (priority && Array.isArray(priority.support)) return priority.support;
      if (priority && Array.isArray(priority.supports)) return priority.supports;
      return [];
    });
    method.priorities = [...new Set(priorityIds)];
  }
  // The compiler indexes annotations by claim ID. A list of rows that already
  // carries an ID is an equivalent agent representation, so key it without
  // editing any label, priority, method role, or omission chosen by Kimi.
  if (Array.isArray(next.factory_plan.claim_annotations)) {
    const annotations: Record<string, unknown> = {};
    for (const row of next.factory_plan.claim_annotations) {
      const annotation = asRecord(row);
      const id = annotation?.id;
      if (typeof id !== "string" || !id) continue;
      const { id: _id, ...details } = annotation;
      annotations[id] = details;
    }
    next.factory_plan.claim_annotations = annotations;
  }
  const derivedRules = next.factory_plan.derived_rules;
  if (derivedRules && !Array.isArray(derivedRules) && typeof derivedRules === "object") {
    next.factory_plan.derived_rules = Object.entries(derivedRules as Record<string, unknown>).map(([id, row]) => ({ id, ...(asRecord(row) ?? {}) }));
  }
  const rules = next.factory_plan.derived_rules;
  if (Array.isArray(rules)) {
    for (const rule of rules) promoteSupportAlias(asRecord(rule));
  }
  if (method && Array.isArray(method.phases)) {
    for (const phase of method.phases) normalizeMethodPhase(asRecord(phase));
  }
  const qaSeeds = asRecord(next.factory_plan.qa_seeds);
  if (qaSeeds) {
    for (const rows of Object.values(qaSeeds)) {
      if (Array.isArray(rows)) for (const row of rows) promoteSupportAlias(asRecord(row));
    }
  }
  if (Array.isArray(next.factory_plan.held_out_evals)) {
    for (const row of next.factory_plan.held_out_evals) normalizeHeldOutEval(asRecord(row));
  }
  return validateEnvelope(next);
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function promoteSupportAlias(record: Record<string, any> | undefined): void {
  if (!record || record.supports) return;
  if (Array.isArray(record.support)) {
    record.supports = record.support;
    delete record.support;
    return;
  }
  // Kimi sometimes names a pure evidence-ID list `citations`. This is the
  // same ABI value as `supports`, not a locally inferred relationship; retain
  // the exact IDs selected by the Factory Agent and canonicalize only its key.
  if (Array.isArray(record.citations)) {
    record.supports = record.citations;
    delete record.citations;
  }
}

function normalizeHeldOutEval(record: Record<string, any> | undefined): void {
  if (!record) return;
  promoteSupportAlias(record);
  if (!record.input && typeof record.prompt === "string") {
    record.input = record.prompt;
    delete record.prompt;
  }
  if (!record.generic_baseline_risk && typeof record.generic_baseline_failure === "string") {
    record.generic_baseline_risk = record.generic_baseline_failure;
    delete record.generic_baseline_failure;
  }
  if (!record.forbidden && typeof record.forbidden_behavior === "string") {
    record.forbidden = [record.forbidden_behavior];
    delete record.forbidden_behavior;
  }
}

function normalizeMethodPhase(record: Record<string, any> | undefined): void {
  if (!record) return;
  // Kimi can label the exact evidence-ID list for a phase as
  // `supporting_claims`. This only canonicalizes the ABI key and retains the
  // agent-selected IDs verbatim; it does not derive new evidence locally.
  if (!record.supports && Array.isArray(record.supporting_claims)) {
    record.supports = record.supporting_claims;
    delete record.supporting_claims;
  }
  promoteSupportAlias(record);
  if (!record.instruction && typeof record.description === "string") {
    record.instruction = record.description;
    delete record.description;
  }
}

function assertSafeJsonPointer(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/") throw new Error(`${label} must be a non-root JSON Pointer`);
  for (const token of jsonPointerTokens(value)) {
    if (token === "__proto__" || token === "prototype" || token === "constructor") throw new Error(`${label} contains an unsafe token`);
  }
}

function jsonPointerTokens(pointer: string): string[] {
  return pointer.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function patchParent(root: Record<string, unknown>, pointer: string): { parent: Record<string, unknown> | unknown[]; key: string } {
  const tokens = jsonPointerTokens(pointer);
  const key = tokens.pop()!;
  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) throw new Error(`Patch path does not exist: ${pointer}`);
      current = current[index];
    } else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      throw new Error(`Patch path does not exist: ${pointer}`);
    }
  }
  if (!current || typeof current !== "object") throw new Error(`Patch parent is not a container: ${pointer}`);
  return { parent: current as Record<string, unknown> | unknown[], key };
}

function readJsonPointer(root: Record<string, unknown>, pointer: string): unknown {
  let current: unknown = root;
  for (const token of jsonPointerTokens(pointer)) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) throw new Error(`Patch source does not exist: ${pointer}`);
      current = current[index];
    } else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      throw new Error(`Patch source does not exist: ${pointer}`);
    }
  }
  return structuredClone(current);
}

function removeJsonPointer(root: Record<string, unknown>, pointer: string): unknown {
  const { parent, key } = patchParent(root, pointer);
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error(`Patch path does not exist: ${pointer}`);
    return parent.splice(index, 1)[0];
  }
  if (!Object.prototype.hasOwnProperty.call(parent, key)) throw new Error(`Patch path does not exist: ${pointer}`);
  const value = parent[key];
  delete parent[key];
  return value;
}

function writeJsonPointer(root: Record<string, unknown>, pointer: string, value: unknown, allowCreate: boolean): void {
  const { parent, key } = patchParent(root, pointer);
  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index > parent.length || (!allowCreate && index === parent.length)) {
      throw new Error(`Patch array path is invalid: ${pointer}`);
    }
    if (allowCreate) parent.splice(index, 0, value);
    else parent[index] = value;
    return;
  }
  if (!allowCreate && !Object.prototype.hasOwnProperty.call(parent, key)) throw new Error(`Patch path does not exist: ${pointer}`);
  parent[key] = value;
}

function applyJsonPatchOperation(root: Record<string, unknown>, operation: JsonPatchOperation): void {
  if (operation.op === "remove") {
    removeJsonPointer(root, operation.path);
    return;
  }
  if (operation.op === "move") {
    if (!operation.from) throw new Error("Move operation requires from");
    writeJsonPointer(root, operation.path, removeJsonPointer(root, operation.from), true);
    return;
  }
  writeJsonPointer(root, operation.path, operation.value, operation.op === "add");
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

async function materializePrivateSourcePack(destination: string, envelope: FactoryEnvelope): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.join(destination, "sources"), { recursive: true });
  await mkdir(path.join(destination, "work"), { recursive: true });
  await writeJson(path.join(destination, "source-manifest.json"), envelope.source_manifest);
  await writeJson(path.join(destination, "factory-plan.json"), envelope.factory_plan);
  const seen = new Set<string>();
  for (const document of envelope.source_documents) {
    if (seen.has(document.path)) throw new Error(`Factory Agent repeated source document path ${document.path}`);
    seen.add(document.path);
    await writeFile(path.join(destination, document.path), document.content, "utf8");
  }
  await writeFile(path.join(destination, "work", "evidence-ledger.md"), envelope.evidence_ledger_markdown, "utf8");
  await writeFile(path.join(destination, "work", "semantic-audit.md"), envelope.semantic_audit_markdown, "utf8");
}

async function readEnvelopeFromPack(packDir: string): Promise<FactoryEnvelope> {
  const sourceManifest = await readJson<Record<string, unknown>>(path.join(packDir, "source-manifest.json"));
  const factoryPlan = await readJson<Record<string, unknown>>(path.join(packDir, "factory-plan.json"));
  const documents = sourceManifest.documents;
  if (!Array.isArray(documents) || documents.length === 0) throw new Error("Cannot resume Factory: source-manifest.json has no documents");
  const sourceDocuments = await Promise.all(documents.map(async (document, index) => {
    if (!document || typeof document !== "object") throw new Error(`Cannot resume Factory: documents[${index}] is invalid`);
    const candidate = document as Record<string, unknown>;
    const relativePath = requireString(candidate.path, `documents[${index}].path`);
    return validateSourceDocument({
      source_id: candidate.source_id,
      path: relativePath,
      kind: candidate.kind,
      title: candidate.title,
      authority: candidate.authority,
      content: await readFile(path.join(packDir, relativePath), "utf8")
    }, index);
  }));
  return validateEnvelope({
    schema: SOURCE_PACK_SCHEMA,
    source_manifest: sourceManifest,
    factory_plan: factoryPlan,
    source_documents: sourceDocuments,
    evidence_ledger_markdown: await readFile(path.join(packDir, "work", "evidence-ledger.md"), "utf8"),
    semantic_audit_markdown: await readFile(path.join(packDir, "work", "semantic-audit.md"), "utf8")
  });
}

async function readNormalizedSources(intakeDir: string, documents: IntakeDocument[]): Promise<string> {
  const blocks: string[] = [];
  for (const document of documents) {
    const body = await readFile(path.join(intakeDir, document.extracted_path), "utf8");
    blocks.push([
      `<source id="${document.source_id}" path="${document.original_path}" kind="${document.kind}" raw_sha256="${document.raw_sha256}">`,
      body,
      "</source>"
    ].join("\n"));
  }
  return blocks.join("\n\n");
}

/**
 * Deterministic evidence diagnostic only. It never proposes replacement prose;
 * it tells the Factory Agent exactly which of its purported quotations cannot
 * be found in the Creator's original normalized material.
 */
async function sourceTraceDiagnostic(envelope: FactoryEnvelope, intake: Intake, intakeDir: string): Promise<string> {
  const rawById = new Map<string, string>();
  for (const document of intake.documents) {
    rawById.set(document.source_id, await readFile(path.join(intakeDir, document.extracted_path), "utf8"));
  }
  const rows: string[] = [];
  const claimPattern = /<!--\s*claim:([A-Z0-9-]+)\s*-->\s*(?:#[^\n]*\n)?\s*([^\n][\s\S]*?)(?=\n\s*<!--\s*claim:|$)/g;
  for (const document of envelope.source_documents) {
    const origin = rawById.get(document.source_id);
    if (!origin) continue;
    for (const match of document.content.matchAll(claimPattern)) {
      const excerpt = canonicalEvidenceText(match[2].trim().split(/\n\s*\n/, 1)[0]);
      if (!canonicalEvidenceText(origin).includes(excerpt)) {
        rows.push(JSON.stringify({
          claim_id: match[1],
          private_source_document: document.path,
          origin_source_id: document.source_id,
          exact_quote_found_in_raw: false,
          invalid_excerpt: excerpt
        }));
      }
    }
  }
  return rows.length ? rows.join("\n") : "No exact quotation mismatch was detected before this repair attempt.";
}

/**
 * A deterministic locator for bad evidence references. It does not choose a
 * replacement ID; it gives the semantic Factory Agent the one real pointer it
 * may inspect and repair, rather than encouraging it to guess a convenient
 * JSON shape from an opaque compiler error.
 */
function planSupportDiagnostic(envelope: FactoryEnvelope): string {
  const plan = envelope.factory_plan;
  const annotations = asRecord(plan.claim_annotations) ?? {};
  const validIds = new Set(Object.keys(annotations));
  const rules = Array.isArray(plan.derived_rules) ? plan.derived_rules : [];
  for (const rule of rules) {
    const id = asRecord(rule)?.id;
    if (typeof id === "string") validIds.add(id);
  }
  const invalid: Array<{ path: string; invalid_support_id: string }> = [];
  const check = (value: unknown, pointer: string) => {
    if (!Array.isArray(value)) return;
    value.forEach((id, index) => {
      if (typeof id === "string" && !validIds.has(id)) invalid.push({ path: `${pointer}/${index}`, invalid_support_id: id });
    });
  };
  rules.forEach((rule, index) => check(asRecord(rule)?.supports, `/derived_rules/${index}/supports`));
  const method = asRecord(plan.method);
  if (method) {
    for (const field of ["quality_bar", "omissions", "boundaries", "priorities"]) check(method[field], `/method/${field}`);
    if (Array.isArray(method.phases)) method.phases.forEach((phase, index) => check(asRecord(phase)?.supports, `/method/phases/${index}/supports`));
  }
  const qa = asRecord(plan.qa_seeds);
  if (qa) for (const [category, rows] of Object.entries(qa)) {
    if (Array.isArray(rows)) rows.forEach((row, index) => check(asRecord(row)?.supports, `/qa_seeds/${escapeJsonPointer(category)}/${index}/supports`));
  }
  if (Array.isArray(plan.held_out_evals)) plan.held_out_evals.forEach((row, index) => check(asRecord(row)?.supports, `/held_out_evals/${index}/supports`));
  return invalid.length
    ? invalid.map((row) => JSON.stringify({ deterministic_contract_diagnostic: "unknown_support_id", ...row })).join("\n")
    : "No invalid support identifier was detected before this repair attempt.";
}

function canonicalEvidenceText(value: string): string {
  // Match the compiler's provenance policy: whitespace and typographic quote
  // variants are presentation, not a semantic paraphrase. Words, figures,
  // punctuation other than quotes, and order remain exact.
  return value
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Give a repair turn just the sources and control-plane rows implicated by the
 * compiler error. This is context selection, not semantic transformation: it
 * neither changes a claim nor chooses what the Agent should retain.
 */
async function buildRepairContext(input: { envelope: FactoryEnvelope; intake: Intake; intakeDir: string; failure: string; exactTraceDiagnostic: string }): Promise<string> {
  const identifiers = new Set<string>(input.failure.match(/\b(?:S|R|QA|HO)-[A-Z0-9-]+\b/g) ?? []);
  for (const match of input.exactTraceDiagnostic.matchAll(/"claim_id":"([^"]+)"/g)) identifiers.add(match[1]);
  const sourceTokens = new Set([...identifiers]
    .filter((id) => id.startsWith("S-"))
    .map((id) => id.slice(2).replace(/-\d+$/, "").toLowerCase()));
  const matchesDocument = (value: string) => [...identifiers].some((id) => value.includes(id))
    || [...sourceTokens].some((token) => value.toLowerCase().includes(token));
  const relevantPrivateSources = input.envelope.source_documents
    .filter((document) => matchesDocument(`${document.path}\n${document.content}`));
  const relevantRaw = await Promise.all(input.intake.documents
    .filter((document) => matchesDocument(`${document.source_id}\n${document.original_path}`))
    .map(async (document) => ({
      source_id: document.source_id,
      original_path: document.original_path,
      content: await readFile(path.join(input.intakeDir, document.extracted_path), "utf8")
    })));
  const relevantPlanRows = findPlanRows(input.envelope.factory_plan, identifiers);
  const diagnosticPlanRows = [...input.exactTraceDiagnostic.matchAll(/"path":"([^"\\]+)"/g)].flatMap((match) => {
    try {
      return [{ path: match[1], value: readJsonPointer(input.envelope.factory_plan, match[1]) }];
    } catch {
      return [];
    }
  });
  const documents = Array.isArray(input.envelope.source_manifest.documents)
    ? input.envelope.source_manifest.documents.filter((document) => matchesDocument(JSON.stringify(document)))
    : [];
  const gateFailure = /G09-held-out-separation|G10-prompt-purification/.test(input.failure);
  return JSON.stringify({
    identified_ids: [...identifiers].sort(),
    relevant_manifest_documents: documents,
    relevant_plan_rows: [...relevantPlanRows, ...diagnosticPlanRows],
    relevant_private_source_documents: relevantPrivateSources,
    relevant_normalized_raw_material: relevantRaw,
    gate_repair_control_plane: gateFailure ? {
      creator: input.envelope.source_manifest.creator,
      product: input.envelope.source_manifest.product,
      method: input.envelope.factory_plan.method,
      qa_seeds: input.envelope.factory_plan.qa_seeds,
      held_out_evals: input.envelope.factory_plan.held_out_evals,
      derived_rules: input.envelope.factory_plan.derived_rules
    } : undefined
  });
}

function findPlanRows(value: unknown, identifiers: Set<string>, pointer = ""): Array<{ path: string; value: unknown }> {
  const rows: Array<{ path: string; value: unknown }> = [];
  const containsIdDirectly = (candidate: unknown) => {
    if (typeof candidate === "string") return identifiers.has(candidate) || [...identifiers].some((id) => candidate.includes(id));
    if (Array.isArray(candidate)) return candidate.some((item) => typeof item === "string" && identifiers.has(item));
    return false;
  };
  const visit = (candidate: unknown, currentPath: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${currentPath}/${index}`));
      return;
    }
    const record = asRecord(candidate);
    if (!record) return;
    if (Object.values(record).some(containsIdDirectly)) rows.push({ path: currentPath || "/", value: record });
    for (const [key, child] of Object.entries(record)) visit(child, `${currentPath}/${escapeJsonPointer(key)}`);
  };
  visit(value, pointer);
  return rows;
}

function escapeJsonPointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

async function run(command: string, args: string[]): Promise<void> {
  try {
    await execFile(command, args, { maxBuffer: 10 * 1024 * 1024 });
  } catch (error: unknown) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error([detail.message, detail.stdout, detail.stderr].filter(Boolean).join("\n").slice(-20_000));
  }
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function hashTree(root: string): Promise<string> {
  const hasher = createHash("sha256");
  async function visit(current: string): Promise<void> {
    for (const name of (await readdir(current)).sort()) {
      const target = path.join(current, name);
      const info = await stat(target);
      hasher.update(path.relative(root, target));
      if (info.isDirectory()) await visit(target);
      else hasher.update(await readFile(target));
    }
  }
  await visit(root);
  return `sha256:${hasher.digest("hex")}`;
}

async function readReleaseIdentity(buildDir: string): Promise<Record<string, unknown>> {
  const releaseRoot = path.join(buildDir, "release");
  const releaseIds = await readdir(releaseRoot);
  if (releaseIds.length !== 1) throw new Error("Compiler produced an unexpected release root");
  const releaseId = releaseIds[0];
  const digests = await readdir(path.join(releaseRoot, releaseId));
  if (digests.length !== 1) throw new Error("Compiler produced an unexpected release digest count");
  return { release_id: releaseId, release_digest: digests[0], path: path.join(releaseRoot, releaseId, digests[0]) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
