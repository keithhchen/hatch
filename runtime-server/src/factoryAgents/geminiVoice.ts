import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { GeminiLiveSession, GEMINI_LIVE_MODEL, GEMINI_LIVE_OUTPUT_MIME } from "./geminiLive.js";
import type { VoiceServerEvent } from "./voice.js";

export type GeminiVoiceSessionOptions = {
  environment?: NodeJS.ProcessEnv;
  emit: (event: VoiceServerEvent) => void;
  prepare: (conversationId: string) => Promise<{ systemPrompt: string; tools: AgentTool[]; resumptionHandle?: string }>;
  onUserTranscript: (conversationId: string, text: string) => Promise<void>;
  onAssistantTranscript: (conversationId: string, text: string) => Promise<void>;
  onToolStart: (conversationId: string, value: { id: string; name: string; args: Record<string, unknown> }) => Promise<void>;
  onToolEnd: (conversationId: string, value: { id: string; name: string; result: AgentToolResult<unknown>; isError: boolean }) => Promise<void>;
  onResumptionHandle: (conversationId: string, handle: string) => Promise<void>;
  onStopped: (conversationId: string) => Promise<void>;
};

/** Adapts native Gemini Live events to Hatch's stable Voice event contract. */
export class GeminiVoiceSession {
  private readonly environment: NodeJS.ProcessEnv;
  private live?: GeminiLiveSession;
  private conversationId = "";
  private runId = "";
  private segmentId = "";
  private audioStarted = false;
  private sequence = 0;
  private assistantText = "";
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private stopping?: Promise<void>;

  constructor(private readonly options: GeminiVoiceSessionOptions) {
    this.environment = options.environment ?? process.env;
  }

  async start(conversationId: string): Promise<void> {
    await this.stop();
    const apiKey = this.environment.GEMINI_API_KEY?.trim() || "";
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");
    this.conversationId = conversationId;
    let prepared: Awaited<ReturnType<GeminiVoiceSessionOptions["prepare"]>>;
    try {
      prepared = await this.options.prepare(conversationId);
    } catch (error) {
      this.conversationId = "";
      throw error;
    }
    const model = this.environment.HATCH_FACTORY_LIVE_MODEL?.trim() || GEMINI_LIVE_MODEL;
    this.live = new GeminiLiveSession({
      apiKey,
      model,
      voiceName: this.environment.HATCH_FACTORY_LIVE_VOICE,
      systemPrompt: prepared.systemPrompt,
      tools: prepared.tools,
      resumptionHandle: prepared.resumptionHandle,
      onInputTranscript: value => this.handleInputTranscript(value.text, value.final),
      onOutputTranscript: value => this.handleOutputTranscript(value.text, value.delta, value.final),
      onAudio: audio => this.handleAudio(audio),
      onAudioEnd: () => this.finishAudio(),
      onInterrupted: () => this.interrupt(),
      onToolStart: value => this.options.onToolStart(this.conversationId, value),
      onToolEnd: value => this.options.onToolEnd(this.conversationId, value),
      onResumptionHandle: handle => this.options.onResumptionHandle(this.conversationId, handle),
      onError: error => this.report(error),
    });
    try {
      for (const chunk of this.pendingAudio.splice(0)) this.live.sendAudio(chunk);
      this.pendingAudioBytes = 0;
      await this.live.start();
      if (this.conversationId === conversationId) {
        this.options.emit({
          type: "voice.started",
          conversationId,
          sttModel: model,
          ttsModel: model,
          audioFormat: "pcm_24000",
        });
      }
    } catch (error) {
      this.live?.close();
      this.live = undefined;
      this.conversationId = "";
      this.pendingAudio = [];
      this.pendingAudioBytes = 0;
      throw error;
    }
  }

  audio(chunk: Buffer): void {
    if (!chunk.length || !this.conversationId) return;
    if (this.live) { this.live.sendAudio(chunk); return; }
    this.pendingAudioBytes += chunk.length;
    if (this.pendingAudioBytes > 512 * 1024) throw new Error("Gemini voice startup audio buffer exceeded");
    this.pendingAudio.push(Buffer.from(chunk));
  }

  handleRuntimeEvent(): void {
    // Native Live owns the interviewer turn. Text Runtime voice events must not
    // create a second model loop or synthesize duplicate audio.
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const conversationId = this.conversationId;
    const live = this.live;
    if (!conversationId && !live) return;
    this.stopping = (async () => {
      await live?.finishAudio();
      live?.close();
      this.live = undefined;
      this.finishAudio();
      if (conversationId) {
        if (this.assistantText.trim()) await this.options.onAssistantTranscript(conversationId, this.assistantText.trim());
        this.assistantText = "";
        await this.options.onStopped(conversationId);
        this.options.emit({ type: "voice.stopped", conversationId });
      }
      this.conversationId = "";
      this.runId = "";
      this.segmentId = "";
      this.pendingAudio = [];
      this.pendingAudioBytes = 0;
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async handleInputTranscript(text: string, final: boolean): Promise<void> {
    if (!this.conversationId || !text.trim()) return;
    this.options.emit({
      type: final ? "voice.transcript.final" : "voice.transcript.partial",
      conversationId: this.conversationId,
      text,
    });
    if (final) await this.options.onUserTranscript(this.conversationId, text.trim());
  }

  private async handleOutputTranscript(text: string, delta: string, final: boolean): Promise<void> {
    if (!this.conversationId) return;
    this.assistantText = text;
    if (delta) this.options.emit({ type: "voice.assistant.delta", conversationId: this.conversationId, runId: this.ensureRun(), text: delta });
    if (final && text.trim()) {
      await this.options.onAssistantTranscript(this.conversationId, text.trim());
      this.assistantText = "";
    }
  }

  private handleAudio(audio: Buffer): void {
    if (!this.conversationId || !audio.length) return;
    const runId = this.ensureRun();
    if (!this.audioStarted) {
      this.audioStarted = true;
      this.sequence = 0;
      this.segmentId = `${runId}:0`;
      this.options.emit({ type: "voice.audio.start", conversationId: this.conversationId, runId, mimeType: GEMINI_LIVE_OUTPUT_MIME });
      this.options.emit({ type: "voice.speech.start", conversationId: this.conversationId, runId, segmentId: this.segmentId, text: "" });
    }
    this.options.emit({
      type: "voice.audio.chunk",
      conversationId: this.conversationId,
      runId,
      sequence: this.sequence++,
      segmentId: this.segmentId,
      audio: audio.toString("base64"),
    });
  }

  private finishAudio(): void {
    if (!this.audioStarted || !this.conversationId || !this.runId) return;
    this.options.emit({ type: "voice.speech.end", conversationId: this.conversationId, runId: this.runId, segmentId: this.segmentId });
    this.options.emit({ type: "voice.audio.end", conversationId: this.conversationId, runId: this.runId });
    this.audioStarted = false;
    this.runId = "";
    this.segmentId = "";
  }

  private interrupt(): void {
    if (!this.conversationId) return;
    this.options.emit({ type: "voice.interrupt", conversationId: this.conversationId });
    this.finishAudio();
    this.assistantText = "";
  }

  private ensureRun(): string {
    this.runId ||= `live_${randomUUID()}`;
    return this.runId;
  }

  private report(error: unknown): void {
    this.options.emit({
      type: "voice.error",
      ...(this.conversationId ? { conversationId: this.conversationId } : {}),
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
