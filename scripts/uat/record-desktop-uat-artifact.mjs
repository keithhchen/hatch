#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_PLATFORMS = new Map([
  ["macos", ".dmg"],
  ["windows", ".exe"]
]);

/**
 * Produce a small, portable evidence record alongside a non-production desktop
 * package. It deliberately records only what CI can establish: the exact
 * package bytes, runner metadata, and the fail-closed session configuration.
 * It is not a substitute for installing or interacting with that package on
 * a target device.
 */
export async function recordDesktopUatArtifact({
  platform,
  artifactDirectory,
  outputFile,
  runtimeReportFile = null,
  environment = process.env,
  now = new Date()
}) {
  const expectedExtension = SUPPORTED_PLATFORMS.get(platform);
  if (!expectedExtension) {
    throw new Error(`Unsupported platform ${JSON.stringify(platform)}; expected macos or windows.`);
  }
  if (!artifactDirectory || !outputFile) {
    throw new Error("artifactDirectory and outputFile are required.");
  }
  if (environment.HATCH_PERSISTENT_SESSION !== "0") {
    throw new Error(
      "Automated UAT packages must set HATCH_PERSISTENT_SESSION=0; CI must not exercise persistent credential storage."
    );
  }

  const candidates = await findDesktopArtifacts(artifactDirectory, expectedExtension);
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one ${expectedExtension} artifact below ${artifactDirectory}, found ${candidates.length}: ${candidates.join(", ")}`
    );
  }

  const artifactPath = candidates[0];
  const artifactBytes = await readFile(artifactPath);
  const artifactStat = await stat(artifactPath);
  if (!artifactStat.isFile() || artifactStat.size === 0) {
    throw new Error(`Desktop artifact ${artifactPath} is not a non-empty file.`);
  }

  const runtime = runtimeReportFile
    ? await readBundledRuntimeReport(runtimeReportFile)
    : undefined;

  const report = {
    schema_version: 1,
    kind: "hatch-desktop-automated-uat-artifact",
    generated_at: now.toISOString(),
    source: {
      git_sha: environment.GITHUB_SHA || environment.HATCH_GIT_SHA || "local-uncommitted",
      github_run_id: environment.GITHUB_RUN_ID || null,
      github_workflow: environment.GITHUB_WORKFLOW || null
    },
    runner: {
      platform: environment.RUNNER_OS || process.platform,
      architecture: environment.RUNNER_ARCH || process.arch,
      os_release: environment.RUNNER_OS ? null : process.release.name
    },
    package: {
      platform,
      path: path.resolve(artifactPath),
      filename: path.basename(artifactPath),
      bytes: artifactStat.size,
      sha256: `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`,
      uat_only: true,
      release_eligible: false
    },
    ...(runtime ? { runtime } : {}),
    security: {
      persistent_session: "disabled",
      credential_storage: "process memory only",
      publication: "not a signed or notarized release artifact"
    },
    automated_evidence: [
      "The CI runner built exactly the package hashed above.",
      "The package job ran with HATCH_PERSISTENT_SESSION=0."
    ],
    not_proven_by_ci: [
      "Installation, launch, and system integration on a real target device.",
      "VoiceOver or Narrator, IME, drag-and-drop, fullscreen, Snap, and multi-display DPI behavior.",
      "Signed-package credential persistence, notarization, or release readiness."
    ]
  };

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

export async function findDesktopArtifacts(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findDesktopArtifacts(candidate, extension));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
      results.push(candidate);
    }
  }
  return results.sort();
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
  const accepted = new Set(["platform", "artifact-dir", "output", "runtime-report"]);
  for (const name of values.keys()) {
    if (!accepted.has(name)) throw new Error(`Unknown argument --${name}.`);
  }
  return {
    platform: values.get("platform"),
    artifactDirectory: values.get("artifact-dir"),
    outputFile: values.get("output"),
    runtimeReportFile: values.get("runtime-report") ?? null
  };
}

async function readBundledRuntimeReport(file) {
  let report;
  try {
    report = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read bundled runtime verification ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (report?.schema_version !== 1 || report.kind !== "hatch-desktop-bundled-runtime-verification" || report.verified !== true) {
    throw new Error(`Bundled runtime verification ${file} is not a successful runtime report.`);
  }
  return {
    schema_version: report.schema_version,
    kind: report.kind,
    verified: report.verified,
    target: report.target,
    expected_target: report.expected_target,
    node: report.node,
    python: report.python,
    native: report.native,
    skills: report.skills
  };
}

async function main() {
  const options = readCliArguments(process.argv.slice(2));
  const report = await recordDesktopUatArtifact(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
