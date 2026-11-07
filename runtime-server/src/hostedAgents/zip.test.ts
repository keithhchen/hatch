import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import { zipDirectory } from "./zip.js";

async function skillDir() {
  const dir = await mkdtemp(join(tmpdir(), "zip-test-"));
  await mkdir(join(dir, "scripts"));
  await writeFile(join(dir, "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
  await writeFile(join(dir, "scripts", "run.py"), "print(1)\n");
  await writeFile(join(dir, ".DS_Store"), "junk");
  return dir;
}

test("zipDirectory puts files at the root and leaves OS metadata out", async () => {
  const dir = await skillDir();
  try {
    assert.deepEqual(Object.keys(unzipSync(await zipDirectory(dir))).sort(), ["SKILL.md", "scripts/run.py"]);
  } finally { await rm(dir, { recursive: true }); }
});

test("zipDirectory is byte-identical for the same contents, even after the mtimes change", async () => {
  const dir = await skillDir();
  try {
    const first = await zipDirectory(dir);
    assert.ok(first.equals(await zipDirectory(dir)));
    const later = new Date(Date.now() + 86_400_000);
    await utimes(join(dir, "SKILL.md"), later, later);
    await utimes(join(dir, "scripts", "run.py"), later, later);
    assert.ok(first.equals(await zipDirectory(dir)));
    await writeFile(join(dir, "scripts", "run.py"), "print(2)\n");
    assert.ok(!first.equals(await zipDirectory(dir)));
  } finally { await rm(dir, { recursive: true }); }
});
