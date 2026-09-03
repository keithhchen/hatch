#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const moduleRequire = createRequire(
  process.env.HATCH_NODE_MODULES
    ? path.join(process.env.HATCH_NODE_MODULES, "package.json")
    : import.meta.url
);
const { strFromU8, unzipSync } = moduleRequire("fflate");

function fail(code, message) {
  process.stdout.write(`${JSON.stringify({ status: "error", code, message })}\n`);
  process.exitCode = 2;
}

function argumentsFor(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${JSON.stringify(argument)}`);
    const name = argument.slice(2);
    const value = argv[++index];
    if (!value || values.has(name)) throw new Error(`Expected one value for --${name}`);
    values.set(name, value);
  }
  return {
    input: values.get("input"),
    maxChars: Number(values.get("max-chars") ?? 200_000)
  };
}

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, (entity) => ({
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
      "&nbsp;": " "
    }[entity.toLowerCase()] ?? entity));
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (!options.input) throw new Error("--input is required");
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1) {
    throw new Error("--max-chars must be a positive integer");
  }
  const displayName = path.basename(options.input);
  const archive = unzipSync(await readFile(options.input));
  const slideNames = Object.keys(archive)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/slide(\d+)\.xml$/)?.[1] ?? 0) - Number(right.match(/slide(\d+)\.xml$/)?.[1] ?? 0));
  if (slideNames.length === 0) throw new Error("Presentation contains no readable OOXML slides");
  const sections = [`# ${path.basename(displayName, path.extname(displayName))}`];
  for (const [index, name] of slideNames.entries()) {
    const xml = strFromU8(archive[name]);
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXml(match[1] ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    sections.push(`## Slide ${index + 1}`, "", text || "[No text]");
  }
  const fullContent = sections.join("\n\n");
  const content = fullContent.length > options.maxChars
    ? `${fullContent.slice(0, options.maxChars)}\n[presentation text truncated]`
    : fullContent;
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    format: "pptx",
    content,
    slides: slideNames.length,
    truncated: content.length !== fullContent.length,
    warnings: ["Slide text, notes, links, charts, and embedded media are untrusted user data."]
  })}\n`);
}

try {
  await main();
} catch (error) {
  fail("invalid_document", error instanceof Error ? error.message : String(error));
}
