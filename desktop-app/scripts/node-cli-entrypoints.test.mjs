import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, cp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { prepareNodeCliEntrypoints } from "./node-cli-entrypoints.mjs";

test("POSIX CLI launchers survive relocation and resource symlink dereferencing", { skip: process.platform === "win32" }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "hatch-cli-中文 "));
  try {
    const source = path.join(temporary, "source");
    await mkdir(path.join(source, "bin"), { recursive: true });
    await mkdir(path.join(source, "lib/node_modules/npm/bin"), { recursive: true });
    await symlink(process.execPath, path.join(source, "bin/node"));
    for (const name of ["npm", "npx"]) {
      await writeFile(path.join(source, `lib/node_modules/npm/bin/${name}-cli.js`), "console.log(JSON.stringify(process.argv.slice(2)))");
      await symlink(`../lib/node_modules/npm/bin/${name}-cli.js`, path.join(source, "bin", name));
    }
    await prepareNodeCliEntrypoints(source, "darwin");
    const relocated = path.join(temporary, "relocated app");
    await cp(source, relocated, { recursive: true, dereference: true });
    await rm(source, { recursive: true });
    for (const name of ["npm", "npx"]) {
      const output = execFileSync(path.join(relocated, "bin", name), ["中文 argument", "--version"], { encoding: "utf8", env: { PATH: "/nonexistent" } });
      assert.deepEqual(JSON.parse(output), ["中文 argument", "--version"]);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
