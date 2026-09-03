#!/usr/bin/env node

import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const modulesRoot = process.env.HATCH_NODE_MODULES;
if (!modulesRoot) throw new Error("HATCH_NODE_MODULES is required; use the bundled Node runtime.");
const require = createRequire(path.join(modulesRoot, "package.json"));
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const argumentsMap = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[++index];
  if (!key?.startsWith("--") || value === undefined) throw new Error("Usage: create_pdf.mjs --output FILE --text TEXT");
  argumentsMap.set(key.slice(2), value);
}
const output = argumentsMap.get("output");
const text = argumentsMap.get("text");
if (!output || text === undefined) throw new Error("--output and --text are required");

const document = await PDFDocument.create();
const page = document.addPage();
const font = await document.embedFont(StandardFonts.Helvetica);
let y = page.getHeight() - 72;
for (const line of text.split(/\r?\n/)) {
  page.drawText(line.slice(0, 180), { x: 72, y, size: 12, font, color: rgb(0, 0, 0) });
  y -= 16;
}
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, await document.save());
process.stdout.write(`${JSON.stringify({ status: "ok", operation: "create", output })}\n`);
