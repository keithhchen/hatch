import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
      assert.deepEqual(context.clientTools, []);
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
    environment: { HATCH_OUTPUT_GUARD: "off" }
  });

  assert.equal(result.output, "FULL_RUNTIME_RESULT:Make the decisive recommendation.");
  assert.equal(result.corpusDigest, bundle.digest);
  assert.equal(result.finishReason, "stop");
  assert.equal(result.terminalStatus, "completed");
  assert.ok(result.protocolEvents.some((event) => event.type === "session.ready"));
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
