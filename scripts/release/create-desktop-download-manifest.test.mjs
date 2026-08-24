import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDesktopDownloadManifest } from "./create-desktop-download-manifest.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

test("creates versioned and fixed latest URLs for both macOS builds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-download-manifest-"));
  const files = [
    { key: "macos-apple-silicon", platform: "macos", architecture: "ARM64", filename: "Hatch_0.1.17_arm64.dmg", bytes: "apple" },
    { key: "macos-intel", platform: "macos", architecture: "X64", filename: "Hatch_0.1.17_x86_64.dmg", bytes: "intel" }
  ];
  const artifactFiles = [];
  for (const file of files) {
    const directory = path.join(root, file.key);
    await mkdir(directory, { recursive: true });
    const artifactFile = path.join(directory, file.filename);
    const content = Buffer.from(file.bytes);
    await writeFile(artifactFile, content);
    artifactFiles.push({
      key: file.key,
      artifactFile,
      reportFile: await writeEvidence(directory, file, content)
    });
  }

  const manifest = await createDesktopDownloadManifest({
    version: "0.1.17",
    releaseTag: "v0.1.17",
    sourceSha: SOURCE_SHA,
    publicBaseUrl: "https://hatch-downloads.oss-cn-shanghai.aliyuncs.com",
    artifactFiles,
    now: "2026-08-23T00:00:00.000Z"
  });

  assert.equal(manifest.version, "0.1.17");
  assert.equal(manifest.release_tag, "v0.1.17");
  assert.equal(manifest.published_at, "2026-08-23T00:00:00.000Z");
  assert.equal(
    manifest.artifacts["macos-apple-silicon"].latest_url,
    "https://hatch-downloads.oss-cn-shanghai.aliyuncs.com/desktop/latest/mac/apple-silicon.dmg"
  );
  assert.equal(manifest.artifacts["macos-intel"].filename, "Hatch-0.1.17-macOS-Intel.dmg");
  assert.equal(manifest.artifacts["macos-apple-silicon"].label, "Mac · Apple Silicon preview");
});

async function writeEvidence(directory, file, content) {
  const reportFile = path.join(directory, `${file.key}.json`);
  const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  await writeFile(reportFile, `${JSON.stringify({
    schema_version: 1,
    kind: "hatch-desktop-automated-uat-artifact",
    source: { git_sha: SOURCE_SHA },
    runner: { architecture: file.architecture },
    package: {
      platform: file.platform,
      filename: file.filename,
      bytes: content.length,
      sha256
    }
  })}\n`);
  return reportFile;
}
