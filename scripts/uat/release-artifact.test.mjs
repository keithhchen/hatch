import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordDesktopReleaseArtifact } from "./record-desktop-release-artifact.mjs";
import { verifyDesktopReleaseArtifact } from "./verify-desktop-release-artifact.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const ENVIRONMENT = {
  HATCH_DISTRIBUTION_BUILD: "1",
  HATCH_PERSISTENT_SESSION: "1",
  HATCH_RELEASE_NOTARIZED: "1",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Hatch (TEAM123456)",
  HATCH_APPLE_TEAM_ID: "TEAM123456",
  HATCH_BUNDLE_IDENTIFIER: "dev.hatch.local",
  GITHUB_RUN_ID: "4242",
  GITHUB_WORKFLOW: "Hatch Desktop release",
  GITHUB_REF: "refs/tags/v1.2.3"
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-release-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = path.join(root, "bundle", "dmg");
  const output = path.join(root, "evidence", "release.json");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "Hatch_1.2.3_aarch64.dmg"), "release bytes");
  const report = await recordDesktopReleaseArtifact({
    artifactDirectory: path.join(root, "bundle"),
    outputFile: output,
    sourceSha: SOURCE_SHA,
    releaseTag: "v1.2.3",
    environment: ENVIRONMENT,
    now: new Date("2026-08-11T01:02:03.000Z")
  });
  return { root, artifacts, output, report };
}

test("records a signed/notarized release package identity", async (t) => {
  const candidate = await fixture(t);
  const diskReport = JSON.parse(await readFile(candidate.output, "utf8"));
  assert.deepEqual(diskReport, candidate.report);
  assert.equal(candidate.report.release.tag, "v1.2.3");
  assert.equal(candidate.report.package.release_eligible, true);
  assert.equal(candidate.report.security.notarized, true);
  assert.match(candidate.report.package.sha256, /^sha256:[a-f0-9]{64}$/);
});

test("verifies the exact downloaded release bytes and source/tag binding", async (t) => {
  const candidate = await fixture(t);
  const result = await verifyDesktopReleaseArtifact({
    reportFile: candidate.output,
    artifactDirectory: path.join(candidate.root, "bundle"),
    expectedSha256: candidate.report.package.sha256,
    expectedSourceSha: SOURCE_SHA,
    expectedReleaseTag: "v1.2.3"
  });
  assert.equal(result.verified, true);
  assert.equal(result.package.sha256, candidate.report.package.sha256);
});

test("rejects changed package bytes or a different source SHA", async (t) => {
  const candidate = await fixture(t);
  await writeFile(path.join(candidate.artifacts, "Hatch_1.2.3_aarch64.dmg"), "tampered bytes");
  await assert.rejects(
    verifyDesktopReleaseArtifact({ reportFile: candidate.output, artifactDirectory: path.join(candidate.root, "bundle") }),
    /byte length|SHA-256 does not match/
  );

  const fresh = await fixture(t);
  await assert.rejects(
    verifyDesktopReleaseArtifact({
      reportFile: fresh.output,
      artifactDirectory: path.join(fresh.root, "bundle"),
      expectedSourceSha: "fedcba9876543210fedcba9876543210fedcba98"
    }),
    /expected source SHA/
  );
});

test("refuses to record a release identity before notarization", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-release-unnotarized-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = path.join(root, "bundle");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "Hatch.dmg"), "unsigned");
  await assert.rejects(
    recordDesktopReleaseArtifact({
      artifactDirectory: artifacts,
      outputFile: path.join(root, "report.json"),
      sourceSha: SOURCE_SHA,
      releaseTag: "v1.2.3",
      environment: { ...ENVIRONMENT, HATCH_RELEASE_NOTARIZED: "0" }
    }),
    /only after notarization/
  );
});
