import { WebSocket as ElevenWebSocket } from "ws";
type RuntimeEvent =
  | { type: "run.started"; agent: "interviewer"; conversationId: string; runId: string }
  | { type: "assistant.delta"; agent: "interviewer"; conversationId: string; runId: string; content: string }
  | { type: "tool.call"; agent: "interviewer"; conversationId: string; runId: string }
  | { type: "tool.result"; agent: "interviewer"; conversationId: string; runId: string }
  | { type: "run.completed"; agent: "interviewer"; conversationId: string; runId: string }
  | { type: "run.interrupted" | "run.failed"; agent: "interviewer"; conversationId: string; runId: string };

export const ELEVEN_VOICE_PROFILE = {
  id: "eleven-v3-conversational",
  sttModel: "scribe_v2_realtime",
  ttsModel: "eleven_v3_conversational",
  audioFormat: "mp3_44100_128",
  sttAudioFormat: "pcm_16000"
} as const;

export type ElevenVoiceProfile = typeof ELEVEN_VOICE_PROFILE;

export function resolveVoiceProfile(): ElevenVoiceProfile { return ELEVEN_VOICE_PROFILE; }

export type VoiceServerEvent =
  | { type: "voice.started"; conversationId: string; sttModel: string; ttsModel: string; audioFormat: string }
  | { type: "voice.stopped"; conversationId: string }
  | { type: "voice.user_speaking"; conversationId: string }
  | { type: "voice.transcript.partial"; conversationId: string; text: string }
  | { type: "voice.transcript.final"; conversationId: string; text: string }
  | { type: "voice.speech.start"; conversationId: string; runId: string; segmentId: string; text: string }
  | { type: "voice.speech.end"; conversationId: string; runId: string; segmentId: string }
  | { type: "voice.audio.start"; conversationId: string; runId: string; mimeType: string }
  | { type: "voice.audio.chunk"; conversationId: string; runId: string; sequence: number; segmentId: string; audio: string }
  | { type: "voice.audio.end"; conversationId: string; runId: string }
  | { type: "voice.error"; conversationId?: string; message: string };

type VoiceSessionOptions = {
  emit: (event: VoiceServerEvent) => void;
  onFinalTranscript: (conversationId: string, text: string) => Promise<void>;
  onInterrupt: (runId: string) => Promise<void>;
  apiKey?: string;
  voiceId?: string;
  languageCode?: string;
  profile?: ElevenVoiceProfile;
};

type SpeechBoundary = {
  index: number;
  length: number;
};

/** Keeps punctuation-aware speech chunks separate from the canonical assistant message. */
export class SpeechSegmenter {
  private pending = "";

  push(delta: string): string[] {
    this.pending += delta;
    return this.drain(false);
  }

  finish(): string[] {
    return this.drain(true);
  }

  private drain(force: boolean): string[] {
    const chunks: string[] = [];
    while (this.pending) {
      const boundary = findSpeechBoundary(this.pending);
      let cut = boundary ? boundary.index + boundary.length : 0;
      if (!cut && this.pending.length >= 120) cut = findLengthCut(this.pending, 120);
      if (!cut && !force) break;
      if (!cut) cut = this.pending.length;
      const raw = this.pending.slice(0, cut);
      this.pending = this.pending.slice(cut);
      const text = speechText(raw);
      if (text) chunks.push(text);
    }
    return chunks;
  }
}

/** One browser conversation owns one STT session and lazily-created TTS sessions. */
export class VoiceSession {
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly emit: VoiceSessionOptions["emit"];
  private readonly onFinalTranscript: VoiceSessionOptions["onFinalTranscript"];
  private readonly onInterrupt: VoiceSessionOptions["onInterrupt"];
  private readonly languageCode?: string;
  private readonly profile: ElevenVoiceProfile;
  private stt?: ElevenScribeRealtime;
  private tts?: ElevenTtsSocket;
  private conversationId = "";
  private activeRunId = "";
  private speechStarted = false;
  private interruptPromise: Promise<void> = Promise.resolve();
  private speechSegmenter = new SpeechSegmenter();
  private ttsQueue: Promise<void> = Promise.resolve();
  private ttsGeneration = 0;
  private ttsSequence = 0;
  private ttsAudioStarted = false;
  private speechSegmentSequence = 0;
  private activeSpeechSegment?: { id: string; text: string };
  private currentSpeechSegmentId?: string;
  private completedSpeechSegments = new Set<string>();
  private interruptionTimer?: ReturnType<typeof setTimeout>;
  private toolActive = false;

