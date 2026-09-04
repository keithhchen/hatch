#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DESKTOP_RUNTIME_VERSION,
  currentBuildTarget,
  LIBREOFFICE_VERSION,
  MICROMAMBA_VERSION,
  NODE_VERSION,
  POPPLER_VERSION,
  PYTHON_BUILD_TAG,
  PYTHON_VERSION
} from "./runtime-manifest.mjs";
import { prepareNativeRuntime } from "./native-runtime.mjs";

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const outputRoot = path.join(desktopRoot, "src-tauri", "runtime");
const cacheRoot = path.resolve(
  process.env.HATCH_RUNTIME_CACHE_DIR?.trim()
    || path.join(os.homedir(), ".cache", "hatch-desktop-runtime")
);
const nodeToolchainSource = path.join(desktopRoot, "runtime", "node-toolchain");
const pythonRequirements = path.join(repositoryRoot, "runtime-server", "skills", "requirements.lock");
const skillSourceRoot = path.join(repositoryRoot, "runtime-server", "skills");
const documentSkills = ["documents", "pdf", "presentations", "spreadsheets"];

const target = currentBuildTarget();
const nodeArchivePath = path.join(cacheRoot, target.node.archive);
const pythonArchivePath = path.join(cacheRoot, target.python.archive);

if (process.env.HATCH_RUNTIME_SKIP_DOWNLOAD === "1") {
  await assertExistingRuntime();
  process.stdout.write(`Using the existing bundled runtime at ${outputRoot}\n`);
  process.exit(0);
}

await mkdir(cacheRoot, { recursive: true });
await mkdir(path.dirname(outputRoot), { recursive: true });

await downloadAndVerify(target.node.url, target.node.sha256, nodeArchivePath);
await downloadAndVerify(target.python.url, target.python.sha256, pythonArchivePath);

const stagingRoot = path.join(
  path.dirname(outputRoot),
  `.runtime-staging-${process.pid}-${Date.now()}`
);
await removeDirectory(stagingRoot);
await mkdir(stagingRoot, { recursive: true });

