import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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
  const popplerBuild = popplerExecutablePaths.buildRecord ?? null;
  await writeThirdPartyNotices(nativeRoot, target, popplerPackages, popplerBuild);

  return {
    root: nativeRoot,
    binDirectory: nativeBin,
    binaries,
    pathEntries,
    popplerPackages,
    popplerBuild,
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
  const cachedIdentity = cachedExecutables
    ? await validatePopplerCache({ root: cachedEnvironment, poppler: target.native.poppler }).catch(() => null)
    : null;
  if (!cachedIdentity) {
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
  const packageIdentity = await validatePopplerCache({ root: cachedEnvironment, poppler: target.native.poppler });
  await stagePopplerEnvironment({ source: cachedEnvironment, destination, platform: target.platform });
  let buildRecord = null;
  if (target.platform === "darwin") {
    buildRecord = await buildRelocatablePopplerTools({ popplerRoot: destination, cacheRoot, packageIdentity });
  }
  const installed = await locatePopplerExecutables(destination, target.platform);
  if (!installed) throw new Error("The staged Poppler environment is incomplete after copying.");
  return { ...installed, buildRecord };
}

export async function validatePopplerCache({ root, poppler }) {
  const spec = /^poppler=([^=]+)=([^=]+)$/.exec(poppler.packageSpec);
  if (!spec) throw new Error(`Poppler cache requires an exact version/build packageSpec: ${poppler.packageSpec}`);
  const packages = await readPopplerPackages(root);
  const matches = packages.filter(item => item.name === "poppler");
  if (matches.length !== 1) throw new Error("Poppler cache must have exactly one conda package record");
  const record = matches[0];
  if (record.version !== spec[1] || record.build !== spec[2] || record.subdir !== poppler.platform
      || record.channel !== poppler.channel) {
    throw new Error(`Poppler cache identity mismatch: expected ${poppler.channel}/${poppler.platform}/${poppler.packageSpec}, got ${JSON.stringify(record)}`);
  }
  return record;
}

// Read-only closure check: preserve links, reject dangling/cyclic, absolute or
// escaping links. Do not follow symlink directories during traversal.
export async function verifySymlinkClosure(root) {
  const canonicalRoot = await realpath(root);
  let count = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(file);
        if (path.isAbsolute(target)) throw new Error(`Non-relocatable absolute symlink: ${file} -> ${target}`);
        const resolved = await realpath(file).catch(error => { throw new Error(`Unresolvable symlink: ${file}: ${error.code}`); });
        const relative = path.relative(canonicalRoot, resolved);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`Symlink escapes runtime: ${file} -> ${resolved}`);
        }
        count++;
      } else if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(canonicalRoot);
  return { checked_links: count, absolute_links: 0, escaping_links: 0, unresolved_links: 0 };
}

export async function stagePopplerEnvironment({ source, destination, platform }) {
  await rm(destination, { recursive: true, force: true });
  // Node otherwise resolves relative symlinks against the build prefix, including
  // dylib aliases needed by Fontconfig. Preserve the package's relocatable links.
  await cp(source, destination, { recursive: true, force: true, verbatimSymlinks: true });
  await relocateFontconfig({ popplerRoot: destination, platform });
  await relocatePopplerData({ popplerRoot: destination, platform });
}

export async function relocatePopplerData({ popplerRoot, platform }) {
  const source = path.join(popplerRoot, "share/poppler");
  // Upstream ENABLE_RELOCATABLE on Windows locates data relative to the DLL:
  // Library/bin/poppler.dll -> Library/share/poppler. poppler-data is noarch.
  const destination = platform === "win32" ? path.join(popplerRoot, "Library/share/poppler") : source;
  if (destination !== source && await stat(source).catch(() => null)) {
    if (await stat(destination).catch(() => null)) throw new Error("Ambiguous Poppler data directories in bundle");
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(source, destination);
  }
  for (const name of ["cMap", "cidToUnicode", "nameToUnicode", "unicodeMap"]) {
    await assertDirectory(path.join(destination, name), `bundled Poppler ${name}`);
    if (!(await readdir(path.join(destination, name))).length) throw new Error(`Empty Poppler data directory: ${name}`);
  }
  await assertFile(path.join(destination, "cidToUnicode/Adobe-GB1"), "Poppler Chinese CID mapping");
  await assertFile(path.join(destination, "cMap/Adobe-GB1/UniGB-UCS2-H"), "Poppler Chinese CMap");
  return destination;
}

const POPPLER_SOURCE = {
  version: "26.05.0",
  url: "https://poppler.freedesktop.org/poppler-26.05.0.tar.xz",
  sha256: "6fef27ff04f37db43054c86bcdff6128c9fb1f6af4ef3c8b369a7e9abd68d0bb"
};

