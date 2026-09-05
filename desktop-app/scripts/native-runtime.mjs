import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Prepare the native document engines used by the four document Skills.
 *
 * micromamba is deliberately a build-time-only dependency. It resolves and
 * copies a pinned conda-forge Poppler environment into the staged runtime;
 * the final Hatch bundle contains Poppler itself, not the package manager.
 */
export async function prepareNativeRuntime({ stagingRoot, cacheRoot, target }) {
  if (!target?.native?.libreoffice || !target?.native?.poppler || !target?.native?.micromamba) {
    throw new Error(`Native runtime metadata is incomplete for ${target?.key ?? "unknown target"}.`);
  }

  const nativeRoot = path.join(stagingRoot, "native");
  const nativeCacheRoot = path.join(cacheRoot, "native", target.key);
  const nativeBin = path.join(nativeRoot, "bin");
  const libreOfficeRoot = path.join(nativeRoot, "libreoffice");
  const popplerRoot = path.join(nativeRoot, "poppler");
  await mkdir(nativeBin, { recursive: true });
  if (target.platform === "win32") {
    // Windows uses the native engine locations directly, so this directory
    // would otherwise be empty and Tauri would omit it from the resource
    // bundle even though it is part of the manifest contract.
    await writeFile(path.join(nativeBin, "hatch-native-bin.txt"), "Bundled native runtime directory.\n", "utf8");
  }

  const micromambaPath = path.join(nativeCacheRoot, target.native.micromamba.archive);
  const libreOfficeArchivePath = path.join(nativeCacheRoot, target.native.libreoffice.archive);
  await downloadAndVerify(
    target.native.micromamba.url,
    target.native.micromamba.sha256,
    micromambaPath
  );
  await downloadAndVerify(
    target.native.libreoffice.url,
    target.native.libreoffice.sha256,
    libreOfficeArchivePath
  );
  if (target.platform !== "win32") await chmod(micromambaPath, 0o755);

  const libreOfficeInstall = await installLibreOffice({
    archivePath: libreOfficeArchivePath,
    destination: libreOfficeRoot,
    target
  });
  const libreOfficeExecutable = libreOfficeInstall.executable;
  const popplerExecutablePaths = await installPoppler({
    micromambaPath,
    cacheRoot: nativeCacheRoot,
    destination: popplerRoot,
    target
  });

  let binaries;
  if (target.platform === "darwin") {
    binaries = {
      soffice: path.join(nativeBin, "soffice"),
      pdftoppm: path.join(nativeBin, "pdftoppm"),
      pdfinfo: path.join(nativeBin, "pdfinfo")
    };
    await writeMacWrappers({ nativeRoot, binaries, libreOfficeExecutable, popplerExecutablePaths });
  } else {
    binaries = {
      soffice: libreOfficeExecutable,
      pdftoppm: popplerExecutablePaths.pdftoppm,
      pdfinfo: popplerExecutablePaths.pdfinfo
    };
  }

  for (const [name, executable] of Object.entries(binaries)) {
    await assertFile(executable, `bundled native ${name}`);
  }

  const pathEntries = uniqueExistingDirectories([
    nativeBin,
    path.dirname(libreOfficeExecutable),
    path.dirname(popplerExecutablePaths.pdftoppm),
    path.dirname(popplerExecutablePaths.pdfinfo),
    path.join(popplerRoot, "bin"),
    path.join(popplerRoot, "Library", "bin")
  ]);
  const popplerPackages = await readPopplerPackages(popplerRoot);
  await writeThirdPartyNotices(nativeRoot, target, popplerPackages);

  return {
    root: nativeRoot,
    binDirectory: nativeBin,
    binaries,
    pathEntries,
    popplerPackages,
    libreOfficeTrimmed: libreOfficeInstall.trimmed
  };
}

