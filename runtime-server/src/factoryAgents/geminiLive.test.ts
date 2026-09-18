import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { GoogleGenAI, LiveServerMessage } from "@google/genai";
import { GeminiLiveSession, GEMINI_LIVE_INPUT_MIME } from "./geminiLive.js";

test("Gemini Live config uses native audio, transcription, tools, compression and resumption", async () => {
  const harness = fakeClient();
  const session = new GeminiLiveSession({
    apiKey: "test-key",
    client: harness.client,
    systemPrompt: "Interview the Creator and preserve tacit judgment.",
    voiceName: "Aoede",
    resumptionHandle: "resume-1",
    tools: [{
      name: "read",
      label: "Read",
      description: "Read one workspace file.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "contents" }], details: { path: "output/a.md" } }),
    }],
  });

  await session.start();
  assert.equal(harness.connect.model, "gemini-3.8-live");
  assert.deepEqual(harness.connect.config.responseModalities, ["AUDIO"]);
  assert.equal(harness.connect.config.thinkingConfig, undefined);
  assert.deepEqual(harness.connect.config.inputAudioTranscription, {});
  assert.deepEqual(harness.connect.config.outputAudioTranscription, {});
  assert.equal(harness.connect.config.contextWindowCompression.triggerTokens, "25000");
  assert.equal(harness.connect.config.contextWindowCompression.slidingWindow.targetTokens, "8000");
  assert.equal(harness.connect.config.sessionResumption.handle, "resume-1");
  assert.equal(harness.connect.config.tools[0].functionDeclarations[0].name, "read");
  assert.equal(harness.connect.config.tools[0].functionDeclarations[0].behavior, "BLOCKING");

  session.sendAudio(Buffer.from([1, 2, 3]));
  assert.deepEqual(harness.realtime[0], {
    audio: { data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: GEMINI_LIVE_INPUT_MIME },
  });
  const finishing = session.finishAudio();
  assert.deepEqual(harness.realtime[1], { audioStreamEnd: true });
  await harness.message({ serverContent: { turnComplete: true } });
  await finishing;
});

test("Gemini Live maps transcripts, PCM audio, interruption, tools and resumption", async () => {
  const harness = fakeClient();
  const observed = {
    input: [] as Array<{ text: string; final: boolean }>,
    output: [] as Array<{ text: string; delta: string; final: boolean }>,
    audio: [] as Buffer[],
    audioEnds: 0,
    interrupted: 0,
    handles: [] as string[],
    tools: [] as string[],
  };
  const session = new GeminiLiveSession({
    apiKey: "test-key",
    client: harness.client,
    systemPrompt: "Interview the Creator.",
    tools: [{
      name: "write",
      label: "Write",
      description: "Write evidence.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id, raw) => ({ content: [{ type: "text", text: "saved" }], details: raw }),
    }],
    onInputTranscript: value => { observed.input.push(value); },
    onOutputTranscript: value => { observed.output.push(value); },
    onAudio: value => { observed.audio.push(value); },
    onAudioEnd: () => { observed.audioEnds += 1; },
    onInterrupted: () => { observed.interrupted += 1; },
    onResumptionHandle: value => { observed.handles.push(value); },
    onToolStart: value => { observed.tools.push(`start:${value.name}`); },
    onToolEnd: value => { observed.tools.push(`end:${value.name}:${value.isError}`); },
  });
  await session.start();

  await harness.message({ sessionResumptionUpdate: { resumable: true, newHandle: "resume-2" } });
  await harness.message({ serverContent: { inputTranscription: { text: "你好", finished: false } } });
  await harness.message({ serverContent: { inputTranscription: { text: "，世界", finished: true } } });
  await harness.message({ serverContent: { outputTranscription: { text: "欢迎", finished: false }, modelTurn: { role: "model", parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from([4, 5]).toString("base64") } }] } } });
  await harness.message({ serverContent: { outputTranscription: { text: "回来", finished: true }, generationComplete: true } });
  await harness.message({ toolCall: { functionCalls: [{ id: "call-1", name: "write", args: { path: "output/a.md", content: "evidence" } }] } });
  await harness.message({ serverContent: { interrupted: true } });

  assert.deepEqual(observed.handles, ["resume-2"]);
  assert.deepEqual(observed.input, [{ text: "你好", final: false }, { text: "你好，世界", final: true }]);
  assert.deepEqual(observed.output, [{ text: "欢迎", delta: "欢迎", final: false }, { text: "欢迎回来", delta: "回来", final: true }]);
  assert.deepEqual(observed.audio.map(value => [...value]), [[4, 5]]);
  assert.equal(observed.audioEnds, 1);
  assert.equal(observed.interrupted, 1);
  assert.deepEqual(observed.tools, ["start:write", "end:write:false"]);
  assert.equal(harness.toolResponses[0].functionResponses[0].id, "call-1");
  assert.equal(harness.toolResponses[0].functionResponses[0].response.output.text, "saved");
});

test("Gemini Live finalizes transcripts at the turn boundary when finished flags are absent", async () => {
  const harness = fakeClient();
  const input: Array<{ text: string; final: boolean }> = [];
  const output: Array<{ text: string; final: boolean }> = [];
  const session = new GeminiLiveSession({
    apiKey: "test-key",
    client: harness.client,
    systemPrompt: "Interview the Creator.",
    tools: [],
    onInputTranscript: value => { input.push(value); },
    onOutputTranscript: value => { output.push(value); },
  });
  await session.start();
  await harness.message({ serverContent: { inputTranscription: { text: "spoken evidence" } } });
  await harness.message({ serverContent: { outputTranscription: { text: "follow-up question" }, turnComplete: true } });
  assert.deepEqual(input.at(-1), { text: "spoken evidence", final: true });
  assert.deepEqual(output.at(-1), { text: "follow-up question", delta: "", final: true });
});

test("Gemini Live reconnects GoAway with the latest session resumption handle", async () => {
  const harness = fakeClient();
  const session = new GeminiLiveSession({
    apiKey: "test-key",
    client: harness.client,
    systemPrompt: "Interview the Creator.",
    tools: [],
  });
  await session.start();
  await harness.message({ sessionResumptionUpdate: { resumable: true, newHandle: "resume-latest" } });
  await harness.message({ goAway: { timeLeft: "5s" } });
  for (let attempt = 0; attempt < 20 && harness.connections.length < 2; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(harness.connections.length, 2);
  assert.equal(harness.connections[1].config.sessionResumption.handle, "resume-latest");
  session.close();
});

function fakeClient() {
  let onmessage: ((message: LiveServerMessage) => void) | undefined;
  const realtime: unknown[] = [];
  const toolResponses: any[] = [];
  const connections: any[] = [];
  const connect: any = {};
  const liveSession = {
    sendRealtimeInput(value: unknown) { realtime.push(value); },
    sendToolResponse(value: unknown) { toolResponses.push(value); },
    close() {},
  };
  const client = {
    live: {
      async connect(value: any) {
        Object.assign(connect, value);
        connections.push(value);
        onmessage = value.callbacks.onmessage;
        queueMicrotask(() => onmessage?.({ setupComplete: {} } as LiveServerMessage));
        return liveSession;
      },
    },
  } as unknown as GoogleGenAI;
  return {
    client,
    connect,
    realtime,
    toolResponses,
    connections,
    message: async (value: Partial<LiveServerMessage>) => {
      onmessage?.(value as LiveServerMessage);
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}
