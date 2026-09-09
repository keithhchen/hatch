import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createWorkspacePathPolicy, executeChatTool, toolEventBase, type RunContext } from "./agentRuntime.js";
import { loadSkillByPath } from "./skills.js";
import type { ActivatedSkill } from "./store.js";
import type { RunStart } from "./protocol.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "hatch-skill-resources-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "documents");
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  const markdown = "---\nname: documents\ndescription: Edit documents\n---\n# Complete workflow\nRead all instructions.\n";
  await writeFile(path.join(directory, "SKILL.md"), markdown);
  await writeFile(path.join(directory, "scripts", "edit_docx.py"), "# actual bundled resource\n");
  const record = await loadSkillByPath(path.join(directory, "SKILL.md"), [directory]);
  const ctx = {
    sessionSkills: { records: [record], visibleRecords: [], rendered: { text: "", aliases: {} } },
    clientTools: [], messages: [],
    clientBroker: { execute() { throw new Error("Unexpected native fallback"); } },
    serverTools: { execute() { throw new Error("Unexpected generic server fallback"); } }
  } as unknown as RunContext;
  const input: RunStart = { type: "client.message", run_id: "first", conversation_id: "conversation", message: { role: "user", content: "edit" } };
  const call = (target: string, name = "file_read", active: ActivatedSkill[] = [], roots: string[] = []) =>
    executeChatTool(input, ctx, "resource", name, { path: target }, roots, active, ctx.sessionSkills.rendered.aliases, createWorkspacePathPolicy(""));
  return { root, directory, record, ctx, input, call };
}

test("session catalog authorizes next-turn Skill resources without activation, reloading or history injection", async (t) => {
  const { directory, ctx, input, call } = await fixture(t);
  const activations: ActivatedSkill[] = [];
  const loaded = await executeChatTool(input, ctx, "load", "Skill", { skill_name: "documents" }, [], [], {},
    createWorkspacePathPolicy(""), undefined, (skill) => activations.push(skill));
  assert.match(String(loaded.instructions), /Complete workflow[\s\S]*Read all instructions/);
  assert.equal(activations.length, 1);
  // The next turn has no activation state. Reading resources must not load SKILL.md again.
  input.run_id = "second";
  await rm(path.join(directory, "SKILL.md"));
  const target = "skill://documents/scripts/edit_docx.py";
  const event = toolEventBase(input, "resource", "file_read", { path: target }, [], [], {}, ctx);
  assert.equal(event.locality, "server");
  assert.equal((await call(target)).content, "# actual bundled resource\n");
  assert.equal((await call(path.join(directory, "scripts/edit_docx.py"))).content, "# actual bundled resource\n");
  const listing = await call("skill://documents/scripts", "file_list");
  assert.ok(Array.isArray(listing.entries) && listing.entries.length === 1);
  assert.equal(activations.length, 1);
  assert.deepEqual(ctx.messages, []);
  assert.equal(ctx.activatedSkills, undefined);
});

test("Skill resources reject traversal, escaping symlinks and direct or symlinked SKILL.md reads", async (t) => {
  const { root, directory, call } = await fixture(t);
  await writeFile(path.join(root, "secret.txt"), "not authorized");
  await symlink(path.join(root, "secret.txt"), path.join(directory, "scripts", "escape.py"));
  await symlink(path.join(directory, "SKILL.md"), path.join(directory, "scripts", "instructions.txt"));
  await symlink(root, path.join(directory, "scripts", "outside"));
  await writeFile(path.join(directory, "private-metadata.json"), "not a resource");
  await symlink(path.join(directory, "private-metadata.json"), path.join(directory, "scripts", "metadata.json"));
  for (const target of ["skill://documents/scripts/../SKILL.md", "skill://documents/scripts/../../secret.txt",
    "skill://documents/scripts/..\\..\\secret.txt", `${directory}/../secret.txt`]) {
    await assert.rejects(call(target), /Invalid Skill resource/);
  }
  await assert.rejects(call("skill://documents/scripts/escape.py"), /escapes skills root/);
  await assert.rejects(call("skill://documents/scripts/outside", "file_list"), /escapes skills root/);
  await assert.rejects(call(path.join(directory, "SKILL.md")), /Use Skill/);
  await assert.rejects(call("skill://documents/scripts/instructions.txt"), /Use Skill/);
  await assert.rejects(call("skill://documents/SKILL.md"), /Invalid Skill resource/);
  await assert.rejects(call(path.join(directory, "private-metadata.json")), /Invalid Skill resource/);
  await assert.rejects(call("skill://documents/private-metadata.json"), /Invalid Skill resource/);
  await assert.rejects(call("skill://documents/scripts/metadata.json"), /Invalid Skill resource/);
  await assert.rejects(call("skill:///scripts/edit_docx.py"), /Invalid Skill resource/);
});

