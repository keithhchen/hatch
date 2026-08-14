import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  materializeAgentCorpusBundle,
  type AgentCorpusBundleInput
} from "./creatorLearning/corpusBundle.js";
import { FactoryFileStore } from "./creatorLearning/fileStore.js";
import { verifyAgentCorpus } from "./registryCorpus.js";
import { loadSkillByPath } from "./skills.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("Creator Factory materializes every Agent Corpus layer with exact bytes and deterministic digests", async () => {
  const root = await temporaryRoot("hatch-factory-layered-corpus-");
  const store = new FactoryFileStore(root, "factory-layered-corpus-run");
  await store.initialize();
  const rawSecret = "RAW_SOURCE_PACKET_MUST_REMAIN_OUTSIDE_THE_CORPUS";
  const traceSecret = "FACTORY_TRACE_MUST_REMAIN_OUTSIDE_THE_CORPUS";
  await store.writeArtifact("raw/source-packet.md", `${rawSecret}\n`);
  await store.writeCandidate("v3-fixed/compile-record.md", `${traceSecret}\n`);

  const systemInstructions = [
    "# Evidence-first reviewer",
    "",
    "Keep the Creator's hierarchy intact.",
    ""
  ].join("\n");
  const skillInstructions = [
    "# Claim audit",
    "",
    "1. Preserve nested structure:",
    "   - primary evidence",
    "     - source limitations",
    "2. Emit the exact fenced shape:",
    "",
    "```json",
    "{\"verdict\": \"supported\"}",
    "```",
    ""
  ].join("\n");
  const methodReference = [
    "# Method map",
    "",
    "> Evidence",
    "> - direct",
    ">   - corroborated",
    "",
    "| Rank | Meaning |",
    "| ---: | :--- |",
    "| 1 | Primary |",
    ""
  ].join("\n");
  const fewShotsReference = [
    "# Few shots",
    "",
    "## Input",
    "",
    "`利润增长了吗？`",
    "",
    "## Output",
    "",
    "- 结论",
    "  - 证据",
    "    - 限制",
    ""
  ].join("\n");
  const knowledgeDocument = [
    "# Source ledger",
    "",
    "## 2026",
    "",
    "### Filing A",
    "",
    "- Revenue",
    "  - Reported: 42",
    "    - Unit: CNY million",
    "",
    "```text",
    "line one",
    "  line two",
    "```",
    ""
  ].join("\n");
  const syntheticQa = [
    { id: "D.Q1", question: "What evidence should lead?", answer: "The strongest verified evidence." }
  ];
  const heldOut = [
    { id: "H.Q1", question: "Can the Agent invent a result?", answer: "No." }
  ];
  const input: AgentCorpusBundleInput & { rawMaterial: string; factoryTrace: string } = {
    candidateRoot: "v3-fixed/agent-corpus",
    creator: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Maya Chen" },
    agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    product: {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      name: "Signal Review",
      description: "Review a claim against supplied evidence.",
      promise: "Return an evidence-ranked verdict.",
      boundaries: ["Never invent evidence."],
      presentation: { accent: "indigo", layout: { density: "compact" } }
    },
    systemInstructions,
    skills: [{
      id: "claim-audit",
      name: "Claim audit",
      whenToUse: "Use when a claim needs an evidence audit.",
      instruction: skillInstructions,
      allowedToolIds: ["hatch.web_search", "creator.signal.lookup"],
      references: [
        { id: "method-map", kind: "method", content: methodReference, description: "Evidence ranking method." },
        { id: "review-examples", kind: "few_shots", content: fewShotsReference }
      ]
    }],
    knowledge: [{
      id: "source-ledger",
      content: knowledgeDocument,
      sourceSummary: "Creator-supplied filing ledger.",
      description: "Long-tail facts for retrieval."
    }],
    tools: [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search", description: "Search public evidence." },
      { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" },
      {
        id: "creator.signal.lookup",
        kind: "http_function",
        connection_ref: "signal-lookup",
        operation: "lookup_claim",
        description: "Look up a claim in the Creator service.",
        input_schema: {
          type: "object",
          properties: { claim: { type: "string", minLength: 1 } },
          required: ["claim"],
          additionalProperties: false
        }
      },
      {
        id: "creator.signal.citations",
        kind: "mcp_tool",
        connection_ref: "signal-mcp",
        tool_name: "list_citations"
      },
      { id: "hatch.local.audit-files", kind: "local_harness", capability: "filesystem" }
    ],
    syntheticQa,
    heldOut,
    rawMaterial: rawSecret,
    factoryTrace: traceSecret
  };
  const materialized = await materializeAgentCorpusBundle(store, input);

  assert.equal(materialized.bundleRoot, "candidate/v3-fixed/agent-corpus");
  assert.equal(materialized.manifestRef.path, `${materialized.bundleRoot}/agent.json`);
  assert.equal(materialized.assets.system.path, `${materialized.bundleRoot}/instructions/system.md`);
  assert.equal(materialized.assets.skills[0]?.instruction.path, `${materialized.bundleRoot}/skills/claim-audit/SKILL.md`);
  assert.deepEqual(materialized.assets.skills[0]?.references.map((item) => item.asset.path), [
    `${materialized.bundleRoot}/skills/claim-audit/references/method-map.md`,
    `${materialized.bundleRoot}/skills/claim-audit/references/review-examples.md`
  ]);
  assert.equal(materialized.assets.knowledge[0]?.asset.path, `${materialized.bundleRoot}/knowledge/source-ledger.md`);
  assert.equal(materialized.assets.syntheticQa.path, `${materialized.bundleRoot}/evals/synthetic-qa.json`);
  assert.equal(materialized.assets.heldOut.path, `${materialized.bundleRoot}/evals/held-out.json`);

  const bundlePath = path.join(store.directory, ...materialized.bundleRoot.split("/"));
  const verified = await verifyAgentCorpus(bundlePath, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(verified.digest, materialized.digest);
  assert.equal(verified.corpus.creator.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(verified.corpus.agent_id, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(verified.corpus.skills[0]?.instruction.path, "skills/claim-audit/SKILL.md");
  assert.deepEqual(verified.corpus.skills[0]?.references.map((item) => [item.asset.id, item.asset.path, item.kind]), [
    ["method-map", "skills/claim-audit/references/method-map.md", "method"],
    ["review-examples", "skills/claim-audit/references/review-examples.md", "few_shots"]
  ]);
  assert.deepEqual(verified.corpus.skills[0]?.allowed_tool_ids, ["hatch.web_search", "creator.signal.lookup"]);
  assert.deepEqual(verified.corpus.knowledge.documents.map((document) => ({
    id: document.id,
    path: document.path,
    retrievalOnly: document.retrieval_only,
    sourceSummary: document.source_summary
  })), [{
    id: "source-ledger",
    path: "knowledge/source-ledger.md",
    retrievalOnly: true,
    sourceSummary: "Creator-supplied filing ledger."
  }]);
  assert.deepEqual(verified.corpus.tools.map((tool) => tool.id), [
    "hatch.web_search",
    "hatch.file_search",
    "creator.signal.lookup",
    "creator.signal.citations",
    "hatch.local.audit-files"
  ]);
  await assert.rejects(verifyAgentCorpus(bundlePath, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"), /creator binding mismatch/);
  await assert.rejects(verifyAgentCorpus(bundlePath, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"), /agent binding mismatch/);

  assert.equal(await readFile(path.join(bundlePath, "instructions/system.md"), "utf8"), systemInstructions);
  const materializedSkill = await readFile(path.join(bundlePath, "skills/claim-audit/SKILL.md"), "utf8");
  assert.equal(materializedSkill, [
    "---",
    'name: "claim-audit"',
    'description: "Use when a claim needs an evidence audit."',
    "---",
    "",
    skillInstructions
  ].join("\n"));
  const loadedSkill = await loadSkillByPath(
    path.join(bundlePath, "skills/claim-audit/SKILL.md"),
    [bundlePath]
  );
  assert.equal(loadedSkill.name, "claim-audit");
  assert.equal(loadedSkill.description, "Use when a claim needs an evidence audit.");
  assert.equal(loadedSkill.instructions, skillInstructions.trim());
  assert.equal(await readFile(path.join(bundlePath, "skills/claim-audit/references/method-map.md"), "utf8"), methodReference);
  assert.equal(await readFile(path.join(bundlePath, "skills/claim-audit/references/review-examples.md"), "utf8"), fewShotsReference);
  assert.equal(await readFile(path.join(bundlePath, "knowledge/source-ledger.md"), "utf8"), knowledgeDocument);

  const manifestText = await readFile(path.join(bundlePath, "agent.json"), "utf8");
  const syntheticText = await readFile(path.join(bundlePath, SYNTHETIC_QA_PATH), "utf8");
  const heldOutText = await readFile(path.join(bundlePath, HELD_OUT_PATH), "utf8");
  assert.ok(manifestText.endsWith("\n"));
  assert.ok(syntheticText.endsWith("\n"));
  assert.ok(heldOutText.endsWith("\n"));
  const manifest = JSON.parse(manifestText) as {
    instructions: { system: { sha256: string } };
    skills: Array<{
      instruction: { sha256: string };
      references: Array<{ asset: { sha256: string; description?: string } }>;
    }>;
    knowledge: { documents: Array<{ sha256: string; description?: string }> };
    evaluations: {
      synthetic_qa: Array<{ sha256: string }>;
      held_out: Array<{ sha256: string }>;
    };
  };
  assert.equal(manifest.instructions.system.sha256, digest(systemInstructions));
  assert.equal(manifest.instructions.system.sha256, materialized.assets.system.sha256);
  assert.equal(manifest.skills[0]?.instruction.sha256, digest(materializedSkill));
  assert.equal(manifest.skills[0]?.instruction.sha256, materialized.assets.skills[0]?.instruction.sha256);
  assert.equal(manifest.skills[0]?.references[0]?.asset.sha256, digest(methodReference));
  assert.equal(manifest.skills[0]?.references[0]?.asset.sha256, materialized.assets.skills[0]?.references[0]?.asset.sha256);
  assert.equal(manifest.skills[0]?.references[0]?.asset.description, "Evidence ranking method.");
  assert.equal(manifest.knowledge.documents[0]?.sha256, digest(knowledgeDocument));
  assert.equal(manifest.knowledge.documents[0]?.sha256, materialized.assets.knowledge[0]?.asset.sha256);
  assert.equal(manifest.knowledge.documents[0]?.description, "Long-tail facts for retrieval.");
  assert.equal(manifest.evaluations.synthetic_qa[0]?.sha256, digest(syntheticText));
  assert.equal(manifest.evaluations.held_out[0]?.sha256, digest(heldOutText));
  assert.notEqual(materialized.digest, materialized.assets.system.sha256);
  assert.equal(materialized.digest, await wholeCorpusDigest(bundlePath));

  assert.deepEqual(await filesUnder(bundlePath), [
    "agent.json",
    "evals/held-out.json",
    "evals/synthetic-qa.json",
    "instructions/system.md",
    "knowledge/source-ledger.md",
    "skills/claim-audit/SKILL.md",
    "skills/claim-audit/references/method-map.md",
    "skills/claim-audit/references/review-examples.md"
  ]);
  assert.doesNotMatch(manifestText, new RegExp(`${rawSecret}|${traceSecret}|rawMaterial|factoryTrace`));

  const duplicateStore = new FactoryFileStore(root, "factory-layered-corpus-duplicate-run");
  await duplicateStore.initialize();
  const duplicate = await materializeAgentCorpusBundle(duplicateStore, input);
  const duplicateRoot = path.join(duplicateStore.directory, ...duplicate.bundleRoot.split("/"));
  assert.equal(await readFile(path.join(duplicateRoot, "agent.json"), "utf8"), manifestText);
  assert.equal(duplicate.digest, materialized.digest);
  for (const file of (await filesUnder(bundlePath)).filter((file) => file !== "agent.json")) {
    assert.equal(await readFile(path.join(duplicateRoot, file), "utf8"), await readFile(path.join(bundlePath, file), "utf8"));
  }
});

test("Creator Factory keeps empty optional layers valid and injects both canonical built-ins", async () => {
  const root = await temporaryRoot("hatch-factory-empty-corpus-");
  const store = new FactoryFileStore(root, "factory-empty-corpus-run");
  await store.initialize();

  const materialized = await materializeAgentCorpusBundle(store, baseInput("v1-empty/agent-corpus"));
  const bundlePath = path.join(store.directory, ...materialized.bundleRoot.split("/"));
  const verified = await verifyAgentCorpus(bundlePath, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");

  assert.deepEqual(verified.corpus.skills, []);
  assert.deepEqual(verified.corpus.knowledge.documents, []);
  assert.deepEqual(verified.corpus.tools, [
    { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
    { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" }
  ]);
  assert.deepEqual(materialized.assets.skills, []);
  assert.deepEqual(materialized.assets.knowledge, []);
  assert.deepEqual(await filesUnder(bundlePath), [
    "agent.json",
    "evals/held-out.json",
    "evals/synthetic-qa.json",
    "instructions/system.md"
  ]);
});

test("Creator Factory rejects unknown, duplicate, unsafe, and path-controlling layer input before writing", async () => {
  const root = await temporaryRoot("hatch-factory-invalid-layers-");
  const store = new FactoryFileStore(root, "factory-invalid-layers-run");
  await store.initialize();

  await assert.rejects(materializeAgentCorpusBundle(store, {
    ...baseInput("invalid/unknown-tool"),
    skills: [{
      id: "audit",
      name: "Audit",
      whenToUse: "For audits.",
      instruction: "# Audit\n",
      allowedToolIds: ["creator.missing"]
    }]
  }), /allows unknown tool id/);

  await assert.rejects(materializeAgentCorpusBundle(store, {
    ...baseInput("invalid/duplicate-tool"),
    tools: [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }
    ]
  }), /duplicate id: hatch\.web_search/);

  await assert.rejects(materializeAgentCorpusBundle(store, {
    ...baseInput("invalid/duplicate-asset"),
    skills: [{
      id: "shared-id",
      name: "Audit",
      whenToUse: "For audits.",
      instruction: "# Audit\n"
    }],
    knowledge: [{
      id: "shared-id",
      content: "# Facts\n",
      sourceSummary: "Creator notes."
    }]
  }), /id shared-id is duplicated/);

  await assert.rejects(materializeAgentCorpusBundle(store, {
    ...baseInput("invalid/unsafe-id"),
    skills: [{
      id: "../escape",
      name: "Audit",
      whenToUse: "For audits.",
      instruction: "# Audit\n"
    }]
  }), /canonical identifier/);

  await assert.rejects(materializeAgentCorpusBundle(store, {
    ...baseInput("invalid/reference-kind"),
    skills: [{
      id: "audit",
      name: "Audit",
      whenToUse: "For audits.",
      instruction: "# Audit\n",
      references: [{ id: "reference", kind: "retrieval" as "method", content: "# Wrong layer\n" }]
    }]
  }), /kind must be method, style, example, or few_shots/);

  await assert.rejects(materializeAgentCorpusBundle(store, {
    ...baseInput("invalid/caller-path"),
    knowledge: [{
      id: "facts",
      content: "# Facts\n",
      sourceSummary: "Creator notes.",
      path: "../model-controlled.md"
    } as never]
  }), /unsupported fields: path/);

  assert.deepEqual(await readdir(path.join(store.directory, "candidate")), []);
});

test("Creator Factory rejects forbidden secret, URL, and provider tool configuration before writing", async () => {
  const root = await temporaryRoot("hatch-factory-forbidden-tool-");
  const store = new FactoryFileStore(root, "factory-forbidden-tool-run");
  await store.initialize();

  for (const forbidden of [
    { endpoint: "https://tools.example.test" },
    { baseUrl: "https://tools.example.test" },
    { provider: "some-provider" },
    { secret_ref: "runtime-secret" }
  ]) {
    await assert.rejects(materializeAgentCorpusBundle(store, {
      ...baseInput("invalid/forbidden-tool"),
      tools: [{
        id: "creator.signal.lookup",
        kind: "http_function",
        connection_ref: "signal-lookup",
        operation: "lookup_claim",
        ...forbidden
      } as never]
    }), /forbidden tool configuration field/);
  }

  await assert.rejects(materializeAgentCorpusBundle(store, {
    ...baseInput("invalid/unknown-kind"),
    tools: [{ id: "creator.signal.lookup", kind: "grpc", connection_ref: "signal-lookup" } as never]
  }), /unknown tool kind/);
  assert.deepEqual(await readdir(path.join(store.directory, "candidate")), []);
});

test("Creator Factory rejects unsafe Agent Corpus candidate roots before writing", async () => {
  const root = await temporaryRoot("hatch-factory-corpus-path-");
  const store = new FactoryFileStore(root, "factory-corpus-path-run");
  await store.initialize();

  await assert.rejects(materializeAgentCorpusBundle(store, baseInput("../escaped/agent-corpus")), /safe relative path/);
  assert.deepEqual(await readdir(path.join(store.directory, "candidate")), []);
});

function baseInput(candidateRoot: string): AgentCorpusBundleInput {
  return {
    candidateRoot,
    creator: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Maya Chen" },
    agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    product: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Signal Review" },
    systemInstructions: "Stay in scope.\n",
    syntheticQa: [],
    heldOut: []
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
    }
  }
  await walk(root);
  return files.sort();
}

async function wholeCorpusDigest(root: string): Promise<string> {
  const rows = await Promise.all((await filesUnder(root)).map(async (file): Promise<[string, string]> => [
    file,
    digest(await readFile(path.join(root, file), "utf8"))
  ]));
  rows.sort((left, right) => left[0].localeCompare(right[0]));
  return digest(JSON.stringify(rows));
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const SYNTHETIC_QA_PATH = "evals/synthetic-qa.json";
const HELD_OUT_PATH = "evals/held-out.json";