// GlobalParams.cc:461 uses the explicit constructor directory, otherwise the
// compile-time POPPLER_DATADIR (not getenv). Upstream relocatability is Windows
// only. Rebuild the two macOS CLI entrypoints against the exact bundled ABI;
// preserve upstream command handling, image formats, CMS and the library itself.
export async function buildRelocatablePopplerTools({ popplerRoot, cacheRoot, packageIdentity = null }) {
  const config = await readFile(path.join(popplerRoot, "include/poppler/poppler-config.h"), "utf8");
  if (!config.includes(`#define POPPLER_VERSION "${POPPLER_SOURCE.version}"`)) {
    throw new Error("Poppler source/header version mismatch; update the pinned CLI source before packaging");
  }
  await relocatePopplerData({ popplerRoot, platform: "darwin" });
  const { stdout: architectureOutput } = await run("/usr/bin/lipo", ["-archs", path.join(popplerRoot, "lib/libpoppler.dylib")]);
  const architecture = architectureOutput.trim();
  if (!["arm64", "x86_64"].includes(architecture)) throw new Error(`Unsupported Poppler architecture: ${architecture}`);
  const archive = path.join(cacheRoot, `poppler-${POPPLER_SOURCE.version}.tar.xz`);
  await downloadAndVerify(POPPLER_SOURCE.url, POPPLER_SOURCE.sha256, archive);
  const [compiler, compilerVersion, sdkPath, sdkVersion, sdkBuild] = await Promise.all([
    run("/usr/bin/xcrun", ["--find", "clang++"]),
    run("/usr/bin/xcrun", ["clang++", "--version"]),
    run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]),
    run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"]),
    run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-build-version"])
  ]);
  const record = {
    schema_version: 1,
    kind: "hatch-poppler-cli-build",
    stage: "native-runtime-staging-after-ad-hoc-signing",
    source: { ...POPPLER_SOURCE },
    recipe: { version: 1, file: "desktop-app/scripts/native-runtime.mjs", sha256: await sha256File(fileURLToPath(import.meta.url)) },
    package: packageIdentity ?? (await readPopplerPackages(popplerRoot)).find(item => item.name === "poppler"),
    architecture,
    compiler: { path: compiler.stdout.trim(), version: compilerVersion.stdout.trim() },
    sdk: { path: sdkPath.stdout.trim(), version: sdkVersion.stdout.trim(), build: sdkBuild.stdout.trim() },
    binaries: {}
  };
  const build = await mkdtemp(path.join(os.tmpdir(), "hatch-poppler-build-"));
  try {
    await run("/usr/bin/tar", ["-xf", archive, "-C", build]);
    const sources = path.join(build, `poppler-${POPPLER_SOURCE.version}`, "utils");
    await writeFile(path.join(build, "config.h"), '#include <poppler-config.h>\n#define PACKAGE_VERSION POPPLER_VERSION\n');
    const helper = `
#include <mach-o/dyld.h>
#include <filesystem>
#include <vector>
#include <cstdlib>
static std::string hatchPopplerDataDir() {
  try {
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::vector<char> executable(size);
    if (_NSGetExecutablePath(executable.data(), &size) != 0) throw std::runtime_error("executable path unavailable");
    auto root = std::filesystem::canonical(executable.data()).parent_path().parent_path() / "share" / "poppler";
    for (const auto *name : {"cMap", "cidToUnicode", "nameToUnicode", "unicodeMap"}) {
      if (!std::filesystem::is_directory(root / name)) throw std::runtime_error("bundled Poppler mappings are missing");
    }
    return root.string();
  } catch (const std::exception &error) {
    std::fprintf(stderr, "Hatch Poppler data unavailable: %s\\n", error.what());
    std::exit(99);
  }
}
`;
    for (const [name, extra] of [["pdftoppm", "sanitychecks.cc"], ["pdfinfo", "printencodings.cc"]]) {
      const filename = path.join(sources, `${name}.cc`);
      const original = await readFile(filename, "utf8");
      const init = "globalParams = std::make_unique<GlobalParams>();";
      if (original.split(init).length !== 2) throw new Error(`Unexpected upstream ${name} initialization`);
      await writeFile(filename, original.replace(init, "globalParams = std::make_unique<GlobalParams>(hatchPopplerDataDir());")
        .replace("static int firstPage", `${helper}\nstatic int firstPage`));
      const output = path.join(build, name);
      const args = ["clang++", "-arch", architecture, "-std=c++20", "-O2", "-mmacosx-version-min=11.0",
        "-isysroot", record.sdk.path,
        "-I", build, "-I", path.join(popplerRoot, "include/poppler"), "-I", path.join(popplerRoot, "include"),
        "-I", path.dirname(sources),
        filename, path.join(sources, "parseargs.cc"), path.join(sources, "Win32Console.cc"), path.join(sources, extra),
        "-L", path.join(popplerRoot, "lib"), "-lpoppler", "-llcms2", "-Wl,-rpath,@executable_path/../lib", "-o", output
      ];
      await run("/usr/bin/xcrun", args, { maxBuffer: 8 * 1024 * 1024 });
      await cp(output, path.join(popplerRoot, "bin", name));
      const signArgs = ["--force", "--sign", "-", path.join(popplerRoot, "bin", name)];
      await run("/usr/bin/codesign", signArgs);
      record.binaries[name] = {
        path: `bin/${name}`,
        bytes: (await stat(path.join(popplerRoot, "bin", name))).size,
        sha256: await sha256File(path.join(popplerRoot, "bin", name)),
        modified_source_sha256: await sha256File(filename),
        compile: { executable: "/usr/bin/xcrun", args, cwd: process.cwd() },
        sign: { executable: "/usr/bin/codesign", args: signArgs }
      };
    }
    // Retain exact corresponding sources and the CLI change with the bundle.
    const noticeSources = path.join(popplerRoot, "share/hatch-poppler-source");
    await mkdir(noticeSources, { recursive: true });
    await cp(archive, path.join(noticeSources, path.basename(archive)));
    for (const name of ["pdftoppm", "pdfinfo"]) await cp(path.join(sources, `${name}.cc`), path.join(noticeSources, `${name}.cc`));
    await cp(path.join(build, "config.h"), path.join(noticeSources, "config.h"));
    await writeFile(path.join(noticeSources, "README.txt"),
      `Upstream: ${POPPLER_SOURCE.url}\nSHA-256: ${POPPLER_SOURCE.sha256}\n` +
      "Hatch changes: pdftoppm/pdfinfo initialize GlobalParams with executable-relative share/poppler.\n" +
      "Original sources and GPL license are in the accompanying upstream archive. Modified sources and config.h are alongside it.\n" +
      "Build entrypoint: desktop-app/scripts/native-runtime.mjs buildRelocatablePopplerTools; uses Xcode clang++, bundled headers/libpoppler/liblcms2, C++20 and @executable_path/../lib rpath.\n");
    record.configuration_sha256 = await sha256File(path.join(build, "config.h"));
    await writeFile(path.join(noticeSources, "build-record.json"), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } finally {
    await rm(build, { recursive: true, force: true });
  }
}

