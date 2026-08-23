#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DESKTOP_DOWNLOAD_ARTIFACTS = Object.freeze([
  {
    key: "macos-apple-silicon",
    platform: "macos",
    label: "Mac · Apple Silicon preview",
    latestPath: "desktop/latest/mac/apple-silicon.dmg",
    expectedRunnerArchitecture: "ARM64",
    reportArgument: "apple-report",
    artifactArgument: "apple-artifact",
    fileName: (version) => `Hatch-${version}-macOS-Apple-Silicon.dmg`
  },
  {
    key: "macos-intel",
    platform: "macos",
    label: "Mac · Intel preview",
    latestPath: "desktop/latest/mac/intel.dmg",
    expectedRunnerArchitecture: "X64",
    reportArgument: "intel-report",
    artifactArgument: "intel-artifact",
    fileName: (version) => `Hatch-${version}-macOS-Intel.dmg`
  },
  {
    key: "windows",
    platform: "windows",
    label: "Windows · unsigned preview",
    latestPath: "desktop/latest/windows/windows.exe",
    expectedRunnerArchitecture: "X64",
    reportArgument: "windows-report",
    artifactArgument: "windows-artifact",
    fileName: (version) => `Hatch-${version}-Windows-x64-Setup.exe`
  }
]);

export function buildDesktopDownloadManifest({
  version,
  releaseTag,
    sourceSha,
    publicBaseUrl,
    artifacts,
    now = new Date()
}) {
  const normalizedVersion = normalizeVersion(version);
  const normalizedReleaseTag = normalizeReleaseTag(releaseTag, normalizedVersion);
  const normalizedSourceSha = normalizeSourceSha(sourceSha);
  const normalizedBaseUrl = normalizePublicBaseUrl(publicBaseUrl);
  if (!Array.isArray(artifacts) || artifacts.length !== DESKTOP_DOWNLOAD_ARTIFACTS.length) {
    throw new Error(`Expected ${DESKTOP_DOWNLOAD_ARTIFACTS.length} desktop download artifacts.`);
  }

  const artifactMap = new Map(artifacts.map((artifact) => [artifact.key, artifact]));
  if (artifactMap.size !== artifacts.length) throw new Error("Desktop download artifact keys must be unique.");
  const manifestArtifacts = {};
  for (const definition of DESKTOP_DOWNLOAD_ARTIFACTS) {
    const artifact = artifactMap.get(definition.key);
    if (!artifact) throw new Error(`Missing desktop download artifact ${definition.key}.`);
    validateArtifact(definition, artifact, normalizedSourceSha, normalizedVersion);
    const versionedPath = `desktop/releases/${normalizedReleaseTag}/${artifact.filename}`;
    manifestArtifacts[definition.key] = {
      label: definition.label,
      filename: artifact.filename,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      latest_url: joinPublicUrl(normalizedBaseUrl, definition.latestPath),
      release_url: joinPublicUrl(normalizedBaseUrl, versionedPath),
      latest_path: definition.latestPath,
      release_path: versionedPath
    };
  }

  return {
    schema_version: 1,
    kind: "hatch-desktop-download-manifest",
    product: "Hatch Desktop",
    channel: "stable",
    version: normalizedVersion,
    release_tag: normalizedReleaseTag,
    source_sha: normalizedSourceSha,
    published_at: new Date(now).toISOString(),
    manifest: {
      latest_url: joinPublicUrl(normalizedBaseUrl, "desktop/latest/manifest.json"),
      release_url: joinPublicUrl(normalizedBaseUrl, `desktop/releases/${normalizedReleaseTag}/manifest.json`)
    },
    artifacts: manifestArtifacts
  };
}

export async function createDesktopDownloadManifest({
  version,
  releaseTag,
  sourceSha,
  publicBaseUrl,
  artifactFiles,
  now = new Date()
}) {
  if (!Array.isArray(artifactFiles)) throw new Error("artifactFiles is required.");
  const artifacts = [];
  for (const definition of DESKTOP_DOWNLOAD_ARTIFACTS) {
    const input = artifactFiles.find((item) => item.key === definition.key);
    if (!input?.reportFile || !input?.artifactFile) {
      throw new Error(`Missing report or artifact file for ${definition.key}.`);
    }
    const report = await readJson(input.reportFile);
    const bytes = await readFile(input.artifactFile);
    const fileStat = await stat(input.artifactFile);
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    validateEvidence(definition, report, sha256, fileStat.size, sourceSha);
    artifacts.push({
      key: definition.key,
      filename: definition.fileName(normalizeVersion(version)),
      bytes: fileStat.size,
      sha256
    });
  }
  return buildDesktopDownloadManifest({ version, releaseTag, sourceSha, publicBaseUrl, artifacts, now });
}

