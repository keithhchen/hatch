import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename, rm, lstat, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { relocateFontconfig, relocatePopplerData, stagePopplerEnvironment, writeMacWrappers, validatePopplerCache, verifySymlinkClosure } from "./native-runtime.mjs";

test("fixed conda cache accepts only the requested version, build, channel and platform", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-poppler-cache-test-"));
  try {
    await mkdir(path.join(root, "conda-meta"));
    const file = path.join(root, "conda-meta/poppler.json");
    const poppler = { packageSpec: "poppler=26.05.0=hd83632c_3", platform: "osx-arm64", channel: "conda-forge" };
    const valid = { name: "poppler", version: "26.05.0", build: "hd83632c_3", subdir: "osx-arm64", channel: "conda-forge" };
    await assert.rejects(validatePopplerCache({ root, poppler }), /exactly one/);
    await writeFile(file, JSON.stringify(valid));
    assert.equal((await validatePopplerCache({ root, poppler })).build, valid.build);
    for (const change of [{ version: "26.04.0" }, { build: "hd83632c_2" }, { subdir: "osx-64" }, { channel: "other" }]) {
      await writeFile(file, JSON.stringify({ ...valid, ...change }));
      await assert.rejects(validatePopplerCache({ root, poppler }), /identity mismatch/);
    }
    await assert.rejects(validatePopplerCache({ root, poppler: { ...poppler, packageSpec: "poppler=26.05.0" } }), /exact version\/build/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlink closure preserves internal chains but rejects absolute, dangling and escaping links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-symlink-closure-"));
  try {
    const bundle = path.join(root, "bundle");
    await mkdir(bundle);
    await writeFile(path.join(bundle, "target"), "fixture");
    await writeFile(path.join(root, "outside"), "fixture");
    await symlink("target", path.join(bundle, "first"));
    await symlink("first", path.join(bundle, "second"));
    assert.equal((await verifySymlinkClosure(bundle)).checked_links, 2);
    assert((await lstat(path.join(bundle, "first"))).isSymbolicLink());
    for (const [target, error] of [[path.join(bundle, "target"), /absolute/], ["missing", /Unresolvable/], ["../outside", /escapes/], ["bad", /Unresolvable/]]) {
      await symlink(target, path.join(bundle, "bad"));
      await assert.rejects(verifySymlinkClosure(bundle), error);
      await rm(path.join(bundle, "bad"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createPopplerData(root) {
  for (const name of ["cMap/Adobe-GB1/UniGB-UCS2-H", "cidToUnicode/Adobe-GB1", "nameToUnicode/Greek", "unicodeMap/UTF-8"]) {
    const file = path.join(root, "share/poppler", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "automated packaging fixture");
  }
}

for (const platform of ["darwin", "win32"]) {
  test(`Fontconfig survives relocation and removal of build prefix (${platform})`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hatch-fontconfig-test-"));
    try {
      const build = path.join(root, "build");
      const staged = path.join(root, "staged");
      const relative = platform === "win32" ? "Library/etc/fonts" : "etc/fonts";
      const fonts = path.join(build, relative);
      await mkdir(build, { recursive: true });
      await createPopplerData(build);
      await mkdir(path.join(fonts, "conf.d"), { recursive: true });
      await writeFile(path.join(build, "rule.conf"), "<fontconfig><alias><family>sans</family></alias></fontconfig>");
      await symlink(path.join(build, "rule.conf"), path.join(fonts, "conf.d/10-rule.conf"));
      await mkdir(path.join(build, "lib"));
      await writeFile(path.join(build, "lib/libfont.1.dylib"), "package library test fixture");
      await symlink("libfont.1.dylib", path.join(build, "lib/libfont.dylib"));
      await writeFile(path.join(fonts, "fonts.conf"), `<fontconfig><dir>/System/Library/Fonts</dir><include ignore_missing="yes">conf.d</include><cachedir>${build}/var/cache/fontconfig</cachedir><cachedir>~/.fontconfig</cachedir></fontconfig>`);
      await stagePopplerEnvironment({ source: build, destination: staged, platform });
      await relocateFontconfig({ popplerRoot: staged, platform });
      await rm(build, { recursive: true });
      const moved = path.join(root, "moved 空格");
      await rename(staged, moved);
      const data = await relocatePopplerData({ popplerRoot: moved, platform });
      assert.equal(data, path.join(moved, platform === "win32" ? "Library/share/poppler" : "share/poppler"));
      assert.equal(await readFile(path.join(data, "cidToUnicode/Adobe-GB1"), "utf8"), "automated packaging fixture");
      assert.equal(await readFile(path.join(moved, "lib/libfont.dylib"), "utf8"), "package library test fixture");
      const config = await readFile(path.join(moved, relative, "fonts.conf"), "utf8");
      assert(!config.includes(build));
      assert.equal((config.match(/<cachedir/g) || []).length, 1);
      assert(config.includes('<cachedir prefix="xdg">fontconfig</cachedir>'));
      assert(config.includes('prefix="relative">conf.d'));
      assert.equal((config.match(/prefix="relative"/g) || []).length, 1);
      assert(!(await lstat(path.join(moved, relative, "conf.d/10-rule.conf"))).isSymbolicLink());
      assert((await readFile(path.join(moved, relative, "conf.d/10-rule.conf"), "utf8")).includes("<alias>"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Poppler packaging rejects missing or ambiguous data instead of falling back to a host prefix", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-poppler-data-test-"));
  try {
    await assert.rejects(relocatePopplerData({ popplerRoot: root, platform: "darwin" }));
    await createPopplerData(root);
    await createPopplerData(path.join(root, "Library"));
    await assert.rejects(relocatePopplerData({ popplerRoot: root, platform: "win32" }), /Ambiguous/);
    await rm(path.join(root, "share/poppler/cMap/Adobe-GB1/UniGB-UCS2-H"));
    await assert.rejects(relocatePopplerData({ popplerRoot: root, platform: "darwin" }), /Chinese CMap/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS native/bin wrappers resolve Fontconfig after moving the bundle", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-fontconfig-wrapper-"));
  try {
    const nativeRoot = path.join(root, "native");
    const binaries = Object.fromEntries(["soffice", "pdftoppm", "pdfinfo"].map(name => [name, path.join(nativeRoot, "bin", name)]));
    const engines = Object.fromEntries(["pdftoppm", "pdfinfo"].map(name => [name, path.join(nativeRoot, "poppler/bin", name)]));
    await mkdir(path.join(nativeRoot, "poppler/bin"), { recursive: true });
    await mkdir(path.join(nativeRoot, "poppler/etc/fonts"), { recursive: true });
    await writeFile(path.join(nativeRoot, "poppler/etc/fonts/fonts.conf"), "<fontconfig/>");
    for (const engine of Object.values(engines)) {
      await writeFile(engine, '#!/bin/sh\ntest -f "$FONTCONFIG_FILE" || exit 2\nprintf "%s\\n" "$FONTCONFIG_FILE" "$FONTCONFIG_PATH" "$1"\n', { mode: 0o755 });
    }
    await writeMacWrappers({ nativeRoot, binaries, libreOfficeExecutable: path.join(nativeRoot, "libreoffice/soffice"), popplerExecutablePaths: engines });
    const moved = path.join(root, "moved 空格");
    await rename(nativeRoot, moved);
    for (const name of Object.keys(engines)) {
      const { stdout, stderr } = await promisify(execFile)(path.join(moved, "bin", name), ["argument 空格"], {
        env: { PATH: "/usr/bin:/bin", FONTCONFIG_FILE: "/invalid/build/fonts.conf", FONTCONFIG_PATH: "/invalid/build" }
      });
      assert.equal(stderr, "");
      const [file, directory, argument] = stdout.trim().split("\n");
      assert.equal(path.resolve(file), path.join(moved, "poppler/etc/fonts/fonts.conf"));
      assert.equal(path.resolve(directory), path.dirname(path.resolve(file)));
      assert.equal(argument, "argument 空格");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Opt-in negative integration test: copy only the real CLI into an isolated
// incomplete bundle. Never rename or remove any part of the supplied runtime.
test("real relocated Poppler rejects missing bundled data even with POPPLER_DATADIR set", {
  skip: process.platform !== "darwin" || !process.env.HATCH_TEST_POPPLER_ROOT
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-poppler-missing-data-"));
  try {
    const bundled = process.env.HATCH_TEST_POPPLER_ROOT;
    await mkdir(path.join(root, "bin"));
    await symlink(path.join(bundled, "lib"), path.join(root, "lib"));
    for (const name of ["pdftoppm", "pdfinfo"]) {
      const executable = path.join(root, "bin", name);
      await cp(path.join(bundled, "bin", name), executable);
      await assert.rejects(promisify(execFile)(executable, ["unused.pdf"], {
        env: { PATH: "/usr/bin:/bin", POPPLER_DATADIR: path.join(bundled, "share/poppler") }
      }), error => error.code === 99 && error.stderr.includes("Hatch Poppler data unavailable"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real CLI build record identifies the recipe, SDK, exact commands and signed binary bytes", {
  skip: process.platform !== "darwin" || !process.env.HATCH_TEST_POPPLER_ROOT
}, async () => {
  const root = process.env.HATCH_TEST_POPPLER_ROOT;
  const source = path.join(root, "share/hatch-poppler-source");
  const record = JSON.parse(await readFile(path.join(source, "build-record.json"), "utf8"));
  const hash = async file => createHash("sha256").update(await readFile(file)).digest("hex");
  assert.equal(record.source.sha256, await hash(path.join(source, `poppler-${record.source.version}.tar.xz`)));
  assert.equal(record.recipe.sha256, await hash(new URL("./native-runtime.mjs", import.meta.url)));
  assert.equal(record.recipe.version, 1);
  assert(record.compiler.version.includes("clang"));
  assert(record.sdk.path && record.sdk.version && record.sdk.build);
  assert.equal(record.package.version, record.source.version);
  assert.equal(record.package.subdir, record.architecture === "arm64" ? "osx-arm64" : "osx-64");
  for (const name of ["pdftoppm", "pdfinfo"]) {
    const binary = record.binaries[name];
    assert.equal(binary.sha256, await hash(path.join(root, binary.path)));
    assert.equal(binary.modified_source_sha256, await hash(path.join(source, `${name}.cc`)));
    const args = binary.compile.args;
    assert.equal(args[args.indexOf("-isysroot") + 1], record.sdk.path);
    assert.equal(args[args.indexOf("-arch") + 1], record.architecture);
    assert(binary.sign.args.includes("--sign"));
  }
});
