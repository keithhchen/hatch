/**
 * Creator Factory runner.
 *
 * Kimi executes the Creator Factory Skill and writes the finished Agent Corpus
 * directly. This runner deliberately has no distillation, purification,
 * synthetic-QA, or compiler logic: those are Skill decisions, not scripts.
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { KIMI_TEMPERATURE, KIMI_THINKING, requireKimiProviderConfig } from "./kimiProvider.js";
import { validateAgentCorpusPackage } from "./agentCorpus.js";

const execFile = promisify(execFileCallback);
const DEFAULT_REQUEST_TIMEOUT_MS = 8 * 60_000;

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

type RegistryPublication = {
  tenant_id: string;
  agent_id: string;
  creator_id: string;
  product_id: string;
  corpus_digest: string;
  rag: { backend: string; namespace: string };
  status: "published";
  published_at: string;
};

type Arguments = { input?: string; intent?: string; output?: string; tenantId?: string; preflight: boolean };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const factoryRoot = path.join(repoRoot, "creator-agent-factory");
  if (args.preflight) {
    const provider = requireKimiProviderConfig();
    console.log(JSON.stringify({
      ready: true,
      model: provider.model,
      semantic_executor: "Kimi executing creator-agent-factory/SKILL.md",
      deterministic_steps: ["intake", "safe artifact write"],
      semantic_script: null,
    }, null, 2));
    return;
  }

  const output = path.resolve(args.output!);
  const intakeDirectory = path.join(output, "private-intake");
  const corpusDirectory = path.join(output, "agent-corpus");
  await requireNewOutputDirectory(output);
  await mkdir(output, { recursive: true });
  await run("python3", [
    path.join(factoryRoot, "scripts", "intake.py"),
    "--input", path.resolve(args.input!),
    "--intent-file", path.resolve(args.intent!),
    "--output", intakeDirectory,
  ]);

  const [skill, workflow, corpusContract, corpusSchema, intake] = await Promise.all([
    readFile(path.join(factoryRoot, "SKILL.md"), "utf8"),
    readFile(path.join(factoryRoot, "references", "agent-distillation-workflow.md"), "utf8"),
    readFile(path.join(repoRoot, "packages", "protocol", "AGENT_CORPUS.md"), "utf8"),
    // `creator-agent.schema.json` is the public entrypoint and references this
    // canonical content. Embed the resolved schema, not an unresolved `$ref`,
    // in the Kimi Factory prompt.
    readFile(path.join(repoRoot, "packages", "protocol", "schemas", "agent-corpus.schema.json"), "utf8"),
    readJson<Intake>(path.join(intakeDirectory, "intake.json")),
  ]);
  const provider = requireKimiProviderConfig();
  const agent = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    timeout: factoryRequestTimeoutMs(),
    maxRetries: 1,
  });
  console.log(`Factory is executing Creator Factory Skill with ${provider.model}.`);
  await mkdir(corpusDirectory, { recursive: true });
  await runFactorySkill(agent, provider.model, {
    skill,
    workflow,
    corpusContract,
    corpusSchema,
    tenantId: args.tenantId!,
    intent: intake.creator_supplied.product_intent,
    intakeDirectory,
    documents: intake.documents,
    corpusDirectory,
  });
  // Kimi performs all semantic distillation. This deterministic gate only
  // rejects malformed or incomplete publishable packages before Registry ever
  // sees them; it does not infer, rewrite, or score Creator knowledge.
  await validateAgentCorpusPackage(corpusDirectory, args.tenantId!);
  const identity = await readCorpusIdentity(corpusDirectory);
  // Publishing is intentionally mechanical. The Factory Skill has already
  // made every semantic decision and written the Corpus; Registry verifies,
  // indexes its retrieval-only knowledge, then switches the one current
  // runnable definition on the shared POSIX host.
  const publication = await publishAgentCorpus(corpusDirectory, args.tenantId!, identity);
  await writeJson(path.join(output, "agent-run.json"), {
    run_id: `factory_${randomUUID()}`,
    semantic_executor: "Kimi agent executing creator-agent-factory/SKILL.md",
    provider: "moonshot",
    model: provider.model,
    temperature: KIMI_TEMPERATURE,
    thinking: KIMI_THINKING.type,
    input: {
      raw_material_directory: path.resolve(args.input!),
      intent_file: path.resolve(args.intent!),
      intake_digest: await hashTree(intakeDirectory),
    },
    agent_corpus: identity,
    registry_publication: publication,
    semantic_script: null,
  });
  console.log(JSON.stringify({ passed: true, output, agent_corpus: identity, registry_publication: publication, model: provider.model }, null, 2));
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
    if (!(["--input", "--intent-file", "--output", "--tenant-id"] as string[]).includes(value)) {
      throw new Error(`Unknown argument: ${value}`);
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
    values.set(value, next);
    index += 1;
  }
  if (preflight) return { preflight: true };
  const input = values.get("--input");
  const intent = values.get("--intent-file");
  const output = values.get("--output");
  const tenantId = values.get("--tenant-id");
  if (!input || !intent || !output || !tenantId) {
    throw new Error("Usage: factorySkillExecutor --input <Creator material directory> --intent-file <intent.txt> --output <workspace> --tenant-id <Hatch tenant id>");
  }
  return { input, intent, output, tenantId, preflight: false };
}

async function runFactorySkill(
  client: OpenAI,
  model: string,
  input: {
    skill: string;
    workflow: string;
    corpusContract: string;
    corpusSchema: string;
    tenantId: string;
    intent: string;
    intakeDirectory: string;
    documents: IntakeDocument[];
    corpusDirectory: string;
  },
): Promise<void> {
  const system = [
    "You are the single Kimi executor of Hatch's Creator Factory Skill.",
    "The Creator has supplied only ordinary source material and a natural-language product intent. Do every semantic task in the Skill yourself: distill, purify, identify necessary data/tool needs, and generate grounded synthetic QA plus held-outs. Never ask the Creator for JSON, prompts, schemas, Skills, RAG chunks, or Eval formats.",
    "Execute the Skill as an agent. Inspect the Creator material with the supplied tools, then write the finished Agent Corpus one file at a time with the supplied corpus-writing tools. Do not return a large JSON envelope or put corpus assets in chat text. Your semantic work belongs in the real Corpus files you write.",
    "Do not write source evidence, a Factory trace, reasoning, an intermediate plan, raw course material, release/version, model/provider, deployment data, credential, URL, approval policy, or vector-store ID into the Corpus. `agent.json` must conform to the supplied JSON Schema. Files must contain every referenced system instruction, optional SKILL.md / local references, clean retrieval-only knowledge document, and eval dataset. Use the supplied tenant_id exactly. hatch.web_search is required. Creator HTTP/MCP tools can contain only connection_ref and allowed function/tool declarations; never credentials or URLs.",
    "Use `factory_list_source_material` before reading sources. Use `factory_read_source` for the material you need. Use `factory_write_text_asset` for Markdown/text and `factory_write_json_asset` for agent.json and JSON assets. Write `agent.json` only after every referenced asset exists. `factory_list_written_corpus_assets` returns the exact sha256 digest required for each manifest asset; call it immediately before writing agent.json. When complete, call it once more, correct any missing files, then reply with a short plain-language completion sentence.",
    "<creator_factory_skill>\n" + input.skill + "\n</creator_factory_skill>",
    "<distillation_workflow>\n" + input.workflow + "\n</distillation_workflow>",
    "<agent_corpus_contract>\n" + input.corpusContract + "\n</agent_corpus_contract>",
    "<agent_corpus_json_schema>\n" + input.corpusSchema + "\n</agent_corpus_json_schema>",
  ].join("\n\n");
  const user = [
    "Execute the Factory Skill now.",
    `Hatch-owned tenant_id: ${input.tenantId}`,
    "<creator_intent>", input.intent, "</creator_intent>",
  ].join("\n");
  const messages: any[] = [{ role: "system", content: system }, { role: "user", content: user }];
  const tools = factoryAgentTools();
  let sawWrite = false;

  for (let turn = 0; turn < 36; turn += 1) {
    const completion = await (client as any).chat.completions.create({
      model,
      temperature: KIMI_TEMPERATURE,
      messages,
      tools,
      tool_choice: "auto",
      max_completion_tokens: 10_000,
      thinking: KIMI_THINKING,
      stream: false,
    }, { signal: requestSignal() });
    const message = completion.choices?.[0]?.message;
    if (!message) throw new Error("Kimi Factory Skill returned no message");
    messages.push(message);
    const toolCalls = message.tool_calls ?? [];
    if (!toolCalls.length) {
      if (!sawWrite) throw new Error("Kimi Factory Skill completed without writing an Agent Corpus");
      return;
    }
    for (const call of toolCalls) {
      const result = await executeFactoryToolCall(call, input);
      if (call.function?.name === "factory_write_text_asset" || call.function?.name === "factory_write_json_asset") sawWrite = true;
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error("Kimi Factory Skill exceeded 36 tool turns before completing the Agent Corpus");
}

function factoryAgentTools(): any[] {
  const noArguments = { type: "object", properties: {}, required: [], additionalProperties: false };
  return [
    {
      type: "function",
      function: {
        name: "factory_list_source_material",
        description: "List Creator-supplied normalized source materials available to inspect.",
        strict: true,
        parameters: noArguments,
      },
    },
    {
      type: "function",
      function: {
        name: "factory_read_source",
        description: "Read one Creator-supplied normalized source material by source_id.",
        strict: true,
        parameters: {
          type: "object",
          properties: { source_id: { type: "string", description: "The source id from factory_list_source_material." } },
          required: ["source_id"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "factory_write_text_asset",
        description: "Write one Markdown or text Agent Corpus asset. The path must be a permitted Corpus asset path.",
        strict: true,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative Agent Corpus path." },
            content: { type: "string", description: "Complete semantic content for this asset." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "factory_write_json_asset",
        description: "Write one JSON Agent Corpus asset, including agent.json and eval datasets, as a structured JSON value.",
        strict: true,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative Agent Corpus path." },
            value: { type: "object", description: "Complete structured JSON content for this asset." },
          },
          required: ["path", "value"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "factory_list_written_corpus_assets",
        description: "List the Corpus assets written so far. Use this to verify the real package before completion.",
        strict: true,
        parameters: noArguments,
      },
    },
  ];
}

async function executeFactoryToolCall(call: any, input: Pick<Parameters<typeof runFactorySkill>[2], "intakeDirectory" | "documents" | "corpusDirectory">): Promise<unknown> {
  const name = call?.function?.name;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call?.function?.arguments ?? "{}") as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Tool arguments must be valid JSON." };
  }
  if (name === "factory_list_source_material") {
    return {
      sources: input.documents.map(({ source_id, original_path, kind, raw_sha256 }) => ({ source_id, original_path, kind, raw_sha256 })),
    };
  }
  if (name === "factory_read_source") {
    const sourceId = args.source_id;
    if (typeof sourceId !== "string") return { ok: false, error: "source_id must be a string." };
    const source = input.documents.find((document) => document.source_id === sourceId);
    if (!source) return { ok: false, error: `Unknown source_id: ${sourceId}` };
    return {
      source_id: source.source_id,
      original_path: source.original_path,
      kind: source.kind,
      raw_sha256: source.raw_sha256,
      content: await readFile(path.join(input.intakeDirectory, source.extracted_path), "utf8"),
    };
  }
  if (name === "factory_write_text_asset") {
    const assetPath = args.path;
    const content = args.content;
    if (typeof assetPath !== "string" || typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "path and non-empty content are required." };
    }
    if (!safeTextCorpusPath(assetPath)) return { ok: false, error: `Not a permitted text Corpus path: ${assetPath}` };
    await writeCorpusAsset(input.corpusDirectory, assetPath, content);
    return { ok: true, path: assetPath };
  }
  if (name === "factory_write_json_asset") {
    const assetPath = args.path;
    if (typeof assetPath !== "string" || !isRecord(args.value)) {
      return { ok: false, error: "path and structured object value are required." };
    }
    if (!safeJsonCorpusPath(assetPath)) return { ok: false, error: `Not a permitted JSON Corpus path: ${assetPath}` };
    await writeCorpusAsset(input.corpusDirectory, assetPath, args.value);
    return { ok: true, path: assetPath };
  }
  if (name === "factory_list_written_corpus_assets") {
    return { assets: await listCorpusAssets(input.corpusDirectory) };
  }
  return { ok: false, error: `Unknown Factory tool: ${String(name)}` };
}

function safeTextCorpusPath(value: string): boolean {
  // Keep the Kimi writing surface identical to the published Corpus contract.
  // In particular, retrieval documents are normalized Markdown, never a
  // second ad-hoc JSON/text format that Registry will reject after the model
  // has already spent a full Factory run creating it.
  return /^(instructions\/[A-Za-z0-9._-]+\.md|skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:SKILL\.md|references\/[A-Za-z0-9._/-]+\.md)|knowledge\/[A-Za-z0-9._/-]+\.md)$/.test(value)
    && !value.includes("..") && !path.isAbsolute(value);
}

function safeJsonCorpusPath(value: string): boolean {
  return value === "agent.json" || (/^evals\/[A-Za-z0-9._/-]+\.json$/.test(value)
    && !value.includes("..") && !path.isAbsolute(value));
}

async function writeCorpusAsset(root: string, relative: string, value: string | Record<string, unknown>): Promise<void> {
  const destination = path.resolve(root, relative);
  if (!destination.startsWith(`${root}${path.sep}`)) throw new Error(`Corpus asset escapes output: ${relative}`);
  await mkdir(path.dirname(destination), { recursive: true });
  if (typeof value === "string") {
    await writeFile(destination, value.endsWith("\n") ? value : `${value}\n`, "utf8");
    return;
  }
  await writeJson(destination, value);
}

async function listCorpusAssets(root: string): Promise<Array<{ path: string; sha256: string }>> {
  async function visit(directory: string): Promise<Array<{ path: string; sha256: string }>> {
    const assets: Array<{ path: string; sha256: string }> = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) assets.push(...await visit(child));
      else if (entry.isFile()) {
        assets.push({
          path: path.relative(root, child),
          sha256: `sha256:${createHash("sha256").update(await readFile(child)).digest("hex")}`,
        });
      }
    }
    return assets;
  }
  return (await visit(root)).sort((left, right) => left.path.localeCompare(right.path));
}

async function requireNewOutputDirectory(output: string): Promise<void> {
  try {
    await stat(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Factory output directory already exists: ${output}. Choose a new empty path; Factory never overwrites prior output.`);
}

function requestSignal(): AbortSignal {
  return AbortSignal.timeout(factoryRequestTimeoutMs());
}

function factoryRequestTimeoutMs(): number {
  const configured = Number(process.env.HATCH_FACTORY_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REQUEST_TIMEOUT_MS;
}

async function run(command: string, args: string[]): Promise<void> {
  try {
    await execFile(command, args, { maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const detail = error as { message?: string; stdout?: string; stderr?: string };
    throw new Error([detail.message, detail.stdout, detail.stderr].filter(Boolean).join("\n").slice(-20_000));
  }
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readCorpusIdentity(corpusDirectory: string): Promise<Record<string, unknown>> {
  const corpus = await readJson<Record<string, unknown>>(path.join(corpusDirectory, "agent.json"));
  const creator = isRecord(corpus.creator) ? corpus.creator : undefined;
  const product = isRecord(corpus.product) ? corpus.product : undefined;
  return {
    // Agent Corpus v1 deliberately uses root identity fields. Reading the old
    // Release-shaped `agent.{id,tenant_id}` here made a valid Corpus fail only
    // after Kimi had completed the expensive semantic Factory work.
    tenant_id: requireString(corpus.tenant_id, "tenant_id"),
    agent_id: requireString(corpus.agent_id, "agent_id"),
    creator_id: requireString(creator?.id, "creator.id"),
    product_id: requireString(product?.id, "product.id"),
    corpus_digest: await hashTree(corpusDirectory),
    path: corpusDirectory,
  };
}

async function publishAgentCorpus(
  corpusDirectory: string,
  tenantId: string,
  identity: Record<string, unknown>,
): Promise<RegistryPublication> {
  const registryUrl = process.env.HATCH_REGISTRY_URL?.trim();
  const serviceToken = process.env.HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN?.trim();
  if (!registryUrl || !serviceToken) {
    throw new Error(
      "Factory publishing requires HATCH_REGISTRY_URL and HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN. " +
      "Run Factory on the shared POSIX host where Registry can resolve the Corpus path.",
    );
  }
  const endpoint = new URL("/v1/agent-corpora", registryUrl);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
        "x-hatch-tenant-id": tenantId,
      },
      body: JSON.stringify({ corpus_path: corpusDirectory }),
      signal: requestSignal(),
    });
  } catch (error) {
    throw new Error(`Registry did not accept the validated Agent Corpus: ${errorMessage(error)}`);
  }
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Registry rejected the validated Agent Corpus (${response.status}): ${responseText.slice(0, 2_000)}`);
  }
  let publication: RegistryPublication;
  try {
    publication = JSON.parse(responseText) as RegistryPublication;
  } catch {
    throw new Error("Registry returned an invalid publication record");
  }
  if (
    publication.status !== "published"
    || publication.tenant_id !== tenantId
    || publication.agent_id !== identity.agent_id
    || publication.creator_id !== identity.creator_id
    || publication.product_id !== identity.product_id
    || publication.corpus_digest !== identity.corpus_digest
    || !publication.rag?.backend
    || !publication.rag?.namespace
  ) {
    throw new Error("Registry publication record does not match the validated Agent Corpus");
  }
  return publication;
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        hash.update(path.relative(root, child));
        hash.update("\0");
        hash.update(await readFile(child));
      }
      else throw new Error(`unsupported Factory output entry: ${child}`);
    }
  }
  await visit(root);
  return `sha256:${hash.digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
