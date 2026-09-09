import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run: HATCH_RUNTIME_INTEGRATION=1 node --test desktop-app/scripts/prepare-runtime.integration.mjs
// Opt-in integration test: all subprocesses use the existing bundled toolchain.
// Extract the actual smoke block without running preparation's download/swap.
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.env.HATCH_RUNTIME_INTEGRATION === "1";
const exec = promisify(execFile);
for (const source of ["bundled", "current"]) {
  test(`real bundled xlsx smoke (${source} Skills)`, { skip: !enabled, timeout: 300_000 }, async (t) => {
    const root = path.join(desktopRoot, "src-tauri/runtime");
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    const nodeExecutable = path.join(root, manifest.node.executable);
    const pythonExecutable = path.join(root, manifest.python.executable);
    const skills = source === "bundled" ? path.join(root, "skills") : path.resolve(desktopRoot, "../runtime-server/skills");
    const spreadsheetsRoot = path.join(skills, "spreadsheets");
    const nativeBin = path.join(root, manifest.native.bin_dir);
    const nodeEnvironment = {
      ...process.env,
      HATCH_RUNTIME_ROOT: root,
      HATCH_NATIVE_RUNTIME_ROOT: path.join(root, manifest.native.root),
      HATCH_NATIVE_BIN_DIR: nativeBin,
      HATCH_SOFFICE: path.join(root, manifest.native.binaries.soffice),
      HATCH_PDFTOPPM: path.join(root, manifest.native.binaries.pdftoppm),
      HATCH_PDFINFO: path.join(root, manifest.native.binaries.pdfinfo),
      HATCH_NODE: nodeExecutable,
      HATCH_PYTHON: pythonExecutable,
      HATCH_NODE_MODULES: path.join(root, manifest.node.module_root),
      HATCH_DOCUMENT_SKILLS_ROOT: skills,
      NODE_PATH: path.join(root, manifest.node.module_root),
      PYTHONPATH: path.join(root, manifest.python.package_root),
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PATH: [nativeBin, path.dirname(nodeExecutable), path.dirname(pythonExecutable), process.env.PATH].join(path.delimiter)
    };
    const pythonEnvironment = nodeEnvironment;
    const smokeRoot = await mkdtemp(path.join(os.tmpdir(), "hatch-xlsx-integration-"));
    try {
      const xlsx = path.join(smokeRoot, "smoke.xlsx");
      const recalculatedXlsx = path.join(smokeRoot, "recalculated.xlsx");
      const rowsFile = path.join(smokeRoot, "rows.json");
      const xlsxRenderRoot = path.join(smokeRoot, "xlsx-render");
      await writeFile(rowsFile, JSON.stringify({ sheet: "Smoke", rows: [["value"], [42]] }));
      const hash = async () => createHash("sha256").update(await readFile(xlsx)).digest("hex");
      const run = async (executable, args, options = {}) => {
        t.diagnostic(JSON.stringify({ executable, args }));
        const recalc = args[0] === path.join(spreadsheetsRoot, "scripts/recalc.py");
        const before = recalc ? await hash() : undefined;
        const result = await exec(executable, args, { maxBuffer: 8 * 1024 * 1024, timeout: 120_000, ...options });
        if (recalc) {
          assert.equal(await hash(), before, "Source workbook bytes changed during recalculation");
          t.diagnostic(`Source SHA-256 unchanged: ${before}`);
        }
        if (result.stdout.trim()) t.diagnostic(result.stdout.trim());
        return result;
      };
      t.diagnostic(`Bundled native manifest: LibreOffice ${manifest.native.libreoffice.version}`);
      for (const executable of [nodeExecutable, pythonExecutable]) {
        await run(executable, ["--version"], { env: nodeEnvironment });
      }
      const script = await readFile(new URL("./prepare-runtime.mjs", import.meta.url), "utf8");
      const start = script.indexOf('    await run(nodeExecutable, [path.join(spreadsheetsRoot, "scripts", "create_xlsx.mjs")');
      const end = script.indexOf('    await run(nodeExecutable, [path.join(presentationsRoot, "scripts", "create_pptx.mjs")', start);
      assert.ok(start >= 0 && end > start, "Cannot locate production xlsx smoke block");
      const block = script.slice(start, end);
      assert.ok(block.includes("Recalculation did not cache the expected value"));
      const assertRenderedPages = async (directory, prefix) => {
        assert.ok((await readdir(directory)).some((name) => name.startsWith(prefix) && name.endsWith(".png")));
      };
      const context = { run, path, nodeExecutable, pythonExecutable, spreadsheetsRoot, rowsFile, xlsx, xlsxRenderRoot, recalculatedXlsx, nodeEnvironment, pythonEnvironment, assertRenderedPages };
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await new AsyncFunction(...Object.keys(context), block)(...Object.values(context));
      t.diagnostic("PASS: output A3 formula =A2+8, cached value 50; source formula retained, cache None, bytes unchanged");
    } finally {
      await rm(smokeRoot, { recursive: true, force: true });
    }
  });
}