  constructor(options: VoiceSessionOptions) {
    this.apiKey = options.apiKey?.trim() || process.env.ELEVENLABS_API_KEY?.trim() || "";
    this.voiceId = options.voiceId?.trim() || process.env.ELEVENLABS_VOICE_ID?.trim() || "";
    this.emit = options.emit;
    this.onFinalTranscript = options.onFinalTranscript;
    this.onInterrupt = options.onInterrupt;
    this.languageCode = options.languageCode;
    this.profile = options.profile ?? resolveVoiceProfile();
  }

  async start(conversationId: string): Promise<void> {
    if (!this.apiKey) throw new Error("Missing ELEVENLABS_API_KEY");
    if (!this.voiceId) throw new Error("Missing ELEVENLABS_VOICE_ID");
    await this.stop();
    this.conversationId = conversationId;
    this.stt = new ElevenScribeRealtime({
      apiKey: this.apiKey,
      languageCode: this.languageCode,
      onPartial: (text) => void this.handlePartial(text),
      onCommitted: (text) => void this.handleCommitted(text),
      onError: (error) => this.report(error)
    });
    await this.stt.start();
    this.emit({
      type: "voice.started",
      conversationId,
      sttModel: this.profile.sttModel,
      ttsModel: this.profile.ttsModel,
      audioFormat: this.profile.audioFormat
    });
  }

  async stop(): Promise<void> {
    this.stt?.close();
    this.stt = undefined;
    this.invalidateTts();
    if (this.conversationId) this.emit({ type: "voice.stopped", conversationId: this.conversationId });
    this.conversationId = "";
    this.activeRunId = "";
    this.speechStarted = false;
    if (this.interruptionTimer) clearTimeout(this.interruptionTimer);
    this.interruptionTimer = undefined;
    this.toolActive = false;
  }

  audio(chunk: Buffer): void {
    this.stt?.sendAudio(chunk);
  }

  handleRuntimeEvent(event: RuntimeEvent): void {
    if (!this.conversationId || event.conversationId !== this.conversationId || event.agent !== "interviewer") return;
    if (event.type === "run.started") {
      this.activeRunId = event.runId;
      this.speechSegmenter = new SpeechSegmenter();
      this.speechSegmentSequence = 0;
      this.activeSpeechSegment = undefined;
      this.completedSpeechSegments.clear();
      this.toolActive = false;
      return;
    }
    if (event.type === "assistant.delta") {
      if (this.toolActive || !this.activeRunId || event.runId !== this.activeRunId) return;
      const segments = this.speechSegmenter.push(event.content);
      this.enqueueSpeech(event.runId, segments);
      return;
    }
    if (event.type === "tool.call") {
      if (event.runId === this.activeRunId) {
        this.toolActive = true;
        this.invalidateTts();
      }
      return;
    }
    if (event.type === "tool.result") {
      if (event.runId === this.activeRunId) this.toolActive = false;
      return;
    }
    if (event.type === "run.completed") {
      if (event.runId !== this.activeRunId) return;
      const segments = this.speechSegmenter.finish();
      this.enqueueSpeech(event.runId, segments);
      const queue = this.ttsQueue;
      const generation = this.ttsGeneration;
      this.ttsQueue = Promise.resolve();
      void queue.then(() => this.finishSpeech(event.runId, generation)).catch((error) => this.report(error));
      this.activeRunId = "";
      return;
    }
    if (event.type === "run.interrupted" || event.type === "run.failed") {
      if (event.runId === this.activeRunId) {
        this.invalidateTts();
        this.activeRunId = "";
      }
    }
  }

  private async handlePartial(text: string): Promise<void> {
    if (!this.conversationId) return;
    this.emit({ type: "voice.transcript.partial", conversationId: this.conversationId, text });
    if (!this.speechStarted && isMeaningfulInterruptionText(text)) {
      this.speechStarted = true;
      this.emit({ type: "voice.user_speaking", conversationId: this.conversationId });
      this.invalidateTts();
    }
    if (this.speechStarted && this.activeRunId && !this.interruptionTimer) {
      const runId = this.activeRunId;
      this.interruptionTimer = setTimeout(() => {
        this.interruptionTimer = undefined;
        if (this.activeRunId !== runId) return;
        this.interruptPromise = this.onInterrupt(runId).catch((error) => this.report(error));
      }, 240);
    }
  }

