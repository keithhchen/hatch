import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadProcessor(file, rate = 48000) {
  let Processor;
  class AudioWorkletProcessor {
    constructor() {
      const messages = [];
      this.port = { messages, onmessage: null, postMessage(value) { messages.push(value); } };
    }
  }
  const source = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    AudioWorkletProcessor,
    Float32Array,
    Int16Array,
    ArrayBuffer,
    Math,
    sampleRate: rate,
    registerProcessor(_name, value) { Processor = value; },
  });
  return new Processor();
}

test('voice capture worklet emits exact 20ms 16kHz PCM frames', async () => {
  const processor = await loadProcessor('factory-voice-capture-worklet.js');
  for (let block = 0; block < 15; block += 1) {
    processor.process([[new Float32Array(128).fill(0.5)]], [[new Float32Array(128)]]);
  }
  assert.equal(processor.port.messages.length, 2);
  assert.ok(processor.port.messages.every(frame => frame instanceof ArrayBuffer && frame.byteLength === 640));
  assert.equal(new Int16Array(processor.port.messages[0])[0], 16383);
});

test('voice playback worklet converts 24kHz PCM and drains before ending', async () => {
  const processor = await loadProcessor('factory-voice-playback-worklet.js');
  const pcm = new Int16Array(320).fill(12000);
  processor.port.onmessage({ data: pcm.buffer });
  processor.port.onmessage({ data: { type: 'end' } });
  const blocks = [];
  for (let block = 0; block < 6; block += 1) {
    const output = new Float32Array(128);
    blocks.push(output);
    processor.process([], [[output]]);
  }
  assert.ok(blocks.some(block => block.some(sample => sample > 0.3)));
  assert.deepEqual(processor.port.messages.map(message => message.type), ['playing', 'ended']);
});
