import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { AgentCorpusResolver } from "./agentCorpus.js";
import { DeterministicAgentRuntime } from "./agentRuntime.js";
import { FileEntitlementResolver } from "./entitlements.js";
import { createRuntimeServer, type RuntimeServer } from "./index.js";
import { LocalHarnessSession } from "./localHarness.js";

const temporaryDirectories: string[] = [];
const servers: RuntimeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("an entitlement resolves a layered Corpus without loading evals or knowledge into the Runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-agent-corpus-runtime-"));
  temporaryDirectories.push(root);
  const corpusRoot = path.join(root, "corpora");
  const workspace = path.join(root, "workspace");
  const agentDirectory = path.join(corpusRoot, "tenant-maya", "signal-resume-reviewer");
  await mkdir(path.join(agentDirectory, "instructions"), { recursive: true });
  await mkdir(path.join(agentDirectory, "skills", "signal-review"), { recursive: true });
  await mkdir(path.join(agentDirectory, "knowledge"), { recursive: true });
  await mkdir(path.join(agentDirectory, "evals"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "resume.txt"), "Maya's customer retention work", "utf8");

  const system = "Use the creator method. Read local evidence before making recommendations.";
  const skill = [
    "---",
    "name: signal-review",
    "description: Apply Maya's evidence standard.",
    "---",
    "",
    "# Signal review",
    "Prioritize concrete evidence."
  ].join("\n");
  const knowledge = "A strong resume starts with observable evidence, not inflated claims.";
  const syntheticQa = JSON.stringify({ cases: [{ input: "Review evidence", expected: "Use evidence" }] });
  const heldOut = JSON.stringify({ cases: [{ input: "Unknown claim", expected: "Do not invent" }] });
  await writeFile(path.join(agentDirectory, "instructions", "system.md"), system, "utf8");
  await writeFile(path.join(agentDirectory, "skills", "signal-review", "SKILL.md"), skill, "utf8");
  await writeFile(path.join(agentDirectory, "knowledge", "method.md"), knowledge, "utf8");
  await writeFile(path.join(agentDirectory, "evals", "synthetic-qa.json"), syntheticQa, "utf8");
  await writeFile(path.join(agentDirectory, "evals", "held-out.json"), heldOut, "utf8");
  await writeFile(path.join(agentDirectory, "agent.json"), JSON.stringify({
    contract_version: "1",
    agent_id: "signal-resume-reviewer",
    creator: { id: "maya-chen", name: "Maya Chen" },
    product: {
      id: "signal-resume-review", name: "Signal Resume Review", description: "Evidence-led resume review.",
      promise: "Review a resume using Maya's evidence standard.",
      inputs: ["A resume and optional role context."], outputs: ["Actionable evidence-led feedback."], boundaries: ["Does not guarantee a job offer."],
      offer: { model: "per_delivery", unit: "resume review", amount_minor: 3900, currency: "USD" }
    },
    instructions: { system: asset("system", "instructions/system.md", system) },
    skills: [{
      id: "signal-review", name: "Signal Review", when_to_use: "Use only for a resume review that needs Maya's evidence standard.",
      instruction: asset("signal-review", "skills/signal-review/SKILL.md", skill), references: [], allowed_tool_ids: ["hatch.web_search", "hatch.local.files"]
    }],
    knowledge: { documents: [{ id: "method", path: "knowledge/method.md", sha256: digestText(knowledge), retrieval_only: true, source_summary: "Maya's evidence-first resume method." }] },
    tools: [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
      { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" },
      { id: "hatch.local.files", kind: "local_harness", capability: "filesystem" }
    ],
    evaluations: {
      synthetic_qa: [asset("synthetic-qa", "evals/synthetic-qa.json", syntheticQa)],
      held_out: [asset("held-out", "evals/held-out.json", heldOut)]
    }
  }), "utf8");
  const entitlementFile = path.join(root, "entitlements.json");
  await writeFile(entitlementFile, JSON.stringify([{
    license_token: "buyer-token", entitlement_id: "entitlement-1", order_id: "order-1", tenant_id: "tenant-maya", user_id: "buyer-1",
    creator_id: "maya-chen", product_id: "signal-resume-review", agent_id: "signal-resume-reviewer", status: "active"
  }]), "utf8");

  const server = createRuntimeServer({
    createRuntime: () => new DeterministicAgentRuntime(),
    corpusResolver: new AgentCorpusResolver(corpusRoot),
    entitlementResolver: new FileEntitlementResolver(entitlementFile),
    agentKnowledgeSearch: {
      forAgent: (tenantId, agentId) => ({
        search: async () => ({
          data: [],
          scoped_to: `${tenantId}/${agentId}`
        })
      })
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as { port: number }).port;
  const session = new LocalHarnessSession({
    serverUrl: `ws://127.0.0.1:${port}/runtime`, workspace,
    entitlementId: "entitlement-1", licenseToken: "buyer-token", localTools: ["fs.list", "fs.read"]
  });
  try {
    await session.connect();
    // Current Corpus → Desktop exposes only display identity. The full product
    // contract remains server-side runtime context, not a buyer UI requirement.
    assert.deepEqual(session.getSessionReady()?.creator_agent, {
      creator: { id: "maya-chen", name: "Maya Chen" },
      product: { id: "signal-resume-review", name: "Signal Resume Review", description: "Evidence-led resume review." },
      presentation: {}
    });

    const result = await session.run("List the files in my workspace before reviewing the resume.");
    assert.ok(result.events.some((event) => event.type === "tool_call.request" && event.name === "fs.list"));
    assert.ok(result.events.some((event) => event.type === "assistant.delta"));
  } finally {
    session.close();
  }
});

function asset(id: string, filePath: string, content: string): { id: string; path: string; sha256: string } {
  return { id, path: filePath, sha256: digestText(content) };
}

function digestText(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