  private async handleCommitted(text: string): Promise<void> {
    const conversationId = this.conversationId;
    const finalText = text.trim();
    if (!conversationId || !finalText) return;
    this.emit({ type: "voice.transcript.final", conversationId, text: finalText });
    await this.interruptPromise;
    this.speechStarted = false;
    await this.onFinalTranscript(conversationId, finalText).catch((error) => this.report(error));
  }

  private enqueueSpeech(runId: string, segments: string[]): void {
    if (!segments.length || this.toolActive || !this.conversationId) return;
    const generation = this.ttsGeneration;
    this.ttsQueue = this.ttsQueue.catch(() => undefined).then(async () => {
      if (generation !== this.ttsGeneration || this.toolActive || !this.conversationId) return;
      if (!this.tts || this.tts.runId !== runId) {
        this.tts?.close();
        this.tts = new ElevenTtsSocket({
          apiKey: this.apiKey,
          voiceId: this.voiceId,
          runId,
          profile: this.profile,
          onAudio: (audio) => this.handleAudio(runId, generation, audio),
          onTurnFinal: () => this.handleSpeechTurnEnd(runId, generation),
          onFinal: () => this.handleAudioEnd(runId, generation),
          onError: (error) => this.report(error)
        });
        await this.tts.start();
      }
      for (const text of segments) {
        if (generation !== this.ttsGeneration || this.toolActive) return;
        const segment = { id: `${runId}:${this.speechSegmentSequence++}`, text };
        this.activeSpeechSegment = segment;
        await this.tts.send(text);
      }
    });
  }

  private async finishSpeech(runId: string, generation: number): Promise<void> {
    if (generation !== this.ttsGeneration || !this.tts || this.tts.runId !== runId) return;
    await this.tts.finish();
    this.tts = undefined;
  }

  private handleAudio(runId: string, generation: number, audio: Buffer): void {
    if (generation !== this.ttsGeneration || !this.conversationId || !audio.length) return;
    if (!this.ttsAudioStarted) {
      this.ttsAudioStarted = true;
      this.ttsSequence = 0;
      this.emit({ type: "voice.audio.start", conversationId: this.conversationId, runId, mimeType: "audio/mpeg" });
    }
    if (this.activeSpeechSegment && !this.completedSpeechSegments.has(this.activeSpeechSegment.id) && this.activeSpeechSegment.id !== this.currentSpeechSegmentId) {
      if (this.currentSpeechSegmentId) {
        this.emit({ type: "voice.speech.end", conversationId: this.conversationId, runId, segmentId: this.currentSpeechSegmentId });
        this.completedSpeechSegments.add(this.currentSpeechSegmentId);
      }
      this.currentSpeechSegmentId = this.activeSpeechSegment.id;
      this.emit({ type: "voice.speech.start", conversationId: this.conversationId, runId, segmentId: this.activeSpeechSegment.id, text: this.activeSpeechSegment.text });
    }
    this.emit({
      type: "voice.audio.chunk",
      conversationId: this.conversationId,
      runId,
      sequence: this.ttsSequence++,
      segmentId: this.currentSpeechSegmentId ?? this.activeSpeechSegment?.id ?? "",
      audio: audio.toString("base64")
    });
  }

  private handleAudioEnd(runId: string, generation: number): void {
    if (generation !== this.ttsGeneration || !this.conversationId) return;
    if (this.currentSpeechSegmentId) {
      const segmentId = this.currentSpeechSegmentId;
      this.emit({ type: "voice.speech.end", conversationId: this.conversationId, runId, segmentId });
      this.completedSpeechSegments.add(segmentId);
      this.currentSpeechSegmentId = undefined;
    }
    if (this.ttsAudioStarted) this.emit({ type: "voice.audio.end", conversationId: this.conversationId, runId });
    this.ttsAudioStarted = false;
  }

