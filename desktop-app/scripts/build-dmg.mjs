#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink } from "node:fs/promises";
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
const runtimeUrl = String(process.env.VITE_HATCH_RUNTIME_URL ?? "").trim();

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
}

try {
  await execFileAsync(path.join(root, "node_modules/.bin/tauri"), ["build", "--bundles", "app"], {
    cwd: root,
    env: { ...process.env, CI: "true" },
    maxBuffer: 16 * 1024 * 1024
  });
  await execFileAsync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    maxBuffer: 4 * 1024 * 1024
  });
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", appPath], {
    maxBuffer: 4 * 1024 * 1024
  });
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
    app_signature: "bundle-level ad-hoc, strict verification passed",
    runtime_endpoint: distributionBuild ? runtimeUrl : "localhost development default or caller-supplied VITE_HATCH_RUNTIME_URL",
    note: distributionBuild
      ? "Distribution endpoint is embedded. Apple signing and notarization remain separate release operations."
      : "Unsigned development build; distribution signing, notarization, and an explicit cloud Runtime endpoint are separate release operations."
  }, null, 2)}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
