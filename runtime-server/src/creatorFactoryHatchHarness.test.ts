import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentRuntime } from "./agentRuntime.js";
import { createHatchCliCandidateExecutor } from "./creatorLearning/cliCandidateExecutor.js";
import { materializeAgentCorpusBundle } from "./creatorLearning/corpusBundle.js";
import { FactoryFileStore } from "./creatorLearning/fileStore.js";
import { runHatchHarness } from "./hatchHarnessCli.js";
import { PROTOCOL_VERSION } from "./protocol.js";

const CANONICAL_LOCAL_TOOLS = [
  "file_list",
  "file_search",
  "file_read",
  "file_write",
  "file_patch",
  "shell_exec",
  "git_diff"
] as const;

test("one-shot harness binds a verified Corpus and traverses the full Hatch Runtime lifecycle", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-harness-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FactoryFileStore(root, "run-full-harness");
  await store.initialize();
  const system = "SYSTEM_FROM_VERIFIED_AGENT_CORPUS";
  const skillInstruction = "SKILL_FROM_VERIFIED_AGENT_CORPUS";
  const skillReference = "REFERENCE_FROM_VERIFIED_AGENT_CORPUS";
  const retrievalOnlyKnowledge = "KNOWLEDGE_MUST_NOT_BE_EAGERLY_INJECTED";
  const heldoutSecret = "SEALED_CREATOR_REFERENCE_MUST_NEVER_BE_MODEL_VISIBLE";
  const bundle = await materializeAgentCorpusBundle(store, {
    candidateRoot: "v1-fixed/agent-corpus",
    creator: { id: "creator-harness", name: "Creator Harness" },
    agentId: "offer-review",
    product: { id: "offer-review", name: "Offer Review" },
    systemInstructions: system,
    skills: [{
      id: "offer-critique",
      name: "Offer critique",
      whenToUse: "Make a decisive recommendation",
      instruction: skillInstruction,
      allowedToolIds: ["hatch.file_search"],
      references: [{ id: "decision-method", kind: "method", content: skillReference }]
    }],
    knowledge: [{
      id: "pricing-cases",
      content: retrievalOnlyKnowledge,
      sourceSummary: "Creator-authorized pricing cases"
    }],
    syntheticQa: [{ question: "development", answer: "creator reference" }],
    heldOut: [{ question: "heldout", answer: heldoutSecret }]
  });
  const corpusRoot = path.join(store.directory, ...bundle.bundleRoot.split("/"));
  const localRunnerBinary = await writeFakeLocalRunner(root);
  const scratchPrefix = "hatch-full-harness-";
  const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith(scratchPrefix)));

  const runtime: AgentRuntime = {
    async *run(input, context) {
      assert.match(context.agentSystemPrompt ?? "", new RegExp(system));
      assert.match(context.agentSystemPrompt ?? "", new RegExp(skillInstruction));
      assert.match(context.agentSystemPrompt ?? "", new RegExp(skillReference));
      assert.equal((context.agentSystemPrompt ?? "").includes(retrievalOnlyKnowledge), false);
      assert.equal(context.knowledgeAvailable, true);
      assert.equal(context.allowSkillRun, false);
      assert.deepEqual(context.clientTools, CANONICAL_LOCAL_TOOLS);
      const modelVisible = JSON.stringify({
        agentSystemPrompt: context.agentSystemPrompt,
        messages: context.messages,
        sessionSkills: context.sessionSkills,
        deliveryAuditContext: context.deliveryAuditContext
      });
      assert.equal(modelVisible.includes(heldoutSecret), false);
      assert.equal(modelVisible.includes(input.message.content), true);
      yield {
        type: "assistant.delta",
        run_id: input.run_id,
        delta: { kind: "text", content: `FULL_RUNTIME_RESULT:${input.message.content}` }
      };
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };
  const previousKnowledgeMode = process.env.HATCH_KNOWLEDGE_MODE;
  process.env.HATCH_KNOWLEDGE_MODE = "corpus-test";
  t.after(() => {
    if (previousKnowledgeMode === undefined) delete process.env.HATCH_KNOWLEDGE_MODE;
    else process.env.HATCH_KNOWLEDGE_MODE = previousKnowledgeMode;
  });
  const result = await runHatchHarness({
    corpusRoot,
    creatorId: "creator-harness",
    agentId: "offer-review",
    corpusDigest: bundle.digest,
    question: "Make the decisive recommendation.",
    timeoutMs: 5_000
  }, {
    createRuntime: () => runtime,
    environment: {
      HATCH_OUTPUT_GUARD: "off",
      HATCH_LOCAL_RUNNER_BIN: localRunnerBinary
    }
  });

  assert.equal(result.output, "FULL_RUNTIME_RESULT:Make the decisive recommendation.");
  assert.equal(result.corpusDigest, bundle.digest);
  assert.equal(result.finishReason, "stop");
  assert.equal(result.terminalStatus, "completed");
  assert.ok(result.protocolEvents.some((event) => (
    event.type === "session.ready" && event.acceptedProtocolVersion === PROTOCOL_VERSION
  )));
  assert.ok(result.protocolEvents.some((event) => event.type === "turn.completed"));
  assert.ok(result.protocolEvents.some((event) => event.type === "turn.state" && event.status === "completed"));

  const after = (await readdir(os.tmpdir())).filter((name) => name.startsWith(scratchPrefix) && !before.has(name));
  assert.deepEqual(after, []);
});