try {
  const nodeRoot = path.join(stagingRoot, "node");
  const pythonRoot = path.join(stagingRoot, "python");
  await extractArchive(nodeArchivePath, nodeRoot, target.node.archive);
  await extractArchive(pythonArchivePath, pythonRoot, target.python.archive);

  const nodeExecutable = path.join(stagingRoot, target.executables.node);
  const pythonExecutable = path.join(stagingRoot, target.executables.python);
  await assertFile(nodeExecutable, "bundled Node executable");
  await assertFile(pythonExecutable, "bundled Python executable");

  const pythonPackagesRoot = path.join(stagingRoot, "python-packages");
  await installPythonDependencies(pythonExecutable, pythonPackagesRoot);

  const nodeToolchainRoot = path.join(stagingRoot, "node-toolchain");
  await cp(nodeToolchainSource, nodeToolchainRoot, { recursive: true, force: true });
  const npmCli = await locateFile(nodeRoot, "npm-cli.js");
  if (!npmCli) throw new Error(`The Node ${NODE_VERSION} archive does not contain npm-cli.js.`);
  await installNodeDependencies(nodeExecutable, npmCli, nodeToolchainRoot, nodeRoot);

  const nativeRuntime = await prepareNativeRuntime({ stagingRoot, cacheRoot, target });

  const skillsRoot = path.join(stagingRoot, "skills");
  await mkdir(skillsRoot, { recursive: true });
  const sharedSkillSource = path.join(skillSourceRoot, "_shared");
  await assertDirectory(sharedSkillSource, "shared Skill runtime source");
  await cp(sharedSkillSource, path.join(skillsRoot, "_shared"), { recursive: true, force: true });
  for (const skillName of documentSkills) {
    const source = path.join(skillSourceRoot, skillName);
    const destination = path.join(skillsRoot, skillName);
    await assertDirectory(source, `document Skill source ${skillName}`);
    await cp(source, destination, { recursive: true, force: true });
  }

  const manifest = await createRuntimeManifest({
    stagingRoot,
    nodeExecutable,
    pythonExecutable,
    npmCli,
    pythonPackagesRoot,
    nodeToolchainRoot,
    nodeArchivePath,
    pythonArchivePath,
    nativeRuntime
  });
  await writeFile(path.join(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await verifyRuntimeSmoke({
    nodeExecutable,
    pythonExecutable,
    pythonPackagesRoot,
    nodeToolchainRoot,
    documentSkills: skillsRoot,
    nativeRuntime
  });

  await removeDirectory(outputRoot);
  await rename(stagingRoot, outputRoot);
  // Keep the tracked directory marker so generated builds do not dirty the worktree.
  await writeFile(path.join(outputRoot, ".gitkeep"), "\n", "utf8");
  process.stdout.write(`${JSON.stringify({
    kind: "hatch-desktop-bundled-runtime",
    root: outputRoot,
    target: target.key,
    node: NODE_VERSION,
    python: PYTHON_VERSION,
    native: {
      libreoffice: LIBREOFFICE_VERSION,
      poppler: POPPLER_VERSION,
      build_tool: `micromamba ${MICROMAMBA_VERSION}`
    },
    skills: documentSkills
  }, null, 2)}\n`);
} catch (error) {
  try {
    await removeDirectory(stagingRoot);
  } catch (cleanupError) {
    process.stderr.write(`Could not clean failed runtime staging directory ${stagingRoot}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
  }
  throw error;
}

async function removeDirectory(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
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

async function extractArchive(archive, destination, archiveName) {
  await rm(destination, { recursive: true, force: true });
  const extractionRoot = `${destination}.raw-${process.pid}-${Date.now()}`;
  await rm(extractionRoot, { recursive: true, force: true });
  await mkdir(extractionRoot, { recursive: true });
  const args = archiveName.toLowerCase().endsWith(".zip")
    ? ["-xf", archive, "-C", extractionRoot]
    : ["-xzf", archive, "-C", extractionRoot];
  try {
    await execFileAsync(process.env.TAR_EXE?.trim() || "tar", args, {
      maxBuffer: 8 * 1024 * 1024
    });
  } catch (error) {
    await rm(extractionRoot, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not extract ${archiveName}; a working tar/bsdtar is required: ${detail}`);
  }
  const entries = await readdir(extractionRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1) {
    await rm(extractionRoot, { recursive: true, force: true });
    throw new Error(`Archive ${archiveName} must contain exactly one top-level directory.`);
  }
  try {
    await rename(path.join(extractionRoot, directories[0].name), destination);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
  if (!await stat(destination).then((metadata) => metadata.isDirectory()).catch(() => false)) {
    throw new Error(`Archive ${archiveName} did not contain a top-level directory.`);
  }
}

async function installPythonDependencies(pythonExecutable, packageRoot) {
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  await run(pythonExecutable, [
    "-m", "pip", "install",
    "--disable-pip-version-check",
    "--no-input",
    "--no-cache-dir",
    "--no-compile",
    "--only-binary=:all:",
    "--target", packageRoot,
    "--requirement", pythonRequirements
  ], {
    env: {
      ...process.env,
      PYTHONNOUSERSITE: "1",
      PYTHONPATH: ""
    },
    maxBuffer: 32 * 1024 * 1024
  });
}

async function installNodeDependencies(nodeExecutable, npmCli, nodeToolchainRoot, nodeRoot) {
  await run(nodeExecutable, [npmCli, "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: nodeToolchainRoot,
    env: {
      ...process.env,
      PATH: [path.dirname(nodeExecutable), process.env.PATH].filter(Boolean).join(path.delimiter),
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false"
    },
    maxBuffer: 32 * 1024 * 1024
  });
  await run(nodeExecutable, ["--input-type=module", "-e", [
    "await import('docx')",
    "await import('exceljs')",
    "await import('fflate')",
    "await import('mammoth')",
    "await import('pdf-lib')",
    "await import('pdf-parse')",
    "await import('xlsx')",
    "await import('pptxgenjs')"
  ].join("; ")], {
    cwd: nodeToolchainRoot,
    env: {
      ...process.env,
      NODE_PATH: path.join(nodeToolchainRoot, "node_modules"),
      PATH: [path.dirname(nodeExecutable), process.env.PATH].filter(Boolean).join(path.delimiter)
    },
    maxBuffer: 8 * 1024 * 1024
  });
}

async function verifyRuntimeSmoke({
  nodeExecutable,
  pythonExecutable,
  pythonPackagesRoot,
  nodeToolchainRoot,
  documentSkills,
  nativeRuntime
}) {
  await run(nodeExecutable, ["--version"], { maxBuffer: 1024 * 1024 });
  const runtimePath = [
    ...nativeRuntime.pathEntries,
    path.dirname(nodeExecutable),
    path.dirname(pythonExecutable),
    process.env.PATH
  ].filter(Boolean).join(path.delimiter);
  const nodeEnvironment = {
    ...process.env,
    HATCH_RUNTIME_ROOT: path.dirname(documentSkills),
    HATCH_NATIVE_RUNTIME_ROOT: nativeRuntime.root,
    HATCH_NATIVE_BIN_DIR: nativeRuntime.binDirectory,
    HATCH_SOFFICE: nativeRuntime.binaries.soffice,
    HATCH_PDFTOPPM: nativeRuntime.binaries.pdftoppm,
    HATCH_PDFINFO: nativeRuntime.binaries.pdfinfo,
    HATCH_NODE: nodeExecutable,
    HATCH_NODE_MODULES: path.join(nodeToolchainRoot, "node_modules"),
    NODE_PATH: path.join(nodeToolchainRoot, "node_modules"),
    PATH: runtimePath
  };
  const pythonEnvironment = {
    ...nodeEnvironment,
    HATCH_PYTHON: pythonExecutable,
    HATCH_NODE: nodeExecutable,
    HATCH_NODE_MODULES: path.join(nodeToolchainRoot, "node_modules"),
    HATCH_DOCUMENT_SKILLS_ROOT: documentSkills,
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: pythonPackagesRoot,
    PATH: runtimePath
  };
  await run(nativeRuntime.binaries.soffice, ["--version"], {
    env: nodeEnvironment,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
  await run(nativeRuntime.binaries.pdftoppm, ["-v"], {
    env: nodeEnvironment,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
  await run(nativeRuntime.binaries.pdfinfo, ["-v"], {
    env: nodeEnvironment,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
  await run(pythonExecutable, ["--version"], {
    env: pythonEnvironment,
    maxBuffer: 1024 * 1024
  });
  await run(pythonExecutable, ["-c", [
    "import docx",
    "import lxml",
    "import openpyxl",
    "import pdfplumber",
    "import PIL",
    "import pptx",
    "import pypdf",
    "import reportlab"
  ].join("; ")], {
    env: pythonEnvironment,
    maxBuffer: 8 * 1024 * 1024
  });
  for (const skillName of documentSkills === undefined ? [] : ["documents", "pdf", "presentations", "spreadsheets"]) {
    await assertFile(path.join(documentSkills, skillName, "SKILL.md"), `${skillName} Skill`);
    await assertFile(path.join(documentSkills, skillName, "manifest.json"), `${skillName} Skill manifest`);
    await assertDirectory(path.join(documentSkills, skillName, "scripts"), `${skillName} Skill scripts`);
    await assertFile(path.join(documentSkills, skillName, "scripts", "read_asset.mjs"), `${skillName} chat asset reader`);
  }
  await assertDirectory(path.join(nodeToolchainRoot, "node_modules"), "bundled Node document packages");

  // Exercise the real Skill entrypoints with temporary binary artifacts. This
  // catches a bundle that merely contains files but cannot create/read them.
  const smokeRoot = path.join(path.dirname(documentSkills), `.document-skill-smoke-${process.pid}`);
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(smokeRoot, { recursive: true });
  try {
    const documentsRoot = path.join(documentSkills, "documents");
    const pdfRoot = path.join(documentSkills, "pdf");
    const presentationsRoot = path.join(documentSkills, "presentations");
    const spreadsheetsRoot = path.join(documentSkills, "spreadsheets");
    const docx = path.join(smokeRoot, "smoke.docx");
    const acceptedDocx = path.join(smokeRoot, "accepted.docx");
    const pdf = path.join(smokeRoot, "smoke.pdf");
    const formPdf = path.join(smokeRoot, "form.pdf");
    const filledPdf = path.join(smokeRoot, "filled.pdf");
    const xlsx = path.join(smokeRoot, "smoke.xlsx");
    const pptx = path.join(smokeRoot, "smoke.pptx");
    const docxRenderRoot = path.join(smokeRoot, "docx-render");
    const officeConvertRoot = path.join(smokeRoot, "office-convert");
    const pdfRenderRoot = path.join(smokeRoot, "pdf-render");
    const xlsxRenderRoot = path.join(smokeRoot, "xlsx-render");
    const recalculatedXlsx = path.join(smokeRoot, "recalculated.xlsx");
    const pptxRenderRoot = path.join(smokeRoot, "pptx-render");
    const rowsFile = path.join(smokeRoot, "rows.json");
    const slidesFile = path.join(smokeRoot, "slides.json");
    await writeFile(rowsFile, JSON.stringify({ sheet: "Smoke", rows: [["value"], [42]] }), "utf8");
    await writeFile(slidesFile, JSON.stringify({ slides: [{ title: "Smoke", bullets: ["Runtime" ] }] }), "utf8");
    await run(nodeExecutable, [path.join(documentsRoot, "scripts", "create_docx.mjs"), "--output", docx, "--title", "Smoke", "--paragraph", "Bundled document"], { env: nodeEnvironment, cwd: documentsRoot });
    await run(pythonExecutable, [path.join(documentsRoot, "scripts", "accept_changes.py"), docx, "--output", acceptedDocx], { env: pythonEnvironment, cwd: documentsRoot });
    await run(pythonExecutable, [path.join(documentsRoot, "scripts", "validate_docx.py"), acceptedDocx], { env: pythonEnvironment, cwd: documentsRoot });
    await run(nodeExecutable, [path.join(documentsRoot, "scripts", "read_asset.mjs"), "--input", acceptedDocx, "--max-chars", "200000"], { env: nodeEnvironment, cwd: documentsRoot });
    await run(pythonExecutable, [path.join(documentsRoot, "scripts", "render_docx.py"), acceptedDocx, "--output-dir", docxRenderRoot], { env: pythonEnvironment, cwd: documentsRoot, timeout: 120_000 });
    await assertRenderedPages(docxRenderRoot, "page-", "DOCX visual render");
    await run(pythonExecutable, [path.join(documentsRoot, "scripts", "office_convert.py"), acceptedDocx, "--output-dir", officeConvertRoot, "--format", "pdf"], { env: pythonEnvironment, cwd: documentsRoot, timeout: 120_000 });
    await assertFile(path.join(officeConvertRoot, "accepted.pdf"), "Office conversion smoke output");

    await run(nodeExecutable, [path.join(pdfRoot, "scripts", "create_pdf.mjs"), "--output", pdf, "--text", "Bundled PDF"], { env: nodeEnvironment, cwd: pdfRoot });
    await run(nodeExecutable, ["--input-type=module", "-e", [
      "import { writeFile } from 'node:fs/promises'",
      "import { PDFDocument, StandardFonts } from 'pdf-lib'",
      `const output = ${JSON.stringify(formPdf)}`,
      "const document = await PDFDocument.create()",
      "const page = document.addPage()",
      "page.drawText('Form smoke', { x: 72, y: 720, size: 12, font: await document.embedFont(StandardFonts.Helvetica) })",
      "const field = document.getForm().createTextField('smoke-name')",
      "field.addToPage(page, { x: 72, y: 680, width: 220, height: 24 })",
      "await writeFile(output, await document.save())"
    ].join("; ")], { env: nodeEnvironment, cwd: nodeToolchainRoot });
    await run(pythonExecutable, [path.join(pdfRoot, "scripts", "pdf_tool.py"), "inspect", pdf], { env: pythonEnvironment, cwd: pdfRoot });
    await run(pythonExecutable, [path.join(pdfRoot, "scripts", "pdf_tool.py"), "form-inspect", formPdf], { env: pythonEnvironment, cwd: pdfRoot });
    await run(pythonExecutable, [path.join(pdfRoot, "scripts", "pdf_tool.py"), "form-fill", formPdf, "--field", "smoke-name=Hatch", "--output", filledPdf], { env: pythonEnvironment, cwd: pdfRoot });
    await run(nodeExecutable, [path.join(pdfRoot, "scripts", "read_asset.mjs"), "--input", filledPdf, "--max-chars", "200000"], { env: nodeEnvironment, cwd: pdfRoot });
    await run(pythonExecutable, [path.join(pdfRoot, "scripts", "pdf_tool.py"), "render", filledPdf, "--output-dir", pdfRenderRoot, "--dpi", "72"], { env: pythonEnvironment, cwd: pdfRoot, timeout: 120_000 });
    await assertRenderedPages(pdfRenderRoot, "page-", "PDF visual render");

    await run(nodeExecutable, [path.join(spreadsheetsRoot, "scripts", "create_xlsx.mjs"), "--rows-file", rowsFile, "--output", xlsx], { env: nodeEnvironment, cwd: spreadsheetsRoot });
    await run(pythonExecutable, [path.join(spreadsheetsRoot, "scripts", "xlsx_tool.py"), "inspect", xlsx], { env: pythonEnvironment, cwd: spreadsheetsRoot });
    await run(pythonExecutable, [path.join(spreadsheetsRoot, "scripts", "xlsx_tool.py"), "validate", xlsx], { env: pythonEnvironment, cwd: spreadsheetsRoot });
    await run(nodeExecutable, [path.join(spreadsheetsRoot, "scripts", "read_asset.mjs"), "--input", xlsx, "--max-chars", "200000"], { env: nodeEnvironment, cwd: spreadsheetsRoot });
    await run(pythonExecutable, [path.join(spreadsheetsRoot, "scripts", "xlsx_tool.py"), "render", xlsx, "--output-dir", xlsxRenderRoot, "--dpi", "72"], { env: pythonEnvironment, cwd: spreadsheetsRoot, timeout: 120_000 });
    await assertRenderedPages(xlsxRenderRoot, "sheet-page-", "spreadsheet visual render");
    await run(pythonExecutable, [path.join(spreadsheetsRoot, "scripts", "recalc.py"), xlsx, "--output", recalculatedXlsx], { env: pythonEnvironment, cwd: spreadsheetsRoot, timeout: 120_000 });
    await assertFile(recalculatedXlsx, "spreadsheet recalculation smoke output");

    await run(nodeExecutable, [path.join(presentationsRoot, "scripts", "create_pptx.mjs"), "--slides-file", slidesFile, "--output", pptx], { env: nodeEnvironment, cwd: presentationsRoot });
    await run(pythonExecutable, [path.join(presentationsRoot, "scripts", "pptx_tool.py"), "inspect", pptx], { env: pythonEnvironment, cwd: presentationsRoot });
    await run(pythonExecutable, [path.join(presentationsRoot, "scripts", "pptx_tool.py"), "validate", pptx], { env: pythonEnvironment, cwd: presentationsRoot });
    await run(nodeExecutable, [path.join(presentationsRoot, "scripts", "read_asset.mjs"), "--input", pptx, "--max-chars", "200000"], { env: nodeEnvironment, cwd: presentationsRoot });
    await run(pythonExecutable, [path.join(presentationsRoot, "scripts", "pptx_tool.py"), "render", pptx, "--output-dir", pptxRenderRoot], { env: pythonEnvironment, cwd: presentationsRoot, timeout: 120_000 });
    await assertRenderedPages(pptxRenderRoot, "slide-", "PowerPoint visual render");
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

async function createRuntimeManifest({
  stagingRoot,
  nodeExecutable,
  pythonExecutable,
  npmCli,
  pythonPackagesRoot,
  nodeToolchainRoot,
  nodeArchivePath,
  pythonArchivePath,
  nativeRuntime
}) {
  const relative = (file) => path.relative(stagingRoot, file).split(path.sep).join("/");
  const pythonPackages = await packageVersions(pythonExecutable, pythonPackagesRoot, "python");
  const nodePackages = await packageVersions(nodeExecutable, nodeToolchainRoot, "node");
  return {
    schema_version: 1,
    kind: "hatch-desktop-bundled-runtime",
    runtime_version: DESKTOP_RUNTIME_VERSION,
    target: {
      key: target.key,
      platform: target.platform,
      arch: target.arch
    },
    node: {
      version: NODE_VERSION,
      executable: relative(nodeExecutable),
      npm_cli: relative(npmCli),
      module_root: relative(path.join(nodeToolchainRoot, "node_modules")),
      archive: {
        filename: target.node.archive,
        url: target.node.url,
        sha256: `sha256:${target.node.sha256}`
      },
      packages: nodePackages
    },
    python: {
      version: PYTHON_VERSION,
      build_tag: PYTHON_BUILD_TAG,
      executable: relative(pythonExecutable),
      package_root: relative(pythonPackagesRoot),
      archive: {
        filename: target.python.archive,
        url: target.python.url,
        sha256: `sha256:${target.python.sha256}`
      },
      packages: pythonPackages
    },
    native: {
      root: relative(nativeRuntime.root),
      bin_dir: relative(nativeRuntime.binDirectory),
      binaries: Object.fromEntries(Object.entries(nativeRuntime.binaries).map(([name, executable]) => [name, relative(executable)])),
      libreoffice: {
        version: LIBREOFFICE_VERSION,
        archive: {
          filename: target.native.libreoffice.archive,
          url: target.native.libreoffice.url,
          sha256: `sha256:${target.native.libreoffice.sha256}`
        },
        license: target.native.libreoffice.license
      },
      poppler: {
        version: POPPLER_VERSION,
        channel: target.native.poppler.channel,
        platform: target.native.poppler.platform,
        package_spec: target.native.poppler.packageSpec,
        execution_arch: target.native.poppler.executionArch ?? target.arch,
        license: target.native.poppler.license,
        packages: nativeRuntime.popplerPackages
      },
      build_tool: {
        name: "micromamba",
        version: MICROMAMBA_VERSION,
        archive: {
          filename: target.native.micromamba.archive,
          url: target.native.micromamba.url,
          sha256: `sha256:${target.native.micromamba.sha256}`
        },
        shipped: false
      }
    },
    skills: Object.fromEntries(documentSkills.map((skillName) => [skillName, {
      path: `skills/${skillName}`,
      entrypoint: `skills/${skillName}/SKILL.md`,
      scripts: `skills/${skillName}/scripts`
    }]))
  };
}

async function packageVersions(executable, cwd, kind) {
  if (kind === "python") {
    const result = await run(executable, ["-m", "pip", "list", "--format=json", "--path", cwd], {
      env: { ...process.env, PYTHONNOUSERSITE: "1", PYTHONPATH: cwd },
      maxBuffer: 16 * 1024 * 1024
    });
    return JSON.parse(result.stdout).map(({ name, version }) => ({ name, version }));
  }
  const packageJson = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  return Object.keys(packageJson.dependencies ?? {}).sort().map((name) => ({
    name,
    version: packageJson.dependencies[name]
  }));
}

async function locateFile(root, filename) {
  const queue = [root];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const real = await pathRealpath(current);
    if (visited.has(real)) continue;
    visited.add(real);
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isFile() && entry.name === filename) return candidate;
      if (entry.isDirectory()) queue.push(candidate);
    }
  }
  return undefined;
}

async function pathRealpath(candidate) {
  try {
    return realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function assertRenderedPages(directory, prefix, label) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  if (!entries.some((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".png"))) {
    throw new Error(`${label} did not produce any PNG pages in ${directory}.`);
  }
}

async function assertFile(file, label) {
  const metadata = await stat(file).catch(() => undefined);
  if (!metadata?.isFile()) throw new Error(`${label} is missing: ${file}`);
}

async function assertDirectory(directory, label) {
  const metadata = await stat(directory).catch(() => undefined);
  if (!metadata?.isDirectory()) throw new Error(`${label} is missing: ${directory}`);
}

async function assertExistingRuntime() {
  await assertFile(path.join(outputRoot, "manifest.json"), "bundled runtime manifest");
  const { verifyBundledRuntime } = await import("./verify-bundled-runtime.mjs");
  await verifyBundledRuntime({ root: outputRoot, targetKey: target.key });
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
    throw new Error(`Bundled runtime command failed (${executable} ${args.join(" ")}): ${detail}`);
  }
}
