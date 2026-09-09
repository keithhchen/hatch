import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, lstat, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listSkillResourceDirectory } from "./skills.js";

test("Skill directory listing reports links themselves without inspecting external targets", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "hatch-skill-listing-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, "bundle");
  await mkdir(bundle);
  const outside = path.join(root, "outside.txt");
  await writeFile(outside, "private target metadata".repeat(100));
  const link = path.join(bundle, "external");
  const broken = path.join(bundle, "broken");
  await symlink(outside, link);
  await symlink(path.join(root, "absent"), broken);
  const result = await listSkillResourceDirectory(bundle, [bundle]);
  const entries = result.entries as Array<{ path: string; kind: string; len: number }>;
  assert.equal(entries.length, 2);
  for (const filename of [link, broken]) {
    assert.deepEqual(entries.find((entry) => entry.path === filename), {
      path: filename, kind: "other", len: (await lstat(filename)).size
    });
  }
});
