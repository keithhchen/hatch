#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findDesktopArtifacts } from "./record-desktop-uat-artifact.mjs";

/**
 * Verify the exact signed/notarized DMG downloaded by a protected target UAT
 * or publication job. The package hash is checked after artifact download;
 * source SHA and release tag are checked independently of the package path.
 */
export async function verifyDesktopReleaseArtifact({
  reportFile,
  artifactDirectory,
  expectedSha256 = null,
  expectedSourceSha = null,
  expectedReleaseTag = null,
  expectedRunId = null,
  expectedArchitecture = null
}) {
  if (!reportFile || !artifactDirectory) throw new Error("reportFile and artifactDirectory are required.");

  let report;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch (error) {
    throw new Error(`Could not read desktop release report ${reportFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateReport(report);

  if (expectedSha256 && report.package.sha256 !== expectedSha256) {
    throw new Error("The supplied expected release SHA-256 does not match the release evidence report.");
  }
  if (expectedSourceSha && report.source.git_sha !== expectedSourceSha) {
    throw new Error("The supplied expected source SHA does not match the release evidence report.");
  }
  if (expectedReleaseTag && report.release.tag !== expectedReleaseTag) {
    throw new Error("The supplied expected release tag does not match the release evidence report.");
  }
  if (expectedRunId && String(report.source.github_run_id ?? "") !== String(expectedRunId)) {
    throw new Error("The supplied expected workflow run ID does not match the release evidence report.");
  }
  if (expectedArchitecture && report.package.architecture !== expectedArchitecture) {
    throw new Error("The supplied expected package architecture does not match the release evidence report.");
  }

  const candidates = (await findDesktopArtifacts(artifactDirectory, ".dmg"))
    .filter((candidate) => path.basename(candidate) === report.package.filename);
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one downloaded ${report.package.filename} below ${artifactDirectory}, found ${candidates.length}.`
    );
  }

  const artifactPath = candidates[0];
  const bytes = await readFile(artifactPath);
  const artifactStat = await stat(artifactPath);
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (artifactStat.size !== report.package.bytes) {
    throw new Error(`Downloaded release package byte length does not match the release evidence report for ${report.package.filename}.`);
  }
  if (sha256 !== report.package.sha256) {
    throw new Error(`Downloaded release package SHA-256 does not match the release evidence report for ${report.package.filename}.`);
  }

  return {
    schema_version: 1,
    kind: "hatch-desktop-release-artifact-verification",
    verified: true,
    source: report.source,
    release: report.release,
    package: {
      platform: "macos",
      filename: report.package.filename,
      bytes: artifactStat.size,
      sha256
    },
    security: report.security
  };
}

function validateReport(report) {
  if (report?.schema_version !== 1 || report.kind !== "hatch-desktop-release-artifact") {
    throw new Error("The downloaded evidence file is not a supported desktop release report.");
  }
  if (!/^v\d+\.\d+\.\d+$/.test(String(report.release?.tag ?? ""))) {
    throw new Error("The release evidence report has an invalid release tag.");
  }
  if (!/^[0-9a-f]{40}$/i.test(String(report.source?.git_sha ?? ""))) {
    throw new Error("The release evidence report has an invalid source SHA.");
  }
  if (
    report.package?.platform !== "macos" ||
    report.package.release_eligible !== true ||
    report.security?.distribution_build !== true ||
    report.security?.persistent_session !== "enabled" ||
    report.security?.signed !== true ||
    report.security?.notarized !== true
  ) {
    throw new Error("The release evidence report does not establish a signed, notarized distribution package.");
  }
  if (
    !/^[A-Z0-9]{10}$/.test(String(report.provenance?.team_id ?? "")) ||
    typeof report.provenance?.bundle_identifier !== "string" ||
    report.provenance.bundle_identifier.length === 0 ||
    report.provenance.signing_identity === "-"
  ) {
    throw new Error("The release evidence report does not establish its Developer ID identity metadata.");
  }
  if (
    typeof report.package.filename !== "string" ||
    !report.package.filename.toLowerCase().endsWith(".dmg") ||
    !Number.isSafeInteger(report.package.bytes) ||
    report.package.bytes <= 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(report.package.sha256 ?? "")
  ) {
    throw new Error("The release evidence report has an invalid package identity.");
  }
}

function readCliArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${JSON.stringify(argument)}.`);
    const [name, inlineValue] = argument.slice(2).split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (!value || values.has(name)) throw new Error(`Expected one value for --${name}.`);
    values.set(name, value);
  }
  const accepted = new Set([
    "report",
    "artifact-dir",
    "expected-sha256",
    "expected-source-sha",
    "expected-release-tag",
    "expected-run-id",
    "expected-architecture"
  ]);
  for (const name of values.keys()) {
    if (!accepted.has(name)) throw new Error(`Unknown argument --${name}.`);
  }
  return {
    reportFile: values.get("report"),
    artifactDirectory: values.get("artifact-dir"),
    expectedSha256: values.get("expected-sha256") ?? null,
    expectedSourceSha: values.get("expected-source-sha") ?? null,
    expectedReleaseTag: values.get("expected-release-tag") ?? null,
    expectedRunId: values.get("expected-run-id") ?? null,
    expectedArchitecture: values.get("expected-architecture") ?? null
  };
}

async function main() {
  const verification = await verifyDesktopReleaseArtifact(readCliArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