test("one-shot harness rejects a stale whole-Corpus digest before Runtime starts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-harness-digest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FactoryFileStore(root, "run-stale-digest");
  await store.initialize();
  const bundle = await materializeAgentCorpusBundle(store, {
    candidateRoot: "v1-fixed/agent-corpus",
    creator: { id: "creator-harness", name: "Creator Harness" },
    agentId: "offer-review",
    product: { id: "offer-review", name: "Offer Review" },
    systemInstructions: "Use the verified instructions.",
    syntheticQa: [{}],
    heldOut: [{}]
  });
  await assert.rejects(runHatchHarness({
    corpusRoot: path.join(store.directory, ...bundle.bundleRoot.split("/")),
    creatorId: "creator-harness",
    agentId: "offer-review",
    corpusDigest: `sha256:${"f".repeat(64)}`,
    question: "Question",
    timeoutMs: 5_000
  }), /digest mismatch/i);
});

test("one-shot harness returns the last successful file delivery instead of assistant UI narration", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-harness-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { bundle, corpusRoot } = await createMinimalHarnessCorpus(root, "run-file-delivery");
  const localRunnerBinary = await writeFakeLocalRunner(root);
  const deliverable = "# Publishable answer\n\nA decisive, sale-ready deliverable.\n";
  const runtime: AgentRuntime = {
    async *run(input, context) {
      assert.deepEqual(context.clientTools, CANONICAL_LOCAL_TOOLS);
      const arguments_ = { path: "output.md", content: deliverable };
      const writeResult = await context.clientBroker.execute(
        input.run_id,
        "file_write",
        arguments_,
        context.state,
        "write-delivery"
      );
      assert.equal(writeResult.ok, true);
      const readResult = await context.clientBroker.execute(
        input.run_id,
        "file_read",
        { path: "output.md" },
        context.state,
        "read-delivery"
      );
      assert.equal(readResult.content, deliverable);
      yield {
        type: "tool_call.delta",
        run_id: input.run_id,
        tool_call_id: "write-delivery",
        name: "file_write",
        locality: "client",
        approval: "auto",
        status: "completed",
        arguments: arguments_,
        result: writeResult
      };
      yield {
        type: "assistant.delta",
        run_id: input.run_id,
        delta: { kind: "text", content: "Saved output.md. Your work is ready." }
      };
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };

  const result = await runHatchHarness({
    corpusRoot,
    creatorId: "creator-harness",
    agentId: "offer-review",
    corpusDigest: bundle.digest,
    question: "Create and save the finished artifact to output.md.",
    timeoutMs: 5_000
  }, {
    createRuntime: () => runtime,
    environment: { HATCH_OUTPUT_GUARD: "off", HATCH_LOCAL_RUNNER_BIN: localRunnerBinary }
  });

  assert.equal(result.output, deliverable);
  assert.equal(result.output.includes("Your work is ready"), false);
  assert.ok(result.protocolEvents.some((event) => event.type === "tool_call.request" && event.name === "file_write"));
});

