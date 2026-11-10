import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { answerTranscription } from "../registryServer.js";
import { Dictation } from "./dictation.js";
import { VoiceProcessor } from "./processors.js";

const normalizer = { toPcm16k: async (audio: Buffer) => audio };
const dictationOf = (transcribe: (pcm: Buffer) => Promise<{ status: "ok"; text: string } | { status: "unavailable"; reason: string }>) =>
  new Dictation(new VoiceProcessor(normalizer, { transcribe }));

async function post(dictation: Dictation, body: unknown) {
  const server = http.createServer((request, response) => { void answerTranscription(request, response, dictation, "account"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const reply = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: reply.status, body: await reply.json() as { text?: string; error?: { code: string; message: string; reference?: string } } };
  } finally { server.close(); }
}

test("a recording comes back as its transcript", async () => {
  const heard: number[] = [];
  const reply = await post(dictationOf(async pcm => { heard.push(pcm.length); return { status: "ok", text: " 你好 " }; }), { base64: Buffer.from("audio").toString("base64") });
  assert.deepEqual([reply.status, reply.body], [200, { text: "你好" }]);
  assert.deepEqual(heard, [5]);
});

test("no recording, no speech and an oversized recording are the caller's to fix", async () => {
  assert.equal((await post(dictationOf(async () => ({ status: "ok", text: "x" })), {})).status, 400);
  const silent = await post(dictationOf(async () => ({ status: "ok", text: "  " })), { base64: "AAAA" });
  assert.deepEqual([silent.status, silent.body.error?.code], [400, "invalid_audio"]);
  const huge = await post(dictationOf(async () => ({ status: "ok", text: "x" })), { base64: Buffer.alloc(21 * 1024 * 1024).toString("base64") });
  assert.deepEqual([huge.status, huge.body.error?.code], [413, "audio_too_large"]);
});

test("a provider that fails is an upstream_error with a reference and nothing of the provider's words", async () => {
  const reply = await post(dictationOf(async () => ({ status: "unavailable", reason: "429 quota exceeded for sk-secret" })), { base64: "AAAA" });
  assert.equal(reply.status, 502);
  assert.equal(reply.body.error?.code, "upstream_error");
  assert.match(reply.body.error?.reference ?? "", /^err_[0-9a-f]+$/);
  assert.doesNotMatch(JSON.stringify(reply.body), /sk-secret|quota exceeded/);
});
