import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyDesktopVersion } from "./verify-desktop-version.mjs";

test("accepts a tag only when every Desktop version source agrees", async () => {
  const root = await fixture("1.2.3");
  const result = await verifyDesktopVersion({ repositoryRoot: root, expectedTag: "v1.2.3" });
  assert.equal(result.version, "1.2.3");
});

test("rejects a tag that does not match the packaged Desktop version", async () => {
  const root = await fixture("1.2.3");
  await assert.rejects(
    verifyDesktopVersion({ repositoryRoot: root, expectedTag: "v1.2.4" }),
    /does not match Desktop version/
  );
});

test("rejects version drift before native installers are built", async () => {
  const root = await fixture("1.2.3", { tauriVersion: "1.2.2" });
  await assert.rejects(verifyDesktopVersion({ repositoryRoot: root }), /version sources disagree/);
});

async function fixture(version, { tauriVersion = version } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-desktop-version-"));
  const desktopRoot = path.join(root, "desktop-app");
  await mkdir(path.join(desktopRoot, "src-tauri"), { recursive: true });
  await mkdir(path.join(desktopRoot, "src", "renderer"), { recursive: true });
  await writeFile(path.join(desktopRoot, "package.json"), JSON.stringify({ version }));
  await writeFile(path.join(desktopRoot, "package-lock.json"), JSON.stringify({ version, packages: { "": { version } } }));
  await writeFile(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: tauriVersion }));
  await writeFile(path.join(desktopRoot, "src-tauri", "Cargo.toml"), `[package]\nname = "hatch-desktop-app"\nversion = "${version}"\n`);
  await writeFile(path.join(desktopRoot, "src-tauri", "Cargo.lock"), `[[package]]\nname = "hatch-desktop-app"\nversion = "${version}"\n`);
  await writeFile(
    path.join(desktopRoot, "src", "renderer", "main.jsx"),
    `<div><dt>Version</dt><dd>${version}</dd></div>\nclient_version: "${version}"\n`
  );
  return root;
}
