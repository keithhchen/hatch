import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { extractAgentCorpusBundle } from "./registryCorpus.js";

test("Agent Corpus rejects declared ZIP expansion before inflating the entry", async () => {
  const archive = zipSync({
    "knowledge/oversized.md": strToU8("x"),
    "agent.json": strToU8("{}"),
  });
  const centralDirectory = findSignature(archive, 0x02014b50);
  assert.notEqual(centralDirectory, -1);
  new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    .setUint32(centralDirectory + 24, 17 * 1024 * 1024, true);
  const destination = await mkdtemp(path.join(os.tmpdir(), "hatch-corpus-zip-bomb-"));

  await assert.rejects(
    extractAgentCorpusBundle(archive, destination),
    /expands beyond the size limit/
  );
});

test("Agent Corpus rejects an oversized manifest and excessive zero-byte entries from ZIP metadata", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "hatch-corpus-bounds-"));
  await assert.rejects(
    extractAgentCorpusBundle(zipSync({ "agent.json": strToU8("x".repeat(1024 * 1024 + 1)) }), destination),
    /manifest is too large/,
  );

  const entries: Record<string, Uint8Array> = { "agent.json": strToU8("{}") };
  for (let index = 0; index < 256; index += 1) entries[`empty/${index}.txt`] = new Uint8Array();
  await assert.rejects(
    extractAgentCorpusBundle(zipSync(entries), destination),
    /invalid file count/,
  );
});

function findSignature(bytes: Uint8Array, signature: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  return -1;
}
