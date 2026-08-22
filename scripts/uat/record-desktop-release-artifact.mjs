#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findDesktopArtifacts } from "./record-desktop-uat-artifact.mjs";

const RELEASE_SCHEMA_VERSION = 1;

/**
 * Record the immutable identity of a signed and notarized release package.
 *
 * This is intentionally a separate contract from the ad-hoc UAT report. A
 * release package may enable the signed macOS Keychain path, so accepting a
 * `release_eligible: false` UAT report here would make it possible to publish
 * a different byte stream from the one reviewed by the release gate.
 */
export async function recordDesktopReleaseArtifact({
  artifactDirectory,
  outputFile,
  sourceSha,
  releaseTag,
  environment = process.env,
  now = new Date()
}) {
  validateInputs({ artifactDirectory, outputFile, sourceSha, releaseTag, environment });

  const candidates = await findDesktopArtifacts(artifactDirectory, ".dmg");
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one .dmg release artifact below ${artifactDirectory}, found ${candidates.length}: ${candidates.join(", ")}`
    );
  }

  const artifactPath = candidates[0];
  const artifactStat = await stat(artifactPath);
  if (!artifactStat.isFile() || artifactStat.size === 0) {
    throw new Error(`Release artifact ${artifactPath} is not a non-empty file.`);
  }
  const artifactBytes = await readFile(artifactPath);
  const packageSha256 = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;

  const report = {
    schema_version: RELEASE_SCHEMA_VERSION,
    kind: "hatch-desktop-release-artifact",
    generated_at: now.toISOString(),
    source: {
      git_sha: sourceSha,
      github_run_id: environment.GITHUB_RUN_ID || null,
      github_workflow: environment.GITHUB_WORKFLOW || null
    },
    release: {
      tag: releaseTag,
      ref: environment.GITHUB_REF || `refs/tags/${releaseTag}`
    },
    package: {
      platform: "macos",
      architecture: environment.HATCH_PACKAGE_ARCHITECTURE || null,
      filename: path.basename(artifactPath),
      bytes: artifactStat.size,
      sha256: packageSha256,
      release_eligible: true
    },
    security: {
      distribution_build: true,
      persistent_session: "enabled",
      credential_storage: "macOS Keychain gated by Developer ID identity and Team ID",
      signed: true,
      notarized: true
    },
    provenance: {
      build_command: "npm run build:distribution",
      notarization: "notarytool accepted, stapler staple completed, stapler validate passed",
      signing_identity: environment.APPLE_SIGNING_IDENTITY || null,
      team_id: environment.HATCH_APPLE_TEAM_ID || null,
      bundle_identifier: environment.HATCH_BUNDLE_IDENTIFIER || null
    },
    acceptance: {
      source_sha_gate: "HATCH_SIGNED_WORKSPACE_SMOKE_SHA matched source.git_sha before build",
      target_device_gate: "required protected signed-package UAT must verify this exact package.sha256 before publication"
    }
  };

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function validateInputs({ artifactDirectory, outputFile, sourceSha, releaseTag, environment }) {
  if (!artifactDirectory || !outputFile) {
    throw new Error("artifactDirectory and outputFile are required.");
  }
  if (!/^[0-9a-f]{40}$/i.test(String(sourceSha ?? ""))) {
    throw new Error("sourceSha must be a full 40-character Git commit SHA.");
  }
  if (!/^v\d+\.\d+\.\d+$/.test(String(releaseTag ?? ""))) {
    throw new Error("releaseTag must be a semantic version tag such as v1.2.3.");
  }
  if (environment.HATCH_DISTRIBUTION_BUILD !== "1") {
    throw new Error("Release artifacts must set HATCH_DISTRIBUTION_BUILD=1.");
  }
  if (environment.HATCH_PERSISTENT_SESSION !== "1") {
    throw new Error("Release artifacts must set HATCH_PERSISTENT_SESSION=1.");
  }
  if (environment.HATCH_RELEASE_NOTARIZED !== "1") {
    throw new Error("Release artifact identity may be recorded only after notarization and stapler validation.");
  }
  if (!/^(aarch64|x86_64)$/.test(String(environment.HATCH_PACKAGE_ARCHITECTURE ?? ""))) {
    throw new Error("Release artifacts require HATCH_PACKAGE_ARCHITECTURE to be aarch64 or x86_64.");
  }
  if (!environment.APPLE_SIGNING_IDENTITY || environment.APPLE_SIGNING_IDENTITY === "-") {
    throw new Error("Release artifacts require a non-ad-hoc APPLE_SIGNING_IDENTITY.");
  }
  if (!/^[A-Z0-9]{10}$/.test(String(environment.HATCH_APPLE_TEAM_ID ?? ""))) {
    throw new Error("Release artifacts require the 10-character HATCH_APPLE_TEAM_ID.");
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
  const accepted = new Set(["artifact-dir", "output", "source-sha", "release-tag"]);
  for (const name of values.keys()) {
    if (!accepted.has(name)) throw new Error(`Unknown argument --${name}.`);
  }
  return {
    artifactDirectory: values.get("artifact-dir"),
    outputFile: values.get("output"),
    sourceSha: values.get("source-sha"),
    releaseTag: values.get("release-tag")
  };
}

async function main() {
  const report = await recordDesktopReleaseArtifact(readCliArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