test("one-shot harness forwards a local tool error and lets the Hatch Agent recover", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-harness-tool-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { bundle, corpusRoot } = await createMinimalHarnessCorpus(root, "run-tool-error");
  const localRunnerBinary = await writeFakeLocalRunner(root);
  const runtime: AgentRuntime = {
    async *run(input, context) {
      await assert.rejects(context.clientBroker.execute(
        input.run_id,
        "file_read",
        { path: "missing.txt" },
        context.state,
        "read-missing"
      ), /ENOENT|no such file/i);
      yield {
        type: "assistant.delta",
        run_id: input.run_id,
        delta: { kind: "text", content: "RECOVERED_AFTER_LOCAL_TOOL_ERROR" }
      };
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  };

  const result = await runHatchHarness({
    corpusRoot,
    creatorId: "creator-harness",
    agentId: "offer-review",
    corpusDigest: bundle.digest,
    question: "Use the workspace if possible.",
    timeoutMs: 5_000
  }, {
    createRuntime: () => runtime,
    environment: { HATCH_OUTPUT_GUARD: "off", HATCH_LOCAL_RUNNER_BIN: localRunnerBinary }
  });
  assert.equal(result.output, "RECOVERED_AFTER_LOCAL_TOOL_ERROR");
});

test("one-shot harness fails before advertising tools when LocalRunner is unavailable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-harness-no-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { bundle, corpusRoot } = await createMinimalHarnessCorpus(root, "run-no-runner");
  let runtimeCreated = false;
  await assert.rejects(runHatchHarness({
    corpusRoot,
    creatorId: "creator-harness",
    agentId: "offer-review",
    corpusDigest: bundle.digest,
    question: "Question",
    timeoutMs: 5_000
  }, {
    createRuntime: () => {
      runtimeCreated = true;
      throw new Error("must not start");
    },
    environment: {
      HATCH_OUTPUT_GUARD: "off",
      HATCH_LOCAL_RUNNER_BIN: path.join(root, "missing-local-runner")
    }
  }), /HATCH_LOCAL_RUNNER_BIN is not an executable file/);
  assert.equal(runtimeCreated, false);
});

test("Factory candidate adapter uses a child CLI contract and propagates cancellation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-harness-child-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const successCli = path.join(root, "success.mjs");
  await writeFile(successCli, [
    "const chunks = [];",
    "for await (const chunk of process.stdin) chunks.push(chunk);",
    "const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
    "process.stdout.write(JSON.stringify({ok:true,output:`CLI:${input.question}`,runId:'child-run',corpusDigest:input.corpusDigest,finishReason:'stop',terminalStatus:'completed',protocolEvents:[{type:'turn.completed'},{type:'turn.state',status:'completed'}],protocolTraceTruncated:false}));"
  ].join("\n"), "utf8");
  const execution = {
    runId: "factory-run",
    corpusVersion: 1,
    agentCorpusRoot: "/tmp/candidate-corpus",
    creatorId: "creator-harness",
    agentId: "offer-review",
    corpusDigest: `sha256:${"a".repeat(64)}`,
    systemInstructions: "Not sent as an alternative prompt path.",
    question: "One generated task"
  };
  const execute = createHatchCliCandidateExecutor({ cliPath: successCli });
  const cliResult = await execute(execution);
  assert.notEqual(typeof cliResult, "string");
  assert.equal(typeof cliResult === "string" ? cliResult : cliResult.output, "CLI:One generated task");

  const waitingCli = path.join(root, "waiting.mjs");
  await writeFile(waitingCli, "process.stdin.resume(); setInterval(() => {}, 1000);\n", "utf8");
  const controller = new AbortController();
  const pending = createHatchCliCandidateExecutor({ cliPath: waitingCli })({ ...execution, signal: controller.signal });
  controller.abort(new Error("lease lost"));
  await assert.rejects(pending, /lease lost/);
});