async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

// Fontconfig's conda prefix is a build location, never a runtime authority.
export async function relocateFontconfig({ popplerRoot, platform }) {
  const prefix = platform === "win32" ? path.join(popplerRoot, "Library") : popplerRoot;
  const fonts = path.join(prefix, "etc", "fonts");
  await assertFile(path.join(fonts, "fonts.conf"), "bundled Fontconfig configuration");
  // cp's default symlink handling can leave conf.d pointing at the build cache.
  // Copy the package's rule contents, so no installed rule needs that cache.
  const rules = path.join(fonts, "conf.d");
  for (const entry of await readdir(rules, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const filename = path.join(rules, entry.name);
    const content = await readFile(filename);
    await rm(filename);
    await writeFile(filename, content);
  }
  const filename = path.join(fonts, "fonts.conf");
  let config = await readFile(filename, "utf8");
  config = config.replace(/<cachedir\b[^>]*>[\s\S]*?<\/cachedir>/g, "");
  config = config.replace("</fontconfig>", '  <cachedir prefix="xdg">fontconfig</cachedir>\n</fontconfig>');
  config = config.replace(/<include\b([^>]*)>conf\.d<\/include>/g,
    (_, attributes) => `<include${attributes.replace(/\s+prefix="[^"]*"/g, "")} prefix="relative">conf.d</include>`);
  await writeFile(filename, config, "utf8");
}

export async function writeMacWrappers({ nativeRoot, binaries, libreOfficeExecutable, popplerExecutablePaths }) {
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
export FONTCONFIG_PATH="$SCRIPT_DIR/../poppler/etc/fonts"
export FONTCONFIG_FILE="$FONTCONFIG_PATH/fonts.conf"
exec "$SCRIPT_DIR/${relativePdftoppm}" "$@"
`,
    pdfinfo: `#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export FONTCONFIG_PATH="$SCRIPT_DIR/../poppler/etc/fonts"
export FONTCONFIG_FILE="$FONTCONFIG_PATH/fonts.conf"
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

async function writeThirdPartyNotices(nativeRoot, target, popplerPackages, popplerBuild) {
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
    ...(target.platform === "darwin" ? [
      "  - Hatch rebuilds pdftoppm/pdfinfo with explicit executable-relative CMap data lookup using the upstream GlobalParams API.",
      `  - CLI source: ${POPPLER_SOURCE.url}; SHA-256: ${POPPLER_SOURCE.sha256}`,
      "  - Corresponding original and modified CLI sources: poppler/share/hatch-poppler-source."
    ] : []),
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
      packages: popplerPackages,
      cli_build: popplerBuild
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
