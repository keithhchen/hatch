import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordDesktopUatArtifact } from "./record-desktop-uat-artifact.mjs";
import { verifyDesktopUatArtifact } from "./verify-desktop-uat-artifact.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-desktop-uat-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source", "nsis");
  const download = path.join(root, "download", "nested");
  const reportFile = path.join(root, "source", "windows.json");
  await mkdir(source, { recursive: true });
  await mkdir(download, { recursive: true });
  const artifactName = "Hatch_0.1.0_x64-setup.exe";
  const contents = Buffer.from("candidate bytes");
  await writeFile(path.join(source, artifactName), contents);
  const report = await recordDesktopUatArtifact({
    platform: "windows",
    artifactDirectory: path.join(root, "source"),
    outputFile: reportFile,
    environment: { HATCH_PERSISTENT_SESSION: "0", HATCH_GIT_SHA: "fixture-sha" }
  });
  await writeFile(path.join(download, artifactName), contents);
  const downloadedReport = path.join(root, "download", "windows.json");
  await writeFile(downloadedReport, await readFile(reportFile));
  return { root, download: path.join(root, "download"), downloadedReport, report, artifactName };
}

test("verifies the exact CI package after download changes its parent path", async (t) => {
  const candidate = await fixture(t);
  const result = await verifyDesktopUatArtifact({
    platform: "windows",
    reportFile: candidate.downloadedReport,
    artifactDirectory: candidate.download,
    expectedSha256: candidate.report.package.sha256,
    expectedSourceSha: "fixture-sha",
    expectedRunnerArchitecture: process.arch
  });

  assert.equal(result.verified, true);
  assert.equal(result.package.filename, candidate.artifactName);
  assert.equal(result.package.sha256, candidate.report.package.sha256);
});

test("rejects a downloaded package whose bytes changed after CI", async (t) => {
  const candidate = await fixture(t);
  await writeFile(path.join(candidate.download, "nested", candidate.artifactName), "tampered bytes!");

  await assert.rejects(
    verifyDesktopUatArtifact({
      platform: "windows",
      reportFile: candidate.downloadedReport,
      artifactDirectory: candidate.download
    }),
    /SHA-256 does not match/
  );
});

test("rejects an operator-provided SHA that differs from CI evidence", async (t) => {
  const candidate = await fixture(t);

  await assert.rejects(
    verifyDesktopUatArtifact({
      platform: "windows",
      reportFile: candidate.downloadedReport,
      artifactDirectory: candidate.download,
      expectedSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    }),
    /supplied expected SHA-256/
  );
});

test("rejects an operator-provided source SHA that differs from CI evidence", async (t) => {
  const candidate = await fixture(t);

  await assert.rejects(
    verifyDesktopUatArtifact({
      platform: "windows",
      reportFile: candidate.downloadedReport,
      artifactDirectory: candidate.download,
      expectedSourceSha: "not-the-candidate-source"
    }),
    /supplied expected source SHA/
  );
});

test("rejects a target runner with a different architecture", async (t) => {
  const candidate = await fixture(t);

  await assert.rejects(
    verifyDesktopUatArtifact({
      platform: "windows",
      reportFile: candidate.downloadedReport,
      artifactDirectory: candidate.download,
      expectedRunnerArchitecture: process.arch === "arm64" ? "x64" : "arm64"
    }),
    /runner architecture/
  );
});