async function installLibreOffice({ archivePath, destination, target }) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  if (target.native.libreoffice.format === "dmg") {
    const mountPoint = await mkdtemp(path.join(os.tmpdir(), "hatch-libreoffice-mount-"));
    let attached = false;
    try {
      await run("hdiutil", ["attach", archivePath, "-nobrowse", "-readonly", "-mountpoint", mountPoint], {
        maxBuffer: 8 * 1024 * 1024
      });
      attached = true;
      const app = await locateDirectory(mountPoint, (entry) => entry.name.endsWith(".app"));
      if (!app) throw new Error(`LibreOffice DMG ${path.basename(archivePath)} did not contain an application bundle.`);
      const copiedApp = path.join(destination, path.basename(app));
      await run("/usr/bin/ditto", [app, copiedApp], { maxBuffer: 8 * 1024 * 1024 });
      const executable = path.join(copiedApp, "Contents", "MacOS", "soffice");
      await assertFile(executable, "LibreOffice soffice executable");
      await chmod(executable, 0o755);
      const trimmed = await trimLibreOfficeForHeadless({ destination, executable, target });
      return { executable, trimmed };
    } finally {
      if (attached) {
        await run("hdiutil", ["detach", mountPoint, "-force"], { maxBuffer: 8 * 1024 * 1024 }).catch(() => {});
      }
      await rm(mountPoint, { recursive: true, force: true });
    }
  }

  if (target.native.libreoffice.format !== "msi") {
    throw new Error(`Unsupported LibreOffice archive format: ${target.native.libreoffice.format}`);
  }
  const msiexec = process.env.MSIEXEC_EXE?.trim() || "msiexec.exe";
  await run(msiexec, [
    "/a",
    archivePath,
    "/qn",
    "/norestart",
    `TARGETDIR=${destination}`
  ], { maxBuffer: 16 * 1024 * 1024 });
  // LibreOffice ships both a GUI-subsystem `soffice.exe` and a console
  // launcher, `soffice.com`, on Windows.  The latter is the supported entry
  // point for headless Skill work: it keeps stdout/stderr attached and exits
  // when the child `soffice.bin` finishes instead of leaving the Node/Python
  // parent waiting on a GUI process handle.
  const executable = await locateFile(destination, "soffice.com");
  if (!executable) throw new Error(`LibreOffice MSI ${path.basename(archivePath)} did not contain the required soffice.com console launcher.`);
  const trimmed = await trimLibreOfficeForHeadless({ destination, executable, target });
  return { executable, trimmed };
}

const HEADLESS_UNUSED_LIBREOFFICE_DIRECTORIES = [
  "help",
  "gallery",
  "wizards",
  "template",
  "java",
  "extensions"
];

/**
 * Keep the LibreOffice engine, filters, fonts, registry, and configuration,
 * while dropping content that is only used by the interactive desktop UI.
 * The full upstream installer is still the source of truth; this pruning is
 * applied only to the generated application staging directory. It keeps the
 * bundled headless runtime below Windows NSIS's large-data-block limit.
 */
