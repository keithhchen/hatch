#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { currentTarget } from "./runtime-manifest.mjs";

const execFileAsync = promisify(execFile);

export async function verifyBundledRuntime({ root, searchRoot, reportFile = null, environment = process.env }) {
  const runtimeRoot = path.resolve(root || await findRuntimeRoot(searchRoot));
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read bundled runtime manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest?.schema_version !== 1 || manifest.kind !== "hatch-desktop-bundled-runtime") {
    throw new Error(`Unsupported bundled runtime manifest at ${manifestPath}.`);
  }

  const nodeExecutable = resolveRelative(runtimeRoot, manifest.node?.executable, "Node executable");
  const pythonExecutable = resolveRelative(runtimeRoot, manifest.python?.executable, "Python executable");
  const pythonPackages = resolveRelative(runtimeRoot, manifest.python?.package_root, "Python package root");
  const nodeModules = resolveRelative(runtimeRoot, manifest.node?.module_root, "Node module root");
  await assertFile(nodeExecutable, "Node executable");
  await assertFile(pythonExecutable, "Python executable");
  await assertDirectory(pythonPackages, "Python package root");
  await assertDirectory(nodeModules, "Node module root");

  const target = currentTarget();
  if (manifest.target?.key !== target.key) {
    throw new Error(`Bundled runtime target ${manifest.target?.key ?? "<missing>"} does not match this build host ${target.key}.`);
  }
  const versionReport = await run(nodeExecutable, ["--version"], { env: environment });
  const pythonReport = await run(pythonExecutable, ["--version"], {
    env: { ...environment, PYTHONNOUSERSITE: "1", PYTHONPATH: pythonPackages }
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
    env: { ...environment, PYTHONNOUSERSITE: "1", PYTHONPATH: pythonPackages }
  });
  await run(nodeExecutable, ["--input-type=module", "-e", [
    "await import('docx')",
    "await import('exceljs')",
    "await import('fflate')",
    "await import('mammoth')",
    "await import('pdf-lib')",
    "await import('pdf-parse')",
    "await import('pptxgenjs')",
    "await import('xlsx')"
  ].join("; ")], {
    cwd: path.dirname(nodeModules),
    env: { ...environment, NODE_PATH: nodeModules }
  });
  const nodeVersion = versionReport.stdout.trim() || versionReport.stderr.trim();
  const pythonVersion = pythonReport.stdout.trim() || pythonReport.stderr.trim();
  if (nodeVersion !== `v${manifest.node?.version}`) {
    throw new Error(`Bundled Node version ${nodeVersion} does not match manifest ${manifest.node?.version}.`);
  }
  if (pythonVersion !== `Python ${manifest.python?.version}`) {
    throw new Error(`Bundled Python version ${pythonVersion} does not match manifest ${manifest.python?.version}.`);
  }

  const checkedSkills = [];
  for (const [name, entry] of Object.entries(manifest.skills ?? {})) {
    const skillRoot = resolveRelative(runtimeRoot, entry?.path, `${name} Skill`);
    await assertFile(path.join(skillRoot, "SKILL.md"), `${name} Skill instructions`);
    await assertFile(path.join(skillRoot, "manifest.json"), `${name} Skill manifest`);
    await assertDirectory(path.join(skillRoot, "scripts"), `${name} Skill scripts`);
    await assertFile(path.join(skillRoot, "scripts", "read_asset.mjs"), `${name} Skill chat asset reader`);
    if (entry?.entrypoint) await assertFile(resolveRelative(runtimeRoot, entry.entrypoint, `${name} Skill entrypoint`), `${name} Skill entrypoint`);
    checkedSkills.push(name);
  }
  for (const required of ["documents", "pdf", "presentations", "spreadsheets"]) {
    if (!checkedSkills.includes(required)) throw new Error(`Bundled runtime is missing the ${required} Skill.`);
  }

  const result = {
    schema_version: 1,
    kind: "hatch-desktop-bundled-runtime-verification",
    verified: true,
    root: runtimeRoot,
    target: manifest.target,
    expected_target: target.key,
    node: { version: versionReport.stdout.trim() || versionReport.stderr.trim() },
    python: { version: pythonReport.stdout.trim() || pythonReport.stderr.trim() },
    skills: checkedSkills.sort()
  };
  if (reportFile) await writeFile(reportFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function resolveRelative(root, relative, label) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a relative path in the bundled runtime manifest.`);
  }
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the bundled runtime root.`);
  }
  return resolved;
}

async function findRuntimeRoot(searchRoot) {
  if (!searchRoot) throw new Error("Provide --root or --search-root.");
  const root = path.resolve(searchRoot);
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || item.depth > 6) continue;
    const entries = await readdir(item.directory, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.isFile() && entry.name === "manifest.json")) {
      try {
        const candidate = JSON.parse(await readFile(path.join(item.directory, "manifest.json"), "utf8"));
        if (candidate?.kind === "hatch-desktop-bundled-runtime") return item.directory;
      } catch {
        // Continue searching. A generated build directory may contain unrelated JSON.
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules") {
        queue.push({ directory: path.join(item.directory, entry.name), depth: item.depth + 1 });
      }
    }
  }
  throw new Error(`Could not find a Hatch bundled runtime below ${root}.`);
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
    throw new Error(`Bundled runtime verification failed (${executable} ${args.join(" ")}): ${detail}`);
  }
}

function readCliArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${JSON.stringify(argument)}.`);
    const [name, inlineValue] = argument.slice(2).split("=", 2);
    if (name === "help") return { help: true };
    const value = inlineValue ?? argv[++index];
    if (!value || values.has(name)) throw new Error(`Expected one value for --${name}.`);
    values.set(name, value);
  }
  const accepted = new Set(["root", "search-root", "report"]);
  for (const name of values.keys()) {
    if (!accepted.has(name)) throw new Error(`Unknown argument --${name}.`);
  }
  return {
    root: values.get("root"),
    searchRoot: values.get("search-root"),
    reportFile: values.get("report") ?? null
  };
}

async function main() {
  const options = readCliArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node verify-bundled-runtime.mjs --root <runtime> [--report <file>]\n");
    return;
  }
  const result = await verifyBundledRuntime(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
