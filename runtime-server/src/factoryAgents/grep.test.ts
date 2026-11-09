import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryAgentDefinitionRepository, initialAgentDefinitions } from "./definitions.js";
import { WorkbenchStore } from "./store.js";
import { fileTools } from "./tools.js";

// Real store and real tool; no model involved.
test("grep finds matching lines in the files list shows, scoped by directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-grep-"));
  try {
    const store = new WorkbenchStore(root, { creatorId: "c1", productId: "p1" }, new MemoryAgentDefinitionRepository(await initialAgentDefinitions()));
    const session = await store.create("research");
    await store.put(session.id, "output/profile.md", Buffer.from("# Alice\nFounded Acme in 2014.\nLikes tea.\nacme again"), { actor: "agent" });
    await store.put(session.id, "output/notes.md", Buffer.from("Nothing here.\nAcme pivot"), { actor: "agent" });
    const grep = fileTools(store, session.id).find(tool => tool.name === "grep")!;
    const run = async (args: object) => JSON.parse((await grep.execute("call", args as never) as { content: Array<{ text: string }> }).content[0]!.text) as { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean };
    assert.deepEqual((await run({ pattern: "Acme" })).matches.map(m => [m.path, m.line]).sort(), [["output/notes.md", 2], ["output/profile.md", 2]]);
    assert.equal((await run({ pattern: "acme", ignore_case: true })).matches.length, 3);
    assert.deepEqual((await run({ pattern: "Acme", directory: "output/notes.md" })).matches, [], "a directory means a directory");
    assert.equal((await run({ pattern: "Acme", limit: 1 })).truncated, true);
    await assert.rejects(grep.execute("call", { pattern: "(" } as never), /Invalid regular expression/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