async function trimLibreOfficeForHeadless({ destination, executable, target }) {
  const roots = target.platform === "darwin"
    ? [path.join(path.dirname(path.dirname(executable)), "Resources")]
    : [
        destination,
        path.dirname(path.dirname(executable)),
        path.join(destination, "share"),
        path.join(path.dirname(path.dirname(executable)), "share")
      ];
  const seen = new Set();
  const trimmed = [];
  for (const root of roots) {
    const normalizedRoot = path.normalize(root);
    if (seen.has(normalizedRoot)) continue;
    seen.add(normalizedRoot);
    for (const directory of HEADLESS_UNUSED_LIBREOFFICE_DIRECTORIES) {
      const candidate = path.join(root, directory);
      const metadata = await stat(candidate).catch(() => undefined);
      if (!metadata?.isDirectory()) continue;
      await rm(candidate, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      trimmed.push(path.relative(destination, candidate).split(path.sep).join("/"));
    }
  }
  return trimmed;
}

async function installPoppler({ micromambaPath, cacheRoot, destination, target }) {
  const cachedEnvironment = path.join(cacheRoot, "poppler-environment");
  const cachedExecutables = await locatePopplerExecutables(cachedEnvironment, target.platform);
  if (!cachedExecutables) {
    await rm(cachedEnvironment, { recursive: true, force: true });
    const mambaRoot = path.join(cacheRoot, "micromamba-root");
    await mkdir(mambaRoot, { recursive: true });
    await run(micromambaPath, [
      "create",
      "--yes",
      "--no-rc",
      "--root-prefix",
      mambaRoot,
      "--prefix",
      cachedEnvironment,
      "--platform",
      target.native.poppler.platform,
      "--channel",
      target.native.poppler.channel,
      "--strict-channel-priority",
      "--always-copy",
      target.native.poppler.packageSpec
    ], {
      env: {
        ...process.env,
        MAMBA_NO_BANNER: "1",
        MAMBA_ROOT_PREFIX: mambaRoot
      },
      maxBuffer: 32 * 1024 * 1024
    });
  }

  const executables = await locatePopplerExecutables(cachedEnvironment, target.platform);
  if (!executables) {
    throw new Error(`Poppler ${target.native.poppler.packageSpec} did not produce pdftoppm and pdfinfo.`);
  }
  await rm(destination, { recursive: true, force: true });
  await cp(cachedEnvironment, destination, { recursive: true, force: true });
  const installed = await locatePopplerExecutables(destination, target.platform);
  if (!installed) throw new Error("The staged Poppler environment is incomplete after copying.");
  return installed;
}

async function writeMacWrappers({ nativeRoot, binaries, libreOfficeExecutable, popplerExecutablePaths }) {
  const wrapperDirectory = path.dirname(binaries.soffice);
  await mkdir(wrapperDirectory, { recursive: true });
  const relativeLibreOfficeExecutable = path.relative(wrapperDirectory, libreOfficeExecutable).split(path.sep).join("/");
  const relativePdftoppm = path.relative(wrapperDirectory, popplerExecutablePaths.pdftoppm).split(path.sep).join("/");
  const relativePdfinfo = path.relative(wrapperDirectory, popplerExecutablePaths.pdfinfo).split(path.sep).join("/");
  const sofficeWrapper = `#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOFFICE="$SCRIPT_DIR/${relativeLibreOfficeExecutable}"
if [ ! -x "$SOFFICE" ]; then
  echo "bundled LibreOffice is missing or not executable: $SOFFICE" >&2
  exit 127
fi
has_profile=0
for argument in "$@"; do
  case "$argument" in
    -env:UserInstallation=*) has_profile=1 ;;
  esac
done
if [ "$has_profile" -eq 0 ]; then
  profile="$(mktemp -d "\${TMPDIR:-/tmp}/hatch-soffice-profile.XXXXXX")"
  cleanup() { rm -rf "$profile"; }
  trap cleanup EXIT HUP INT TERM
  exec "$SOFFICE" "-env:UserInstallation=file://$profile" "$@"
fi
exec "$SOFFICE" "$@"
`;
  await writeFile(binaries.soffice, sofficeWrapper, { mode: 0o755 });
  await chmod(binaries.soffice, 0o755);

  const popplerWrappers = {
    pdftoppm: `#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$SCRIPT_DIR/${relativePdftoppm}" "$@"
`,
    pdfinfo: `#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$SCRIPT_DIR/${relativePdfinfo}" "$@"
`
  };
  for (const name of ["pdftoppm", "pdfinfo"]) {
    await writeFile(binaries[name], popplerWrappers[name], { mode: 0o755 });
    await chmod(binaries[name], 0o755);
  }
  await assertDirectory(nativeRoot, "native runtime root");
}

async function locatePopplerExecutables(root, platform) {
  const suffix = platform === "win32" ? ".exe" : "";
  const pdftoppm = await locateFile(root, `pdftoppm${suffix}`);
  const pdfinfo = await locateFile(root, `pdfinfo${suffix}`);
  if (!pdftoppm || !pdfinfo) return undefined;
  return { pdftoppm, pdfinfo };
}

async function readPopplerPackages(root) {
  const metadataRoot = path.join(root, "conda-meta");
  const entries = await readdir(metadataRoot, { withFileTypes: true }).catch(() => []);
  const packages = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json"))) {
    try {
      const metadata = JSON.parse(await readFile(path.join(metadataRoot, entry.name), "utf8"));
      const packageInfo = {
        name: metadata.name,
        version: metadata.version,
        build: metadata.build,
        build_number: metadata.build_number,
        channel: metadata.channel,
        subdir: metadata.subdir,
        license: metadata.license,
        license_family: metadata.license_family
      };
      packages.push(Object.fromEntries(Object.entries(packageInfo).filter(([, value]) => value !== undefined && value !== null)));
    } catch (error) {
      throw new Error(`Could not read Poppler package metadata ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return packages.sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

async function writeThirdPartyNotices(nativeRoot, target, popplerPackages) {
  const libreOffice = target.native.libreoffice;
  const poppler = target.native.poppler;
  const lines = [
    "# Hatch Desktop bundled native runtime notices",
    "",
    "These components are included in the Desktop application runtime and are used by the document Skills.",
    "",
    `- LibreOffice ${target.native.libreoffice.archive}: ${libreOffice.url}`,
    `  - SHA-256: ${libreOffice.sha256}`,
    `  - License: ${libreOffice.license}`,
    `- Poppler ${poppler.packageSpec}: ${poppler.channel}`,
    `  - License: ${poppler.license}`,
    "  - The bundled runtime manifest and conda-meta directory record the resolved transitive packages.",
    "",
    "micromamba is used only during the build to resolve and copy the pinned Poppler environment; it is not shipped in the application.",
    ""
  ];
  await writeFile(path.join(nativeRoot, "THIRD_PARTY_NOTICES.md"), `${lines.join("\n")}\n`, "utf8");
  await writeFile(path.join(nativeRoot, "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    kind: "hatch-desktop-native-runtime",
    target: target.key,
    libreoffice: {
      archive: target.native.libreoffice.archive,
      license: libreOffice.license,
      source: libreOffice.url,
      sha256: `sha256:${libreOffice.sha256}`
    },
    poppler: {
      package_spec: poppler.packageSpec,
      channel: poppler.channel,
      license: poppler.license,
      packages: popplerPackages
    },
    build_tool: {
      name: "micromamba",
      archive: target.native.micromamba.archive,
      sha256: `sha256:${target.native.micromamba.sha256}`
    }
  }, null, 2)}\n`, "utf8");
}

function uniqueExistingDirectories(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = path.normalize(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function downloadAndVerify(url, expectedSha256, destination) {
  if (await hasMatchingSha256(destination, expectedSha256)) return;
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  const curl = process.env.CURL_EXE?.trim() || (process.platform === "win32" ? "curl.exe" : "curl");
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await execFileAsync(curl, [
        "--fail",
        "--location",
        "--retry",
        "5",
        "--retry-all-errors",
        "--retry-delay",
        "2",
        "--connect-timeout",
        "30",
        "--max-time",
        "1800",
        "--continue-at",
        "-",
        "--output",
        partial,
        url
      ], { maxBuffer: 8 * 1024 * 1024 });
      if (await hasMatchingSha256(partial, expectedSha256)) {
        await rm(destination, { force: true });
        await rename(partial, destination);
        return;
      }
      await rm(partial, { force: true });
      lastError = new Error(`Checksum mismatch for ${path.basename(destination)} after curl download.`);
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Could not download and verify ${url}: ${detail}`);
}

async function hasMatchingSha256(file, expectedSha256) {
  try {
    const bytes = await readFile(file);
    return createHash("sha256").update(bytes).digest("hex") === expectedSha256;
  } catch {
    return false;
  }
}

async function locateFile(root, filename) {
  const queue = [root];
  const expected = filename.toLowerCase();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === expected) return candidate;
      if (entry.isDirectory()) queue.push(candidate);
    }
  }
  return undefined;
}

async function locateDirectory(root, predicate) {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory() && predicate(entry)) return candidate;
      if (entry.isDirectory()) queue.push(candidate);
    }
  }
  return undefined;
}

async function assertFile(file, label) {
  const metadata = await stat(file).catch(() => undefined);
  if (!metadata?.isFile()) throw new Error(`${label} is missing: ${file}`);
}

async function assertDirectory(directory, label) {
  const metadata = await stat(directory).catch(() => undefined);
  if (!metadata?.isDirectory()) throw new Error(`${label} is missing: ${directory}`);
}

async function run(executable, args, options = {}) {
  try {
    return await execFileAsync(executable, args, options);
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const detail = [stdout, stderr, error instanceof Error ? error.message : String(error)]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`Native runtime command failed (${executable} ${args.join(" ")}): ${detail}`);
  }
}
