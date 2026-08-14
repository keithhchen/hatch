#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function verifyDesktopVersion({ repositoryRoot, expectedTag = null }) {
  if (!repositoryRoot) throw new Error("repositoryRoot is required.");

  const desktopRoot = path.join(repositoryRoot, "desktop-app");
  const [packageJson, packageLock, tauriConfig, cargoToml, cargoLock, renderer] = await Promise.all([
    readJson(path.join(desktopRoot, "package.json")),
    readJson(path.join(desktopRoot, "package-lock.json")),
    readJson(path.join(desktopRoot, "src-tauri", "tauri.conf.json")),
    readFile(path.join(desktopRoot, "src-tauri", "Cargo.toml"), "utf8"),
    readFile(path.join(desktopRoot, "src-tauri", "Cargo.lock"), "utf8"),
    readFile(path.join(desktopRoot, "src", "renderer", "main.jsx"), "utf8")
  ]);

  const versions = new Map([
    ["desktop-app/package.json", packageJson.version],
    ["desktop-app/package-lock.json", packageLock.version],
    ["desktop-app/package-lock.json root package", packageLock.packages?.[""]?.version],
    ["desktop-app/src-tauri/tauri.conf.json", tauriConfig.version],
    ["desktop-app/src-tauri/Cargo.toml", packageVersion(cargoToml, "Cargo.toml")],
    ["desktop-app/src-tauri/Cargo.lock", lockedPackageVersion(cargoLock, "hatch-desktop-app")]
  ]);
  const distinctVersions = new Set(versions.values());
  if (distinctVersions.size !== 1) {
    throw new Error(`Desktop version sources disagree:\n${formatVersions(versions)}`);
  }

  const [version] = distinctVersions;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Desktop version ${JSON.stringify(version)} is not strict SemVer X.Y.Z.`);
  }
  if (!renderer.includes(`<div><dt>Version</dt><dd>${version}</dd></div>`)) {
    throw new Error(`Desktop About UI does not report version ${version}.`);
  }
  if (!renderer.includes(`client_version: "${version}"`)) {
    throw new Error(`Desktop Runtime hello does not report client_version ${version}.`);
  }
  if (expectedTag && expectedTag !== `v${version}`) {
    throw new Error(`Release tag ${expectedTag} does not match Desktop version v${version}.`);
  }

  return { version, tag: `v${version}`, sources: Object.fromEntries(versions) };
}

function packageVersion(contents, filename) {
  const packageStart = contents.indexOf("[package]");
  const afterPackage = packageStart >= 0 ? contents.slice(packageStart + "[package]".length) : "";
  const nextSection = afterPackage.search(/\r?\n^\[/m);
  const section = nextSection >= 0 ? afterPackage.slice(0, nextSection) : afterPackage;
  const version = section.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) throw new Error(`${filename} has no [package] version.`);
  return version;
}

function lockedPackageVersion(contents, packageName) {
  for (const section of contents.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = section.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (name !== packageName) continue;
    const version = section.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (!version) break;
    return version;
  }
  throw new Error(`Cargo.lock has no ${packageName} package version.`);
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function formatVersions(versions) {
  return [...versions].map(([source, version]) => `- ${source}: ${JSON.stringify(version)}`).join("\n");
}

function readArguments(argv) {
  let repositoryRoot = process.cwd();
  let expectedTag = process.env.GITHUB_REF?.startsWith("refs/tags/") ? process.env.GITHUB_REF_NAME : null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") repositoryRoot = argv[++index];
    else if (argument === "--tag") expectedTag = argv[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  return { repositoryRoot: path.resolve(repositoryRoot), expectedTag };
}

async function main() {
  const result = await verifyDesktopVersion(readArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
