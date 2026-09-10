import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export type StreamingSttCallbacks = {
  onPartial: (text: string) => void;
  onCommitted: (text: string) => void;
  onError: (error: unknown) => void;
};

export interface StreamingSttProvider {
  readonly model: string;
  start(): Promise<void>;
  sendAudio(chunk: Buffer): void;
  close(): void;
}

type SttProviderOptions = StreamingSttCallbacks & {
  environment?: NodeJS.ProcessEnv;
};

export function createStreamingSttProvider(options: SttProviderOptions): StreamingSttProvider {
  const environment = options.environment ?? process.env;
  const provider = (environment.HATCH_FACTORY_STT_PROVIDER?.trim() || "qwen").toLowerCase();
  if (provider === "qwen") return new QwenStreamingStt({ ...options, environment });
  if (provider === "elevenlabs") return new ElevenLabsStreamingStt({ ...options, environment });
  throw new Error(`Unsupported Factory STT provider: ${provider}`);
}

export class QwenStreamingStt implements StreamingSttProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly callbacks: StreamingSttCallbacks;
  private readonly taskId = randomUUID();
  private socket?: WebSocket;
  private cancelled = false;

  constructor(options: SttProviderOptions & { environment: NodeJS.ProcessEnv }) {
    this.model = options.environment.HATCH_FACTORY_QWEN_STT_MODEL?.trim() || "qwen-audio-3.0-asr-flash-streaming";
    this.apiKey = options.environment.DASHSCOPE_API_KEY?.trim() || "";
    this.endpoint = options.environment.HATCH_FACTORY_QWEN_STT_URL?.trim() || "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
    this.callbacks = options;
  }

  start(): Promise<void> {
    if (!this.apiKey) throw new Error("Missing DASHSCOPE_API_KEY");
    this.cancelled = false;
    const socket = new WebSocket(this.endpoint, {
      headers: { authorization: `Bearer ${this.apiKey}`, "user-agent": "hatch-factory-voice" }
    });
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      let started = false;
      socket.once("open", () => socket.send(JSON.stringify(qwenStartTask(this.taskId, this.model))));
      socket.once("error", (error) => {
        if (this.cancelled) resolve();
        else if (!started) reject(error);
      });
      socket.once("close", () => {
        if (!this.cancelled && !started) reject(new Error("Qwen STT closed before the task started"));
      });
      socket.on("message", (raw, binary) => {
        if (this.cancelled || binary) return;
        try {
          const message = JSON.parse(raw.toString()) as QwenServerEvent;
          if (message.header?.event === "task-started") {
            started = true;
            resolve();
            return;
          }
          if (message.header?.event === "task-failed") {
            const error = new Error(message.header.error_message || message.header.error_code || "Qwen STT failed");
            if (!started) reject(error);
            else this.callbacks.onError(error);
            return;
          }
          const sentence = message.payload?.output?.sentence;
          if (message.header?.event !== "result-generated" || sentence?.heartbeat || !sentence?.text) return;
          if (sentence.sentence_end) this.callbacks.onCommitted(sentence.text);
          else this.callbacks.onPartial(sentence.text);
        } catch (error) {
          this.callbacks.onError(error);
        }
      });
      socket.on("error", (error) => {
        if (!this.cancelled && started) this.callbacks.onError(error);
      });
    });
  }

  sendAudio(chunk: Buffer): void {
    if (!this.cancelled && this.socket?.readyState === WebSocket.OPEN) this.socket.send(chunk, { binary: true });
  }

  close(): void {
    this.cancelled = true;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(qwenFinishTask(this.taskId)));
    }
    closeSocket(this.socket);
    this.socket = undefined;
  }
}

export class ElevenLabsStreamingStt implements StreamingSttProvider {
  readonly model = "scribe_v2_realtime";
  private readonly apiKey: string;
  private readonly callbacks: StreamingSttCallbacks;
  private socket?: WebSocket;
  private cancelled = false;

  constructor(options: SttProviderOptions & { environment: NodeJS.ProcessEnv }) {
    this.apiKey = options.environment.ELEVENLABS_API_KEY?.trim() || "";
    this.callbacks = options;
  }

  start(): Promise<void> {
    if (!this.apiKey) throw new Error("Missing ELEVENLABS_API_KEY");
    this.cancelled = false;
    const params = new URLSearchParams({
      model_id: this.model,
      audio_format: "pcm_16000",
      commit_strategy: "vad",
      vad_silence_threshold_secs: "1.8",
      vad_threshold: "0.5",
      min_speech_duration_ms: "180",
      min_silence_duration_ms: "250"
    });
    const socket = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`, {
      headers: { "xi-api-key": this.apiKey }
    });
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", (error) => this.cancelled ? resolve() : reject(error));
      socket.once("close", () => { if (!this.cancelled) reject(new Error("ElevenLabs STT closed before it started")); });
      socket.on("message", (raw) => {
        if (this.cancelled) return;
        try {
          const message = JSON.parse(raw.toString()) as { message_type?: string; text?: string; error?: string };
          if (message.message_type === "partial_transcript" && message.text) this.callbacks.onPartial(message.text);
          if (message.message_type === "committed_transcript" && message.text) this.callbacks.onCommitted(message.text);
          if (message.error) this.callbacks.onError(new Error(message.error));
        } catch (error) {
          this.callbacks.onError(error);
        }
      });
      socket.on("error", (error) => { if (!this.cancelled) this.callbacks.onError(error); });
    });
  }

  sendAudio(chunk: Buffer): void {
    if (!this.cancelled && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: chunk.toString("base64") }));
    }
  }

  close(): void {
    this.cancelled = true;
    closeSocket(this.socket);
    this.socket = undefined;
  }
}

export function qwenStartTask(taskId: string, model: string) {
  return {
    header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model,
      parameters: {
        format: "pcm",
        sample_rate: 16000,
        semantic_punctuation_enabled: false,
        max_sentence_silence: 1800,
        speech_noise_threshold: 0.2,
        heartbeat: true,
        vocabulary: { Hatch: 5, Creator: 5, Agent: 5 }
      },
      input: {}
    }
  };
}

function qwenFinishTask(taskId: string) {
  return {
    header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
    payload: { input: {} }
  };
}

function closeSocket(socket?: WebSocket): void {
  if (!socket) return;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
}

type QwenServerEvent = {
  header?: { event?: string; error_code?: string; error_message?: string };
  payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean; heartbeat?: boolean } } };
};
