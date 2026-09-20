import {
  Behavior,
  FunctionResponseScheduling,
  GoogleGenAI,
  Modality,
  type FunctionCall,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export const GEMINI_LIVE_MODEL = "gemini-3.8-live";
export const GEMINI_LIVE_INPUT_MIME = "audio/pcm;rate=16000";
export const GEMINI_LIVE_OUTPUT_MIME = "audio/pcm;rate=24000";

export type GeminiLiveCallbacks = {
  onReady?: (value: { model: string; sessionId?: string }) => void;
  onInputTranscript?: (value: { text: string; final: boolean }) => void | Promise<void>;
  onOutputTranscript?: (value: { text: string; delta: string; final: boolean }) => void | Promise<void>;
  onAudio?: (audio: Buffer) => void;
  onAudioEnd?: () => void;
  onInterrupted?: () => void;
  onToolStart?: (value: { id: string; name: string; args: Record<string, unknown> }) => void | Promise<void>;
  onToolEnd?: (value: { id: string; name: string; result: AgentToolResult<unknown>; isError: boolean }) => void | Promise<void>;
  onResumptionHandle?: (handle: string) => void | Promise<void>;
  onError?: (error: unknown) => void;
};

export type GeminiLiveSessionOptions = GeminiLiveCallbacks & {
  apiKey: string;
  systemPrompt: string;
  tools: AgentTool[];
  model?: string;
  voiceName?: string;
  resumptionHandle?: string;
  client?: GoogleGenAI;
};

/**
 * Owns one real Gemini Live audio-to-audio session.
 *
 * Hatch remains the authority for tool execution and persistence. Gemini owns
 * only the live conversational turn state; every function call is resolved
 * through the AgentTool instances supplied by the authenticated Factory scope.
 */
export class GeminiLiveSession {
  readonly model: string;
  private readonly client: GoogleGenAI;
  private readonly callbacks: GeminiLiveCallbacks;
  private readonly tools: Map<string, AgentTool>;
  private session?: Session;
  private connecting?: Promise<void>;
  private closed = false;
  private connectionId = 0;
  private resumptionHandle?: string;
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private audioSinceTurn = false;
  private inputTranscript = "";
  private outputTranscript = "";
  private toolAbort = new Map<string, AbortController>();
  private turnWaiters = new Set<() => void>();
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: GeminiLiveSessionOptions) {
    if (!options.apiKey.trim()) throw new Error("Missing GEMINI_API_KEY");
    if (!options.systemPrompt.trim()) throw new Error("Gemini Live requires the authenticated Voice Agent system prompt");
    this.model = options.model?.trim() || GEMINI_LIVE_MODEL;
    this.client = options.client ?? new GoogleGenAI({ apiKey: options.apiKey.trim() });
    this.tools = new Map(options.tools.map(tool => [tool.name, tool]));
    this.callbacks = options;
    this.resumptionHandle = options.resumptionHandle;
  }

  async start(): Promise<void> {
    if (this.session) return;
    this.closed = false;
    try {
      await this.connect();
    } catch (error) {
      // A resumption handle belongs to the previous Live connection. If it
      // has expired or been closed by Gemini, retry this start once as a new
      // session instead of surfacing a false voice-session failure.
      if (!this.resumptionHandle || this.closed) throw error;
      this.connectionId += 1;
      const staleSession = this.session as Session | undefined;
      staleSession?.close();
      this.session = undefined;
      this.resumptionHandle = undefined;
      await this.connect();
    }
  }

  private async connect(): Promise<void> {
    const connectionId = ++this.connectionId;
    let readySettled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = () => { if (!readySettled) { readySettled = true; resolve(); } };
      rejectReady = error => { if (!readySettled) { readySettled = true; reject(error); } };
    });
    // The SDK can report a close before `live.connect()` returns. Keep the
    // rejection observed even while the connection promise is being awaited.
    ready.catch(() => undefined);
    const session = await this.client.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: this.options.systemPrompt,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: this.options.voiceName?.trim()
          ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.options.voiceName.trim() } } }
          : undefined,
        tools: this.tools.size ? [{
          functionDeclarations: [...this.tools.values()].map(tool => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: JSON.parse(JSON.stringify(tool.parameters)),
            // Factory workspace tools read and mutate ordered state. Blocking
            // preserves the same sequential contract as the text Runtime.
            behavior: Behavior.BLOCKING,
          })),
        }] : undefined,
        // The Gemini Developer API accepts an empty object for a new resumable
        // session and a handle when reconnecting. `transparent` is Vertex-only.
        sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
        contextWindowCompression: {
          triggerTokens: "25000",
          slidingWindow: { targetTokens: "8000" },
        },
      },
      callbacks: {
        onmessage: message => {
          if (connectionId !== this.connectionId) return;
          if (message.setupComplete) resolveReady();
          this.messageQueue = this.messageQueue.then(() => this.handleMessage(message)).catch(error => this.report(error));
        },
        onerror: event => {
          const error = event.error instanceof Error ? event.error : new Error(event.message || "Gemini Live connection error");
          rejectReady(error);
          this.report(error);
        },
        onclose: event => {
          const error = new Error(`Gemini Live closed (${event.code}): ${event.reason || "connection lost"}`);
          if (this.closed || connectionId !== this.connectionId) return;
          // A connection that never completed setup is an initial-connect
          // failure. Let `start()` handle it once; reconnecting here races the
          // original setup promise and can create an unhandled rejection.
          if (!readySettled) {
            rejectReady(error);
            return;
          }
          void this.reconnect(error).catch(() => undefined);
        },
      },
    });
    if (this.closed || connectionId !== this.connectionId) { session.close(); return; }
    this.session = session;
    let readyTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => { readyTimer = setTimeout(() => reject(new Error("Gemini Live setup timed out")), 20_000); }),
      ]);
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
    }
    for (const audio of this.pendingAudio.splice(0)) this.sendAudio(audio);
    this.pendingAudioBytes = 0;
  }

  sendAudio(audio: Buffer): void {
    if (!audio.length || this.closed) return;
    this.audioSinceTurn = true;
    if (!this.session) {
      this.pendingAudioBytes += audio.length;
      if (this.pendingAudioBytes > 512 * 1024) throw new Error("Gemini Live reconnect audio buffer exceeded");
      this.pendingAudio.push(Buffer.from(audio));
      return;
    }
    this.session.sendRealtimeInput({
      audio: { data: audio.toString("base64"), mimeType: GEMINI_LIVE_INPUT_MIME },
    });
  }

  async finishAudio(timeoutMs = 5_000): Promise<void> {
    if (this.closed || !this.session || !this.audioSinceTurn) return;
    this.session.sendRealtimeInput({ audioStreamEnd: true });
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.turnWaiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, timeoutMs);
      this.turnWaiters.add(finish);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionId += 1;
    for (const controller of this.toolAbort.values()) controller.abort(new Error("Gemini Live session closed"));
    this.toolAbort.clear();
    for (const resolve of this.turnWaiters) resolve();
    this.turnWaiters.clear();
    this.session?.close();
    this.session = undefined;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
  }

  private async handleMessage(message: LiveServerMessage): Promise<void> {
    if (message.setupComplete) {
      await this.callbacks.onReady?.({ model: this.model, sessionId: message.setupComplete.sessionId });
    }
    const resumption = message.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      this.resumptionHandle = resumption.newHandle;
      await this.callbacks.onResumptionHandle?.(resumption.newHandle);
    }
    if (message.goAway) void this.reconnect().catch(() => undefined);
    if (message.toolCallCancellation?.ids) {
      for (const id of message.toolCallCancellation.ids) {
        this.toolAbort.get(id)?.abort(new Error("Gemini cancelled the tool call"));
        this.toolAbort.delete(id);
      }
    }
    if (message.toolCall?.functionCalls?.length) await this.executeTools(message.toolCall.functionCalls);

    const content = message.serverContent;
    if (!content) return;
    if (content.interrupted) {
      this.outputTranscript = "";
      this.callbacks.onInterrupted?.();
    }
    if (content.inputTranscription?.text) {
      this.inputTranscript = appendTranscript(this.inputTranscript, content.inputTranscription.text);
      await this.callbacks.onInputTranscript?.({ text: this.inputTranscript, final: Boolean(content.inputTranscription.finished) });
      if (content.inputTranscription.finished) this.inputTranscript = "";
    }
    if (content.outputTranscription?.text) {
      const previous = this.outputTranscript;
      this.outputTranscript = appendTranscript(previous, content.outputTranscription.text);
      const delta = this.outputTranscript.startsWith(previous) ? this.outputTranscript.slice(previous.length) : content.outputTranscription.text;
      await this.callbacks.onOutputTranscript?.({ text: this.outputTranscript, delta, final: Boolean(content.outputTranscription.finished) });
      if (content.outputTranscription.finished) this.outputTranscript = "";
    }
    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data) this.callbacks.onAudio?.(Buffer.from(data, "base64"));
    }
    if (content.generationComplete || content.turnComplete) {
      // Gemini commonly omits `finished` on transcription updates. The turn
      // boundary is authoritative; finalize any accumulated text here so the
      // Workbench never loses the user's spoken evidence.
      if (this.inputTranscript.trim()) {
        await this.callbacks.onInputTranscript?.({ text: this.inputTranscript, final: true });
        this.inputTranscript = "";
      }
      if (this.outputTranscript.trim()) {
        await this.callbacks.onOutputTranscript?.({ text: this.outputTranscript, delta: "", final: true });
        this.outputTranscript = "";
      }
      this.audioSinceTurn = false;
      this.callbacks.onAudioEnd?.();
      for (const resolve of [...this.turnWaiters]) resolve();
    }
  }

  private async executeTools(calls: FunctionCall[]): Promise<void> {
    if (!this.session) return;
    const responses = [];
    for (const call of calls) {
      const id = call.id || `${call.name || "tool"}-${Date.now()}`;
      const name = call.name || "";
      const args = call.args && typeof call.args === "object" && !Array.isArray(call.args)
        ? call.args as Record<string, unknown>
        : {};
      const tool = this.tools.get(name);
      const controller = new AbortController();
      this.toolAbort.set(id, controller);
      await this.callbacks.onToolStart?.({ id, name, args });
      try {
        if (!tool) throw new Error(`Gemini requested an unavailable Factory tool: ${name}`);
        const result = await tool.execute(id, args as never, controller.signal);
        await this.callbacks.onToolEnd?.({ id, name, result, isError: false });
        responses.push({
          id,
          name,
          response: {
            output: toolResultValue(result),
            scheduling: FunctionResponseScheduling.WHEN_IDLE,
          },
        });
      } catch (error) {
        const result: AgentToolResult<unknown> = {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
        };
        await this.callbacks.onToolEnd?.({ id, name, result, isError: true });
        responses.push({
          id,
          name,
          response: {
            error: error instanceof Error ? error.message : String(error),
            scheduling: FunctionResponseScheduling.WHEN_IDLE,
          },
        });
      } finally {
        this.toolAbort.delete(id);
      }
    }
    this.session.sendToolResponse({ functionResponses: responses });
  }

  private report(error: unknown): void {
    this.callbacks.onError?.(error);
  }

  private async reconnect(cause?: unknown): Promise<void> {
    if (this.closed) return;
    if (this.connecting) return this.connecting;
    const previous = this.session;
    this.session = undefined;
    this.connecting = (async () => {
      try {
        previous?.close();
        await this.connect();
      } catch (error) {
        this.report(cause ?? error);
        throw error;
      }
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
}

function appendTranscript(previous: string, incoming: string): string {
  if (!previous) return incoming;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.endsWith(incoming)) return previous;
  return previous + incoming;
}

function toolResultValue(result: AgentToolResult<unknown>): unknown {
  const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  if (result.details && typeof result.details === "object" && Object.keys(result.details as object).length) {
    return { details: result.details, ...(text ? { text } : {}) };
  }
  return text || { ok: true };
}