function validateArtifact(definition, artifact, sourceSha, version) {
  if (artifact.key !== definition.key) throw new Error(`Artifact key mismatch for ${definition.key}.`);
  const expectedFilename = definition.fileName(version);
  if (artifact.filename !== expectedFilename) {
    throw new Error(`Invalid public desktop artifact filename ${JSON.stringify(artifact.filename)}; expected ${expectedFilename}.`);
  }
  if (definition.platform === "macos" && !artifact.filename.endsWith(".dmg")) {
    throw new Error(`macOS artifact ${definition.key} must be a DMG.`);
  }
  if (definition.platform === "windows" && !artifact.filename.endsWith(".exe")) {
    throw new Error("Windows artifact must be an EXE.");
  }
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
    throw new Error(`Invalid byte count for ${definition.key}.`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
    throw new Error(`Invalid SHA-256 for ${definition.key}.`);
  }
  if (artifact.source_sha !== undefined && artifact.source_sha !== sourceSha) {
    throw new Error(`Artifact ${definition.key} does not match the release source SHA.`);
  }
}

function validateEvidence(definition, report, sha256, bytes, sourceSha) {
  if (report?.schema_version !== 1 || report.kind !== "hatch-desktop-automated-uat-artifact") {
    throw new Error(`Unsupported UAT evidence for ${definition.key}.`);
  }
  if (report.package?.platform !== definition.platform) {
    throw new Error(`UAT evidence platform mismatch for ${definition.key}.`);
  }
  if (report.source?.git_sha !== sourceSha) {
    throw new Error(`UAT evidence source SHA mismatch for ${definition.key}.`);
  }
  if (normalizeArchitecture(report.runner?.architecture) !== normalizeArchitecture(definition.expectedRunnerArchitecture)) {
    throw new Error(`UAT runner architecture mismatch for ${definition.key}.`);
  }
  if (report.package?.bytes !== bytes || report.package?.sha256 !== sha256) {
    throw new Error(`Downloaded package bytes or SHA-256 do not match UAT evidence for ${definition.key}.`);
  }
}

function normalizeVersion(value) {
  const version = String(value ?? "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid desktop version ${JSON.stringify(value)}.`);
  return version;
}

function normalizeReleaseTag(value, version) {
  const tag = String(value ?? `v${version}`);
  if (tag !== `v${version}` || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Release tag ${JSON.stringify(value)} does not match version ${version}.`);
  }
  return tag;
}

function normalizeSourceSha(value) {
  const sourceSha = String(value ?? "");
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new Error("sourceSha must be a full Git commit SHA.");
  return sourceSha;
}

function normalizePublicBaseUrl(value) {
  const baseUrl = String(value ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(baseUrl)) throw new Error("publicBaseUrl must be an HTTPS URL.");
  return baseUrl;
}

function joinPublicUrl(baseUrl, objectPath) {
  return `${baseUrl}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizeArchitecture(value) {
  return String(value ?? "").trim().toUpperCase();
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read desktop evidence ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
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
    "version",
    "release-tag",
    "source-sha",
    "public-base-url",
    "apple-report",
    "apple-artifact",
    "intel-report",
    "intel-artifact",
    "windows-report",
    "windows-artifact",
    "output",
    "published-at"
  ]);
  for (const name of values.keys()) {
    if (!accepted.has(name)) throw new Error(`Unknown argument --${name}.`);
  }
  return {
    version: values.get("version"),
    releaseTag: values.get("release-tag"),
    sourceSha: values.get("source-sha"),
    publicBaseUrl: values.get("public-base-url"),
    now: values.get("published-at") ? new Date(values.get("published-at")) : new Date(),
    artifactFiles: DESKTOP_DOWNLOAD_ARTIFACTS.map((definition) => ({
      key: definition.key,
      reportFile: values.get(definition.reportArgument),
      artifactFile: values.get(definition.artifactArgument)
    })),
    outputFile: values.get("output")
  };
}

async function main() {
  const options = readCliArguments(process.argv.slice(2));
  if (!options.outputFile) throw new Error("Expected one value for --output.");
  const manifest = await createDesktopDownloadManifest(options);
  await mkdir(path.dirname(options.outputFile), { recursive: true });
  await writeFile(options.outputFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
