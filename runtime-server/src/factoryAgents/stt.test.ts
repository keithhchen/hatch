import assert from "node:assert/strict";
import test from "node:test";
import { createStreamingSttProvider, qwenStartTask } from "./stt.js";

const callbacks = { onPartial() {}, onCommitted() {}, onError() {} };

test("Factory STT defaults to multilingual Qwen without a language hint", () => {
  const provider = createStreamingSttProvider({
    ...callbacks,
    environment: { DASHSCOPE_API_KEY: "test-key" }
  });
  assert.equal(provider.model, "qwen-audio-3.0-asr-flash-streaming");
  const command = qwenStartTask("00000000-0000-4000-8000-000000000000", provider.model);
  assert.equal(command.payload.parameters.max_sentence_silence, 1800);
  assert.equal(command.payload.parameters.speech_noise_threshold, 0.2);
  assert.equal(Object.hasOwn(command.payload.parameters, "language_hints"), false);
});

test("Factory STT provider remains an explicit replaceable server setting", () => {
  const provider = createStreamingSttProvider({
    ...callbacks,
    environment: { HATCH_FACTORY_STT_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "test-key" }
  });
  assert.equal(provider.model, "scribe_v2_realtime");
  assert.throws(
    () => createStreamingSttProvider({ ...callbacks, environment: { HATCH_FACTORY_STT_PROVIDER: "unknown" } }),
    /Unsupported Factory STT provider/
  );
});
