#!/usr/bin/env node

import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const modulesRoot = process.env.HATCH_NODE_MODULES;
if (!modulesRoot) throw new Error("HATCH_NODE_MODULES is required; use the bundled Node runtime.");
const require = createRequire(path.join(modulesRoot, "package.json"));
const { Document, HeadingLevel, Packer, Paragraph } = require("docx");

const values = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[++index];
  if (!key?.startsWith("--") || value === undefined) throw new Error("Usage: create_docx.mjs --output FILE --title TITLE --paragraph TEXT");
  const name = key.slice(2);
  if (name === "paragraph") values.set(name, [...(values.get(name) ?? []), value]);
  else values.set(name, value);
}
const output = values.get("output");
if (!output) throw new Error("--output is required");
const paragraphs = values.get("paragraph") ?? [];
const children = [];
if (values.has("title")) children.push(new Paragraph({ text: String(values.get("title")), heading: HeadingLevel.TITLE }));
for (const text of paragraphs) children.push(new Paragraph(String(text)));
const document = new Document({ sections: [{ children }] });
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, await Packer.toBuffer(document));
process.stdout.write(`${JSON.stringify({ status: "ok", operation: "create", output, paragraphs: paragraphs.length })}\n`);