  private handleSpeechTurnEnd(runId: string, generation: number): void {
    if (generation !== this.ttsGeneration || !this.conversationId || !this.currentSpeechSegmentId) return;
    const segmentId = this.currentSpeechSegmentId;
    this.emit({ type: "voice.speech.end", conversationId: this.conversationId, runId, segmentId });
    this.completedSpeechSegments.add(segmentId);
    this.currentSpeechSegmentId = undefined;
  }

  private invalidateTts(): void {
    this.ttsGeneration += 1;
    this.ttsQueue = Promise.resolve();
    this.tts?.close();
    this.tts = undefined;
    this.ttsAudioStarted = false;
    this.activeSpeechSegment = undefined;
    this.currentSpeechSegmentId = undefined;
    this.completedSpeechSegments.clear();
  }

  private report(error: unknown): void {
    if (error instanceof Error && error.message === "TTS cancelled") return;
    this.emit({
      type: "voice.error",
      ...(this.conversationId ? { conversationId: this.conversationId } : {}),
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

class ElevenScribeRealtime {
  private socket?: ElevenWebSocket;
  private ready: Promise<void> = Promise.resolve();
  private cancelled = false;

  constructor(private readonly options: {
    apiKey: string;
    languageCode?: string;
    onPartial: (text: string) => void;
    onCommitted: (text: string) => void;
    onError: (error: unknown) => void;
  }) {}

  start(): Promise<void> {
    this.cancelled = false;
    const params = new URLSearchParams({
      model_id: ELEVEN_VOICE_PROFILE.sttModel,
      audio_format: ELEVEN_VOICE_PROFILE.sttAudioFormat,
      commit_strategy: "vad",
      vad_silence_threshold_secs: "0.8"
    });
    if (this.options.languageCode) params.set("language_code", this.options.languageCode);
    const socket = new ElevenWebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`, {
      headers: { "xi-api-key": this.options.apiKey }
    });
    this.socket = socket;
    this.ready = new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        if (this.cancelled) {
          socket.close();
          resolve();
          return;
        }
        resolve();
      });
      socket.once("error", (error) => {
        if (this.cancelled) resolve();
        else reject(error);
      });
    });
    socket.on("message", (raw) => {
      if (this.cancelled) return;
      try {
        const message = JSON.parse(raw.toString()) as { message_type?: string; text?: string; error?: string };
        if (message.message_type === "partial_transcript" && message.text) this.options.onPartial(message.text);
        if (message.message_type === "committed_transcript" && message.text) this.options.onCommitted(message.text);
        if (message.error) this.options.onError(new Error(message.error));
      } catch (error) {
        this.options.onError(error);
      }
    });
    socket.on("error", (error) => {
      if (!this.cancelled) this.options.onError(error);
    });
    return this.ready;
  }

  sendAudio(chunk: Buffer): void {
    if (this.cancelled || !this.socket || this.socket.readyState !== ElevenWebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: chunk.toString("base64") }));
  }

  close(): void {
    this.cancelled = true;
    closeElevenSocket(this.socket);
    this.socket = undefined;
  }
}

class ElevenTtsSocket {
  readonly runId: string;
  private socket?: ElevenWebSocket;
  private ready: Promise<void> = Promise.resolve();
  private final: Promise<void> = Promise.resolve();
  private resolveFinal?: () => void;
  private resolveTurnFinal?: () => void;
  private turnError?: Error;
  private cancelled = false;

  constructor(private readonly options: {
    apiKey: string;
    voiceId: string;
    runId: string;
    profile: ElevenVoiceProfile;
    onAudio: (audio: Buffer) => void;
    onTurnFinal: () => void;
    onFinal: () => void;
    onError: (error: unknown) => void;
  }) {
    this.runId = options.runId;
  }

  start(): Promise<void> {
    this.cancelled = false;
    const params = new URLSearchParams({ model_id: this.options.profile.ttsModel, output_format: this.options.profile.audioFormat });
    const endpoint = `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?${params}`;
    const socket = new ElevenWebSocket(endpoint, {
      headers: { "xi-api-key": this.options.apiKey }
    });
    this.socket = socket;
    this.ready = new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        if (this.cancelled) {
          socket.close();
          resolve();
          return;
        }
        socket.send(JSON.stringify({
          voices: [this.options.voiceId],
          voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1.1 }
        }));
        resolve();
      });
      socket.once("error", (error) => {
        if (this.cancelled) resolve();
        else reject(error);
      });
    });
    this.final = new Promise<void>((resolve) => {
      this.resolveFinal = resolve;
    });
    socket.on("message", (raw) => {
      if (this.cancelled) return;
      try {
        const message = JSON.parse(raw.toString()) as { audio?: string; is_final?: boolean; isFinal?: boolean; is_final_audio_for_turn?: boolean; error?: string };
        if (message.audio) {
          this.options.onAudio(Buffer.from(message.audio, "base64"));
        }
        if (message.error) {
          const error = new Error(message.error);
          this.turnError = error;
          this.resolveTurnFinal?.();
          this.resolveTurnFinal = undefined;
          this.resolveFinal?.();
          this.options.onError(error);
        }
        if (message.is_final_audio_for_turn) {
          this.resolveTurnFinal?.();
          this.resolveTurnFinal = undefined;
          this.options.onTurnFinal();
        }
        if (message.is_final || message.isFinal) {
          this.resolveTurnFinal?.();
          this.resolveTurnFinal = undefined;
          this.options.onFinal();
          this.resolveFinal?.();
        }
      } catch (error) {
        this.turnError = error instanceof Error ? error : new Error(String(error));
        this.resolveTurnFinal?.();
        this.resolveTurnFinal = undefined;
        this.resolveFinal?.();
        this.options.onError(error);
      }
    });
    socket.on("error", (error) => {
      if (!this.cancelled) this.options.onError(error);
    });
    return this.ready;
  }

  async send(text: string): Promise<void> {
    await this.ready;
    if (this.cancelled) return;
    if (!this.socket || this.socket.readyState !== ElevenWebSocket.OPEN) throw new Error("ElevenLabs TTS socket is not open");
    this.turnError = undefined;
    const turnFinal = new Promise<void>((resolve) => { this.resolveTurnFinal = resolve; });
    this.socket.send(JSON.stringify({ inputs: [{ text, voice_id: this.options.voiceId, new_turn: true }], flush: true }));
    await turnFinal;
    if (this.turnError) throw this.turnError;
  }

  async finish(): Promise<void> {
    await this.ready;
    if (this.cancelled) return;
    if (!this.socket || this.socket.readyState !== ElevenWebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ close_socket: true }));
    await this.final;
    closeElevenSocket(this.socket);
    this.socket = undefined;
  }

  close(): void {
    this.cancelled = true;
    this.resolveTurnFinal?.();
    this.resolveTurnFinal = undefined;
    this.resolveFinal?.();
    closeElevenSocket(this.socket);
    this.socket = undefined;
  }
}

function closeElevenSocket(socket?: ElevenWebSocket): void {
  if (!socket) return;
  if (socket.readyState === ElevenWebSocket.CONNECTING) {
    socket.once("open", () => {
      if (socket.readyState === ElevenWebSocket.OPEN) socket.close();
    });
    return;
  }
  if (socket.readyState === ElevenWebSocket.OPEN || socket.readyState === ElevenWebSocket.CLOSING) socket.close();
}

function findSpeechBoundary(text: string): SpeechBoundary | undefined {
  for (let index = 0; index < text.length; index += 1) {
    if (!/[。！？；.!?;]/.test(text[index] ?? "")) continue;
    let length = 1;
    while (index + length < text.length && /[\s\"'”’）)】\]]/.test(text[index + length] ?? "")) length += 1;
    return { index, length };
  }
  return undefined;
}

export function isMeaningfulInterruptionText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const cjkCount = (normalized.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latinCount = (normalized.match(/[A-Za-z]/g) ?? []).length;
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return cjkCount >= 2 || latinCount >= 3 || wordCount >= 2;
}

function findLengthCut(text: string, max: number): number {
  const prefix = text.slice(0, max);
  const match = prefix.match(/[，,、\s](?![\s\S]*[，,、\s])/);
  return match?.index && match.index > 20 ? match.index + 1 : max;
}

function speechText(input: string): string {
  if (!input.trim() || /```[\s\S]*```/.test(input) || input.includes("```") && !input.slice(input.indexOf("```") + 3).includes("```")) return "";
  return input
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+] |\d+\. )/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
