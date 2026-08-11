import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { recordDesktopUatArtifact } from "./record-desktop-uat-artifact.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./record-desktop-uat-artifact.mjs", import.meta.url));

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "hatch-desktop-uat-"));
}

test("records one macOS UAT package with a reproducible digest", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = path.join(root, "bundle", "dmg");
  const output = path.join(root, "evidence", "macos.json");
  await mkdir(artifacts, { recursive: true });
  const bytes = Buffer.from("ad-hoc dmg fixture");
  await writeFile(path.join(artifacts, "Hatch_0.1.0_arm64.dmg"), bytes);

  const report = await recordDesktopUatArtifact({
    platform: "macos",
    artifactDirectory: path.join(root, "bundle"),
    outputFile: output,
    environment: {
      HATCH_PERSISTENT_SESSION: "0",
      GITHUB_SHA: "abc123",
      GITHUB_RUN_ID: "42",
      GITHUB_WORKFLOW: "Hatch CI",
      RUNNER_OS: "macOS",
      RUNNER_ARCH: "ARM64"
    },
    now: new Date("2026-08-11T01:02:03.000Z")
  });

  assert.equal(report.package.platform, "macos");
  assert.equal(report.package.filename, "Hatch_0.1.0_arm64.dmg");
  assert.equal(report.package.bytes, bytes.length);
  assert.equal(
    report.package.sha256,
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  );
  assert.equal(report.source.git_sha, "abc123");
  assert.equal(report.security.persistent_session, "disabled");
  assert.equal(report.package.release_eligible, false);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), report);
});

test("rejects a persistent-session UAT build before it writes evidence", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = path.join(root, "bundle");
  const output = path.join(root, "windows.json");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "Hatch.exe"), "fixture");

  await assert.rejects(
    recordDesktopUatArtifact({
      platform: "windows",
      artifactDirectory: artifacts,
      outputFile: output,
      environment: { HATCH_PERSISTENT_SESSION: "1" }
    }),
    /HATCH_PERSISTENT_SESSION=0/
  );
});

test("rejects ambiguous package output instead of publishing a misleading hash", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = path.join(root, "bundle");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "Hatch-one.exe"), "one");
  await writeFile(path.join(artifacts, "Hatch-two.exe"), "two");

  await assert.rejects(
    recordDesktopUatArtifact({
      platform: "windows",
      artifactDirectory: artifacts,
      outputFile: path.join(root, "windows.json"),
      environment: { HATCH_PERSISTENT_SESSION: "0" }
    }),
    /Expected exactly one \.exe artifact/
  );
});

test("CLI writes the same Windows evidence shape used by the workflow", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = path.join(root, "bundle", "nsis");
  const output = path.join(root, "evidence", "windows.json");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "Hatch_0.1.0_x64-setup.exe"), "fixture");

  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath,
    "--platform", "windows",
    "--artifact-dir", artifacts,
    "--output", output
  ], {
    env: {
      HATCH_PERSISTENT_SESSION: "0",
      HATCH_GIT_SHA: "cli-fixture"
    }
  });

  const stdoutReport = JSON.parse(stdout);
  const diskReport = JSON.parse(await readFile(output, "utf8"));
  assert.equal(stdoutReport.package.platform, "windows");
  assert.equal(stdoutReport.source.git_sha, "cli-fixture");
  assert.deepEqual(diskReport, stdoutReport);
});
