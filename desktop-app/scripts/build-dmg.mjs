#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const productName = String(config.productName ?? "Hatch");
const version = String(config.version ?? "0.0.0");
const architecture = process.arch === "arm64" ? "aarch64" : process.arch;
const appPath = path.join(root, "src-tauri/target/release/bundle/macos", `${productName}.app`);
const outputDirectory = path.join(root, "src-tauri/target/release/bundle/dmg");
const outputPath = path.join(outputDirectory, `${productName}_${version}_${architecture}.dmg`);
const staging = await mkdtemp(path.join(os.tmpdir(), "hatch-dmg-"));
const distributionBuild = process.env.HATCH_DISTRIBUTION_BUILD === "1";
const signingIdentity = String(process.env.APPLE_SIGNING_IDENTITY ?? "-").trim() || "-";
const runtimeUrl = String(
  process.env.VITE_HATCH_RUNTIME_URL
    ?? (distributionBuild ? "wss://hatch.tokenquadrant.cn/v1/runtime" : "")
).trim();

if (distributionBuild) {
  let parsed;
  try {
    parsed = new URL(runtimeUrl);
  } catch {
    throw new Error("Distribution Desktop builds require VITE_HATCH_RUNTIME_URL as an absolute wss:// Runtime URL.");
  }
  if (parsed.protocol !== "wss:" || !parsed.pathname.endsWith("/runtime")) {
    throw new Error("Distribution Desktop builds require VITE_HATCH_RUNTIME_URL to use wss:// and end in /runtime.");
  }
  if (signingIdentity === "-") {
    throw new Error("Distribution Desktop builds require APPLE_SIGNING_IDENTITY; ad-hoc signing is UAT-only for native workspace grants.");
  }
}

try {
  await execFileAsync(path.join(root, "node_modules/.bin/tauri"), ["build", "--bundles", "app"], {
    cwd: root,
    env: { ...process.env, CI: "true", ...(runtimeUrl ? { VITE_HATCH_RUNTIME_URL: runtimeUrl } : {}) },
    maxBuffer: 16 * 1024 * 1024
  });
  const nestedCode = await nestedCodeTargets(appPath);
  for (const target of nestedCode) await signCode(target, signingIdentity);
  await signCode(appPath, signingIdentity);
  for (const target of nestedCode) await verifyCode(target);
  await verifyCode(appPath);
  await cp(appPath, path.join(staging, `${productName}.app`), { recursive: true });
  await symlink("/Applications", path.join(staging, "Applications"));
  await mkdir(outputDirectory, { recursive: true });
  await unlink(outputPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await execFileAsync("hdiutil", [
    "create",
    "-volname", productName,
    "-srcfolder", staging,
    "-ov",
    "-format", "UDZO",
    "-imagekey", "zlib-level=9",
    outputPath
  ], { maxBuffer: 4 * 1024 * 1024 });
  await execFileAsync("hdiutil", ["verify", outputPath], { maxBuffer: 4 * 1024 * 1024 });
  const bytes = await readFile(outputPath);
  const fileStat = await stat(outputPath);
  process.stdout.write(`${JSON.stringify({
    kind: "hatch-installable-dmg",
    product_name: productName,
    version,
    architecture,
    path: outputPath,
    bytes: fileStat.size,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    verified: true,
    app_signature: signingIdentity === "-"
      ? "ad-hoc UAT signature, strict verification passed"
      : "Developer ID signature, strict verification passed",
    runtime_endpoint: distributionBuild ? runtimeUrl : "localhost development default or caller-supplied VITE_HATCH_RUNTIME_URL",
    note: distributionBuild
      ? "Distribution endpoint is embedded. This Developer ID-signed DMG must be notarized and stapled before publication."
      : "Ad-hoc UAT build; it must not be published. App Sandbox remains disabled until shell execution moves to a signed bookmark-resolving helper."
  }, null, 2)}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function nestedCodeTargets(bundlePath) {
  const roots = ["Contents/Frameworks", "Contents/PlugIns", "Contents/XPCServices", "Contents/Helpers"]
    .map((entry) => path.join(bundlePath, entry));
  const targets = [];
  for (const candidate of roots) await visit(candidate);
  return [...new Set(targets)].sort((left, right) => depth(right) - depth(left));

  async function visit(candidate) {
    let entries;
    try {
      entries = await readdir(candidate, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(candidate, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        if (/\.(?:app|appex|framework|xpc)$/i.test(entry.name)) targets.push(entryPath);
      } else if (entry.isFile()) {
        const metadata = await stat(entryPath);
        if (/\.dylib$/i.test(entry.name) || (metadata.mode & 0o111) !== 0) targets.push(entryPath);
      }
    }
  }
}

function depth(target) {
  return target.split(path.sep).length;
}

async function signCode(target, identity, entitlements) {
  const args = ["--force", "--sign", identity, "--options", "runtime", identity === "-" ? "--timestamp=none" : "--timestamp"];
  if (entitlements) args.push("--entitlements", entitlements);
  args.push(target);
  await execFileAsync("codesign", args, { maxBuffer: 4 * 1024 * 1024 });
}

async function verifyCode(target) {
  await execFileAsync("codesign", ["--verify", "--strict", target], { maxBuffer: 4 * 1024 * 1024 });
}
