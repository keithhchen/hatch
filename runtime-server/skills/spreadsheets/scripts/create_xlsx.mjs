#!/usr/bin/env node

import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const modulesRoot = process.env.HATCH_NODE_MODULES;
if (!modulesRoot) throw new Error("HATCH_NODE_MODULES is required; use the bundled Node runtime.");
const require = createRequire(path.join(modulesRoot, "package.json"));
const ExcelJS = require("exceljs");

const values = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[++index];
  if (!key?.startsWith("--") || value === undefined) throw new Error("Usage: create_xlsx.mjs --rows-file JSON --output FILE");
  values.set(key.slice(2), value);
}
const output = values.get("output");
const rowsFile = values.get("rows-file");
if (!output || !rowsFile) throw new Error("--rows-file and --output are required");
const source = JSON.parse(await readFile(rowsFile, "utf8"));
const rows = Array.isArray(source) ? source : source.rows;
if (!Array.isArray(rows)) throw new Error("rows JSON must be an array or { rows: [] }");

const workbook = new ExcelJS.Workbook();
const worksheet = workbook.addWorksheet(String(source.sheet ?? "Sheet1"));
for (const row of rows) worksheet.addRow(row);
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await workbook.xlsx.writeFile(output);
process.stdout.write(`${JSON.stringify({ status: "ok", operation: "create", output, rows: rows.length })}\n`);
