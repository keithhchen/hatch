#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SUPPORTED_PLATFORMS, findDesktopArtifacts } from "./record-desktop-uat-artifact.mjs";

/**
 * Verify a package downloaded from a CI run against the report uploaded with
 * it. The package may have a different parent path after download, so only
 * immutable package fields (name, bytes, and SHA-256) are trusted here.
 */
export async function verifyDesktopUatArtifact({
  platform,
  reportFile,
  artifactDirectory,
  expectedSha256 = null,
  expectedSourceSha = null,
  expectedRunnerArchitecture = null,
  requireBundledRuntime = false
}) {
  const extension = SUPPORTED_PLATFORMS.get(platform);
  if (!extension) throw new Error(`Unsupported platform ${JSON.stringify(platform)}; expected macos or windows.`);
  if (!reportFile || !artifactDirectory) throw new Error("reportFile and artifactDirectory are required.");

  let report;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch (error) {
    throw new Error(`Could not read desktop UAT report ${reportFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateReport(report, platform);
  if (requireBundledRuntime && (!report.runtime || report.runtime.verified !== true)) {
    throw new Error("The desktop UAT report does not include successful bundled Python/Node runtime verification.");
  }

  if (expectedSha256 && report.package.sha256 !== expectedSha256) {
    throw new Error("The supplied expected SHA-256 does not match the CI evidence report.");
  }
  if (expectedSourceSha && report.source?.git_sha !== expectedSourceSha) {
    throw new Error("The supplied expected source SHA does not match the CI evidence report.");
  }
  if (
    expectedRunnerArchitecture &&
    normalizeArchitecture(report.runner?.architecture) !== normalizeArchitecture(expectedRunnerArchitecture)
  ) {
    throw new Error("The target runner architecture does not match the CI package architecture.");
  }

  const candidates = (await findDesktopArtifacts(artifactDirectory, extension))
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
    throw new Error(`Downloaded package byte length does not match the CI evidence report for ${report.package.filename}.`);
  }
  if (sha256 !== report.package.sha256) {
    throw new Error(`Downloaded package SHA-256 does not match the CI evidence report for ${report.package.filename}.`);
  }

  return {
    schema_version: 1,
    kind: "hatch-desktop-automated-uat-verification",
    verified: true,
    source: report.source,
    package: {
      platform,
      filename: report.package.filename,
      bytes: artifactStat.size,
      sha256
    },
    ...(report.runtime ? { runtime: report.runtime } : {})
  };
}

function validateReport(report, platform) {
  if (report?.schema_version !== 1 || report.kind !== "hatch-desktop-automated-uat-artifact") {
    throw new Error("The downloaded evidence file is not a supported desktop UAT report.");
  }
  if (report.package?.platform !== platform) {
    throw new Error(`The downloaded evidence report is for ${JSON.stringify(report.package?.platform)}, not ${platform}.`);
  }
  if (
    !report.package?.uat_only ||
    report.package.release_eligible !== false ||
    report.security?.persistent_session !== "disabled"
  ) {
    throw new Error("The downloaded evidence report does not establish the required non-production session boundary.");
  }
  if (
    typeof report.package.filename !== "string" ||
    !Number.isSafeInteger(report.package.bytes) ||
    report.package.bytes <= 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(report.package.sha256 ?? "")
  ) {
    throw new Error("The downloaded evidence report has an invalid package identity.");
  }
}

function normalizeArchitecture(value) {
  return String(value ?? "").trim().toLowerCase();
}

function readCliArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${JSON.stringify(argument)}.`);
    const [name, inlineValue] = argument.slice(2).split("=", 2);
    if (name === "require-bundled-runtime" && inlineValue === undefined) {
      if (values.has(name)) throw new Error(`Expected one value for --${name}.`);
      values.set(name, "true");
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (!value || values.has(name)) throw new Error(`Expected one value for --${name}.`);
    values.set(name, value);
  }
  const accepted = new Set([
    "platform",
    "report",
    "artifact-dir",
    "expected-sha256",
    "expected-source-sha",
    "expected-runner-architecture",
    "require-bundled-runtime"
  ]);
  for (const name of values.keys()) {
    if (!accepted.has(name)) throw new Error(`Unknown argument --${name}.`);
  }
  return {
    platform: values.get("platform"),
    reportFile: values.get("report"),
    artifactDirectory: values.get("artifact-dir"),
    expectedSha256: values.get("expected-sha256") ?? null,
    expectedSourceSha: values.get("expected-source-sha") ?? null,
    expectedRunnerArchitecture: values.get("expected-runner-architecture") ?? null,
    requireBundledRuntime: values.has("require-bundled-runtime")
  };
}

async function main() {
  const verification = await verifyDesktopUatArtifact(readCliArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
