#!/usr/bin/env node

import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const modulesRoot = process.env.HATCH_NODE_MODULES;
if (!modulesRoot) throw new Error("HATCH_NODE_MODULES is required; use the bundled Node runtime.");
const require = createRequire(path.join(modulesRoot, "package.json"));
const PptxGenJS = require("pptxgenjs");

const values = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[++index];
  if (!key?.startsWith("--") || value === undefined) throw new Error("Usage: create_pptx.mjs --slides-file JSON --output FILE");
  values.set(key.slice(2), value);
}
const output = values.get("output");
const slidesFile = values.get("slides-file");
if (!output || !slidesFile) throw new Error("--slides-file and --output are required");
const source = JSON.parse(await readFile(slidesFile, "utf8"));
const slides = Array.isArray(source) ? source : source.slides;
if (!Array.isArray(slides)) throw new Error("slides JSON must be an array or { slides: [] }");

const deck = new PptxGenJS();
deck.layout = "LAYOUT_WIDE";
for (const item of slides) {
  const slide = deck.addSlide();
  slide.addText(String(item.title ?? ""), { x: 0.6, y: 0.45, w: 12, h: 0.55, fontSize: 28, bold: true, color: "1F2937" });
  const bullets = Array.isArray(item.bullets) ? item.bullets : [];
  if (bullets.length) {
    slide.addText(bullets.map((text) => ({ text: String(text), options: { bullet: { indent: 18 } } })), {
      x: 0.85, y: 1.35, w: 11.3, h: 5.1, fontSize: 20, color: "374151", breakLine: true, paraSpaceAfterPt: 12
    });
  }
}
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await deck.writeFile({ fileName: output });
process.stdout.write(`${JSON.stringify({ status: "ok", operation: "create", output, slides: slides.length })}\n`);
