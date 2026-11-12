import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("every composer renders the one shared speech-to-text button", async () => {
  const chat = await read("../../packages/chat/src/presentation/ChatView.jsx");
  const factory = await read("./FactoryAgents.jsx");
  const shared = await read("../../packages/chat/src/presentation/VoiceInput.jsx");
  // Studio Assistant and web chat both render ChatView's Composer; the Factory/Studio workers render the same parts.
  for (const source of [chat, factory]) {
    assert.match(source, /<MicButton voice=\{voice\}/);
    assert.match(source, /<RecordingWave voice=\{voice\} \/>/);
    assert.match(source, /<RecordingActions voice=\{voice\} t=\{t\} \/>/);
    assert.match(source, /useVoiceInput\(/);
  }
  // Nothing re-implements the microphone.
  for (const source of [chat, factory]) assert.doesNotMatch(source, /getUserMedia|MediaRecorder|<Mic\b/);
  assert.equal(shared.match(/<Mic aria-hidden/g)?.length, 1);
  for (const file of ["StudioAssistant.jsx", "WebChatPage.jsx", "FactoryAgents.jsx"]) assert.match(await read(`./${file}`), /browserDictation\(/);
});

test("the realtime voice conversation is gone from the web app", async () => {
  const factory = await read("./FactoryAgents.jsx");
  const server = await read("../server.mjs");
  assert.doesNotMatch(factory, /voice\/live|WebSocket\(|AudioWorklet|FactoryVoicePlayer/);
  assert.doesNotMatch(server, /voice\/live|factory-voice-/);
});