test("Factory candidate child cannot inherit or dotenv-load deployment control-plane connections", async (t) => {
  // Keep the generated module below runtime-server so its real
  // `import \"dotenv/config\"` resolves through this package's node_modules.
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const root = await mkdtemp(path.join(packageRoot, ".hatch-child-env-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const registryRequests: string[] = [];
  const registry = http.createServer((request, response) => {
    registryRequests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    registry.once("error", reject);
    registry.listen(0, "127.0.0.1", () => {
      registry.removeListener("error", reject);
      resolve();
    });
  });
  t.after(() => new Promise<void>((resolve) => registry.close(() => resolve())));
  const address = registry.address();
  assert.ok(address && typeof address !== "string");
  const registryUrl = `http://127.0.0.1:${address.port}`;

  const isolatedNames = [
    "DATABASE_URL",
    "HATCH_FACTORY_DATABASE_URL",
    "HATCH_RUNTIME_DATABASE_URL",
    "HATCH_REGISTRY_DATABASE_URL",
    "HATCH_REGISTRY_URL",
    "HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN",
    "HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN",
    "HATCH_REGISTRY_ACCESS_SERVICE_TOKEN",
    "HATCH_REGISTRY_STATE_PATH",
    "HATCH_RUNTIME_SERVICE_TOKEN",
    "HATCH_COMMERCE_URL",
    "HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN",
    "HATCH_COMMERCE_LEDGER_FILE",
    "HATCH_COMMERCE_LEDGER_PATH",
    "HATCH_COMMERCE_DATABASE_URL",
    "HATCH_ENTITLEMENTS_FILE",
    "HATCH_AGENT_CORPUS_ROOT",
    "HATCH_RUNTIME_DATA_DIR",
    "HATCH_DELIVERY_OUTBOX_FILE",
    "HATCH_CREATOR_FACTORY_ROOT",
    "HATCH_CREATOR_FACTORY_WORKER_ID",
    "HATCH_QDRANT_URL",
    "HATCH_QDRANT_API_KEY",
    "HATCH_QDRANT_COLLECTION",
    "HATCH_DASHSCOPE_API_KEY",
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_EMBEDDING_BASE_URL",
    "DASHSCOPE_RERANK_BASE_URL",
    "HATCH_AUTH_SIGNING_SECRET",
    "HATCH_CREATOR_MODEL",
    "HATCH_REVIEWER_MODEL",
    "HATCH_COMPACTION_MODEL"
  ];
  const maliciousValues = Object.fromEntries(
    isolatedNames.map((name) => [name, `malicious-${name.toLowerCase()}`])
  ) as NodeJS.ProcessEnv;
  maliciousValues.HATCH_REGISTRY_URL = registryUrl;
  maliciousValues.HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN = "malicious-runtime-token";
  maliciousValues.DATABASE_URL = "postgresql://attacker:secret@127.0.0.1:5432/hatch";
  maliciousValues.HATCH_FACTORY_DATABASE_URL = maliciousValues.DATABASE_URL;
  maliciousValues.HATCH_RUNTIME_DATABASE_URL = maliciousValues.DATABASE_URL;
  maliciousValues.HATCH_REGISTRY_DATABASE_URL = maliciousValues.DATABASE_URL;
  maliciousValues.HATCH_CREATOR_MODEL = "kimi-k3";
  maliciousValues.HATCH_REVIEWER_MODEL = "kimi-k3";
  maliciousValues.HATCH_COMPACTION_MODEL = "kimi-k3";

  await writeFile(path.join(root, ".env"), [
    ...Object.entries(maliciousValues).map(([name, value]) => `${name}=${value}`),
    "HATCH_DOTENV_ATTACK_CANARY=loaded-from-parent-cwd"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "inspect-child.mjs"), [
    "import 'dotenv/config';",
    "import { registryAgentKnowledgeSearchFromEnvironment } from '../dist/agentKnowledge.js';",
    `const isolatedNames = ${JSON.stringify(isolatedNames)};`,
    "const chunks = [];",
    "for await (const chunk of process.stdin) chunks.push(chunk);",
    "const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
    "let registryConfigured = false;",
    "let registryError;",
    "try {",
    "  const resolver = registryAgentKnowledgeSearchFromEnvironment(process.env);",
    "  if (resolver) {",
    "    registryConfigured = true;",
    "    await resolver.forAgent('malicious-tenant', 'malicious-agent').search({ query: 'isolation probe' });",
    "  }",
    "} catch (error) { registryError = error instanceof Error ? error.message : String(error); }",
    "const leaked = Object.fromEntries(isolatedNames.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));",
    "const observation = {cwd:process.cwd(),pwd:process.env.PWD,dotenvConfigPath:process.env.DOTENV_CONFIG_PATH,dotenvCanary:process.env.HATCH_DOTENV_ATTACK_CANARY,registryConfigured,registryError,leaked,llmApiKey:process.env.LLM_API_KEY,openaiBaseUrl:process.env.OPENAI_BASE_URL,knowledgeMode:process.env.HATCH_KNOWLEDGE_MODE};",
    "process.stdout.write(JSON.stringify({ok:true,output:JSON.stringify(observation),runId:'isolated-child-run',corpusDigest:input.corpusDigest,finishReason:'stop',terminalStatus:'completed',protocolEvents:[{type:'turn.completed'},{type:'turn.state',status:'completed'}],protocolTraceTruncated:false}));"
  ].join("\n"), "utf8");

  const execution = {
    runId: "factory-isolated-child",
    corpusVersion: 1,
    agentCorpusRoot: "/tmp/candidate-corpus",
    creatorId: "creator-harness",
    agentId: "offer-review",
    corpusDigest: `sha256:${"b".repeat(64)}`,
    systemInstructions: "Not sent as an alternative prompt path.",
    question: "One isolated generated task"
  };
  const originalCwd = process.cwd();
  let result: Awaited<ReturnType<ReturnType<typeof createHatchCliCandidateExecutor>>>;
  process.chdir(root);
  try {
    // A relative CLI path verifies that changing the spawned child's cwd does
    // not lose the already-built dist/harness wrapper contract.
    result = await createHatchCliCandidateExecutor({
      cliPath: "./inspect-child.mjs",
      environment: {
        ...process.env,
        ...maliciousValues,
        LLM_API_KEY: "runtime-llm-key",
        OPENAI_BASE_URL: "https://api.moonshot.cn/v1",
        DOTENV_CONFIG_PATH: path.join(root, ".env"),
        DOTENV_CONFIG_OVERRIDE: "true"
      }
    })(execution);
  } finally {
    process.chdir(originalCwd);
  }

  assert.notEqual(typeof result, "string");
  const observation = JSON.parse(typeof result === "string" ? result : result.output) as {
    cwd: string;
    pwd?: string;
    dotenvConfigPath?: string;
    dotenvCanary?: string;
    registryConfigured: boolean;
    registryError?: string;
    leaked: Record<string, string>;
    llmApiKey?: string;
    openaiBaseUrl?: string;
    knowledgeMode?: string;
  };
  assert.deepEqual(observation.leaked, {});
  assert.equal(observation.registryConfigured, false);
  assert.equal(observation.registryError, undefined);
  assert.deepEqual(registryRequests, []);
  assert.equal(observation.dotenvCanary, undefined);
  assert.notEqual(observation.cwd, root);
  // macOS canonicalizes /var to /private/var for process.cwd(), while PWD
  // intentionally retains the logical path supplied to spawn.
  assert.equal(path.dirname(observation.dotenvConfigPath ?? ""), observation.pwd);
  assert.equal(path.basename(observation.pwd ?? ""), path.basename(observation.cwd));
  assert.equal(observation.llmApiKey, "runtime-llm-key");
  assert.equal(observation.openaiBaseUrl, "https://api.moonshot.cn/v1");
  assert.equal(observation.knowledgeMode, "corpus-test");
});

async function createMinimalHarnessCorpus(root: string, runId: string) {
  const store = new FactoryFileStore(root, runId);
  await store.initialize();
  const bundle = await materializeAgentCorpusBundle(store, {
    candidateRoot: "v1-fixed/agent-corpus",
    creator: { id: "creator-harness", name: "Creator Harness" },
    agentId: "offer-review",
    product: { id: "offer-review", name: "Offer Review" },
    systemInstructions: "Produce one decisive, publishable result.",
    syntheticQa: [{}],
    heldOut: [{}]
  });
  return {
    bundle,
    corpusRoot: path.join(store.directory, ...bundle.bundleRoot.split("/"))
  };
}

async function writeFakeLocalRunner(root: string): Promise<string> {
  const runner = path.join(root, "fake-hatch-local-runner.mjs");
  await writeFile(runner, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "import readline from 'node:readline';",
    "const sandboxIndex = process.argv.indexOf('--sandbox');",
    "if (sandboxIndex < 0 || !process.argv[sandboxIndex + 1] || !process.argv.includes('serve')) process.exit(64);",
    "const sandbox = path.resolve(process.argv[sandboxIndex + 1]);",
    "const inside = (candidate) => {",
    "  const resolved = path.resolve(sandbox, candidate);",
    "  if (resolved !== sandbox && !resolved.startsWith(`${sandbox}${path.sep}`)) throw new Error('path escapes sandbox');",
    "  return resolved;",
    "};",
    "const lines = readline.createInterface({input:process.stdin, crlfDelay:Infinity});",
    "for await (const line of lines) {",
    "  if (!line.trim()) continue;",
    "  let request;",
    "  try { request = JSON.parse(line); } catch (error) {",
    "    process.stdout.write(`${JSON.stringify({type:'sidecar.error',error:{code:'invalid_json',message:String(error)}})}\\n`);",
    "    continue;",
    "  }",
    "  const base = {type:'tool_call.result',run_id:request.run_id,tool_call_id:request.tool_call_id};",
    "  try {",
    "    let result;",
    "    if (request.name === 'file_list') {",
    "      const directory = inside(request.arguments?.path ?? '.');",
    "      const entries = await fs.readdir(directory, {withFileTypes:true});",
    "      result = {entries:entries.map((entry) => ({path:entry.name,name:entry.name,kind:entry.isDirectory()?'directory':'file',len:0}))};",
    "    } else if (request.name === 'file_write') {",
    "      const target = inside(request.arguments?.path);",
    "      await fs.mkdir(path.dirname(target), {recursive:true});",
    "      await fs.writeFile(target, request.arguments?.content, 'utf8');",
    "      result = {ok:true,path:request.arguments.path};",
    "    } else if (request.name === 'file_read') {",
    "      result = {content:await fs.readFile(inside(request.arguments?.path), 'utf8')};",
    "    } else {",
    "      throw new Error(`unsupported local tool: ${request.name}`);",
    "    }",
    "    process.stdout.write(`${JSON.stringify({...base,status:'ok',result})}\\n`);",
    "  } catch (error) {",
    "    process.stdout.write(`${JSON.stringify({...base,status:'error',error:{code:'tool_failed',message:error instanceof Error?error.message:String(error)}})}\\n`);",
    "  }",
    "}"
  ].join("\n"), "utf8");
  await chmod(runner, 0o755);
  return runner;
}
