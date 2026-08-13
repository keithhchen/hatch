import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeAgentCorpus } from "./agentCorpusMaterialization.js";
import type { ClientToolName } from "./protocol.js";

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";

const allDesktopTools: ClientToolName[] = [
  "file_list",
  "file_search",
  "file_read",
  "file_write",
  "file_patch",
  "shell_exec",
  "git_diff"
];

test("Agent Corpus cannot remove File or Shell capabilities advertised by Desktop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-platform-local-tools-"));
  try {
    await mkdir(path.join(root, "instructions"), { recursive: true });
    await mkdir(path.join(root, "evals"), { recursive: true });
    const system = "Use the Creator's method.";
    const evaluations = "[]";
    await writeFile(path.join(root, "instructions/system.md"), system, "utf8");
    await writeFile(path.join(root, "evals/evals.json"), evaluations, "utf8");
    await writeFile(path.join(root, "agent.json"), JSON.stringify({
      contract_version: "1",
      creator: { id: CREATOR_ID, name: "Creator" },
      product: { id: PRODUCT_ID, name: "API Focused Agent" },
      instructions: { system: asset("instructions/system.md", system, "system") },
      skills: [],
      knowledge: { documents: [] },
      // This Corpus intentionally declares no local_harness entries. Creator
      // manifests describe Agent dependencies; they do not revoke the user's
      // Desktop Workspace capability.
      tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }],
      evaluations: {
        synthetic_qa: [asset("evals/evals.json", evaluations, "synthetic")],
        held_out: [asset("evals/evals.json", evaluations, "held-out")]
      }
    }), "utf8");

    const materialized = await materializeAgentCorpus(root, "List my workspace files", allDesktopTools);
    assert.deepEqual(materialized.localTools, allDesktopTools);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime never invents a local capability the Desktop did not advertise", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-platform-local-subset-"));
  try {
    await mkdir(path.join(root, "instructions"), { recursive: true });
    await mkdir(path.join(root, "evals"), { recursive: true });
    const system = "Use the Creator's method.";
    const evaluations = "[]";
    await writeFile(path.join(root, "instructions/system.md"), system, "utf8");
    await writeFile(path.join(root, "evals/evals.json"), evaluations, "utf8");
    await writeFile(path.join(root, "agent.json"), JSON.stringify({
      contract_version: "1",
      creator: { id: CREATOR_ID, name: "Creator" },
      product: { id: PRODUCT_ID, name: "Limited Client Agent" },
      instructions: { system: asset("instructions/system.md", system, "system") },
      skills: [],
      knowledge: { documents: [] },
      tools: [
        { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
        { id: "hatch.local.files", kind: "local_harness", capability: "filesystem" },
        { id: "hatch.local.shell", kind: "local_harness", capability: "shell" }
      ],
      evaluations: {
        synthetic_qa: [asset("evals/evals.json", evaluations, "synthetic")],
        held_out: [asset("evals/evals.json", evaluations, "held-out")]
      }
    }), "utf8");

    const materialized = await materializeAgentCorpus(root, "Read one file", ["file_read"]);
    assert.deepEqual(materialized.localTools, ["file_read"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function asset(assetPath: string, content: string, id: string): { id: string; path: string; sha256: string } {
  return {
    id,
    path: assetPath,
    sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`
  };
}