test("stale activation and caller roots cannot grant resources absent from the enabled session catalog", async (t) => {
  const { directory, record, ctx, input, call } = await fixture(t);
  const stale = { ...record, content: "old instructions", resource_paths: ["scripts/edit_docx.py"],
    resource_manifest_truncated: false, activated_at: new Date().toISOString() } as ActivatedSkill;
  ctx.sessionSkills.records = [];
  assert.throws(() => toolEventBase(input, "no-context", "file_read", { path: "skill://documents/scripts/edit_docx.py" }, [directory], [stale], {}), /not authorized/);
  await assert.rejects(call("skill://documents/scripts/edit_docx.py", "file_read", [stale], [directory]), /not authorized/);
  await assert.rejects(call(path.join(directory, "scripts/edit_docx.py"), "file_read", [stale], [directory]), /not authorized/);
  ctx.sessionSkills.records = [{ ...record, enabled: false }];
  await assert.rejects(call("skill://documents/scripts/edit_docx.py"), /not authorized/);
  ctx.sessionSkills.records = [record, { ...record, id: "ambiguous" }];
  await assert.rejects(call("skill://documents/scripts/edit_docx.py"), /ambiguous/);
  await assert.rejects(call("skill://not-in-catalog/scripts/edit_docx.py"), /not authorized/);
});

test("bare relative resources always dispatch to Workspace with zero, one or multiple active Skills", async (t) => {
  const { root, directory, record, ctx, input, call } = await fixture(t);
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "references"), { recursive: true });
  await mkdir(path.join(directory, "references"));
  await writeFile(path.join(workspace, "references/guide.md"), "Workspace reference");
  await writeFile(path.join(directory, "references/guide.md"), "Skill reference");
  const active = { ...record, content: "loaded", resource_paths: ["references/guide.md"],
    resource_manifest_truncated: false, activated_at: new Date().toISOString() } as ActivatedSkill;
  const dispatched: string[] = [];
  ctx.clientTools = ["file_read", "file_list"];
  // A routing unit test: the broker boundary reads a real, distinct Workspace file.
  ctx.clientBroker.execute = async (_runId, tool, args) => {
    assert.equal(tool, "file_read");
    const target = String(args.path);
    dispatched.push(target);
    return { content: await readFile(path.join(workspace, target), "utf8") };
  };
  for (const skills of [[active], [active, { ...active, name: "another" }], []]) {
    input.run_id = `turn-${skills.length}`;
    assert.equal(toolEventBase(input, "read", "file_read", { path: "references/guide.md" }, [directory], skills, {}, ctx).locality, "client");
    assert.equal(toolEventBase(input, "list", "file_list", { path: "references" }, [directory], skills, {}, ctx).locality, "client");
    assert.equal((await call("references/guide.md", "file_read", skills, [directory])).content, "Workspace reference");
  }
  assert.deepEqual(dispatched, Array(3).fill("references/guide.md"));
  assert.equal((await call("skill://documents/references/guide.md")).content, "Skill reference");
});

test("explicit catalog aliases resolve resources without activation and reject traversal or unauthorized roots", async (t) => {
  const { root, directory, ctx, call } = await fixture(t);
  ctx.sessionSkills.rendered.aliases = { r0: directory, denied: root };
  assert.equal((await call("r0/scripts/edit_docx.py")).content, "# actual bundled resource\n");
  await assert.rejects(call("r0/scripts/../../secret.txt"), /Invalid Skill resource alias/);
  await assert.rejects(call("denied/secret.txt"), /not authorized/);
});
