import assert from "node:assert/strict";
import test from "node:test";
import { ELEVEN_VOICE_PROFILE, isMeaningfulInterruptionText, resolveVoiceProfile, SpeechSegmenter } from "./voice.js";

test("voice profile is fixed to conversational v3", () => {
  assert.equal(resolveVoiceProfile().id, ELEVEN_VOICE_PROFILE.id);
  assert.equal(resolveVoiceProfile().ttsModel, "eleven_v3_conversational");
});

test("speech segmenter waits for a complete sentence", () => {
  const segmenter = new SpeechSegmenter();
  assert.deepEqual(segmenter.push("你好"), []);
  assert.deepEqual(segmenter.push("，我想先"), []);
  assert.deepEqual(segmenter.push("听听你的经历。"), ["你好，我想先听听你的经历。"]);

  const multiple = new SpeechSegmenter();
  assert.deepEqual(multiple.push("第一句。第二句。"), ["第一句。", "第二句。"]);
});

test("speech segmenter removes markdown and skips fenced code", () => {
  const segmenter = new SpeechSegmenter();
  assert.deepEqual(segmenter.push("这是一个**重点**。"), ["这是一个重点。"]);

  const english = new SpeechSegmenter();
  assert.deepEqual(english.push("How's it going? I'm glad you're here."), ["How's it going?", "I'm glad you're here."]);

  const code = new SpeechSegmenter();
  assert.deepEqual(code.push("```ts\nconst answer = 42;\n```"), []);
  assert.deepEqual(code.finish(), []);
});

test("interruption requires meaningful partial speech", () => {
  assert.equal(isMeaningfulInterruptionText("嗯"), false);
  assert.equal(isMeaningfulInterruptionText("我想"), true);
  assert.equal(isMeaningfulInterruptionText("I"), false);
  assert.equal(isMeaningfulInterruptionText("I think"), true);
});

