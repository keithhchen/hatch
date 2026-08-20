import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ClientToolNameSchema,
  type ClientToolName,
  type ContextAttachment,
  type ConversationMessage,
  type OutputFinishReason
} from "./protocol.js";
import type { CompactionPhase, CompactionReason, CompactionTrigger } from "./compaction.js";

export type RunStatus = "queued" | "running" | "waiting_for_tool" | "compacting" | "completed" | "failed" | "cancelled" | "interrupted";

export type ActivatedSkill = {
  name: string;
  path: string;
  scope?: string;
  directory: string;
  content: string;
  allowed_tools?: string;
  resource_paths: string[];
  resource_manifest_truncated: boolean;
  activated_at: string;
};

export type VisibleConversationMessage = {
  run_id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /** Metadata is enough for history chips; raw attachment text stays in the durable model record. */
  attachments?: Array<Omit<ContextAttachment, "text">>;
  finish_reason?: OutputFinishReason;
  parts?: VisibleConversationPart[];
  tool_calls?: VisibleConversationToolCall[];
};

export type VisibleConversationPart =
  | { type: "text"; start: number; end: number }
  | { type: "tool_call"; tool_call_id: string };

export type VisibleConversationToolCall = {
  run_id: string;
  tool_call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "requested" | "completed" | "failed" | "cancelled";
  locality?: "server" | "client";
  approval?: "none" | "auto" | "ask";
  result?: unknown;
  error?: unknown;
  first_timestamp: string;
  timestamp: string;
};

export type StoreEvent =
  | {
      type: "session.started";
      creator_id?: string;
      user_id?: string;
      agent_id?: string;
      product_id?: string;
      corpus_digest?: string;
      client_version?: string;
      local_tools?: ClientToolName[];
      timestamp: string;
    }
  | {
      type: "message.created";
      conversation_id: string;
      run_id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    }
  | {
      type: "conversation.model_message";
      conversation_id: string;
      run_id: string;
      message: ConversationMessage;
      finish_reason?: OutputFinishReason;
      visible_parts?: VisibleConversationPart[];
      timestamp: string;
    }
  | {
      type: "turn.state";
      conversation_id: string;
      run_id: string;
      from?: RunStatus;
      to: RunStatus;
      reason?: string;
      timestamp: string;
    }
  | {
      type: "runtime.event";
      conversation_id?: string;
      run_id?: string;
      event: unknown;
      timestamp: string;
    }
  | {
      type: "tool.call";
      conversation_id?: string;
      run_id: string;
      tool_call_id: string;
      name: string;
      arguments: Record<string, unknown>;
      status: "requested" | "completed" | "failed" | "cancelled";
      locality?: "server" | "client";
      approval?: "none" | "auto" | "ask";
      result?: unknown;
      error?: unknown;
      timestamp: string;
    }
  | {
      type: "conversation.compacted";
      conversation_id: string;
      run_id: string;
      trigger: CompactionTrigger;
      phase: CompactionPhase;
      reason: CompactionReason;
      message: string;
      replacement_history?: ConversationMessage[];
      window_number?: number;
      first_window_id?: string;
      previous_window_id?: string;
      window_id?: string;
      timestamp: string;
    };

type StoreEventInput = StoreEvent extends infer Event
  ? Event extends { timestamp: string }
    ? Omit<Event, "timestamp"> & { timestamp?: string }
    : never
  : never;

export class RuntimeStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly root = process.env.HATCH_RUNTIME_DATA_DIR ?? path.resolve(".hatch-runtime")) {}

  /**
   * Local ConversationRepository uses the same app-data directory, while
   * intentionally keeping a separate durable control-plane file from this
   * append-only transcript projection.
   */
  get dataDirectory(): string {
    return this.root;
  }

  async append(event: StoreEventInput): Promise<void> {
    assertCanonicalPersistedToolNames(event);
    const record = {
      timestamp: new Date().toISOString(),
      ...event
    };
    const write = this.writeChain.then(async () => {
      await mkdir(this.root, { recursive: true });
      await appendFile(path.join(this.root, "events.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    });
    this.writeChain = write.catch(() => undefined);
    await write;
  }

  async close(): Promise<void> {
    await this.writeChain;
  }

  async readEvents(): Promise<StoreEvent[]> {
    await this.writeChain;
    const file = path.join(this.root, "events.jsonl");
    const content = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => normalizePersistedStoreEvent(JSON.parse(line) as StoreEvent));
  }

  async readConversation(conversationId: string): Promise<ConversationMessage[]> {
    const events = await this.readEvents();
    const messages: ConversationMessage[] = [];
    const modelAssistantRuns = new Set(
      events
        .filter((event): event is Extract<StoreEvent, { type: "conversation.model_message" }> => (
          event.type === "conversation.model_message"
          && event.conversation_id === conversationId
          && event.message.role === "assistant"
        ))
        .map((event) => event.run_id)
    );
    for (const event of events) {
      if (!("conversation_id" in event) || event.conversation_id !== conversationId) {
        continue;
      }
      if (event.type === "conversation.compacted" && event.replacement_history) {
        messages.splice(0, messages.length, ...event.replacement_history);
      } else if (event.type === "conversation.model_message") {
        messages.push(event.message);
      } else if (event.type === "message.created") {
        // The UI projection writes one assistant bubble after a completed
        // turn, while Pi's canonical model transcript already stores the
        // completed assistant message. Do not feed that projection row back
        // to the next model request as a duplicate assistant turn.
        if (event.role === "assistant" && modelAssistantRuns.has(event.run_id)) continue;
        messages.push({
          role: event.role,
          content: event.content
        });
      }
    }
    return messages;
  }

  async readVisibleConversation(conversationId: string): Promise<VisibleConversationMessage[]> {
    const events = await this.readEvents();
    const toolCallsByRun = new Map<string, Map<string, VisibleConversationToolCall>>();
    for (const event of events) {
      if (event.type === "tool.call" && event.conversation_id === conversationId) {
        const runTools = toolCallsByRun.get(event.run_id) ?? new Map<string, VisibleConversationToolCall>();
        const existing = runTools.get(event.tool_call_id);
        runTools.set(event.tool_call_id, {
          run_id: event.run_id,
          tool_call_id: event.tool_call_id,
          name: event.name,
          arguments: event.arguments,
          status: event.status,
          locality: event.locality ?? existing?.locality,
          approval: event.approval ?? existing?.approval,
          result: event.result ?? existing?.result,
          error: event.error ?? existing?.error,
          first_timestamp: existing?.first_timestamp ?? event.timestamp,
          timestamp: event.timestamp
        });
        toolCallsByRun.set(event.run_id, runTools);
      }
    }

    const modelVisibleKeys = new Set(
      events
        .filter((event): event is Extract<StoreEvent, { type: "conversation.model_message" }> => (
          event.type === "conversation.model_message"
          && event.conversation_id === conversationId
          && (
            event.message.role === "user"
            || (event.message.role === "assistant" && event.finish_reason !== undefined)
          )
        ))
        .map((event) => `${event.run_id}:${event.message.role}`)
    );
    const visibleEvents = events.filter((event): event is (
      Extract<StoreEvent, { type: "message.created" }>
      | Extract<StoreEvent, { type: "conversation.model_message" }>
    ) => {
      if (!("conversation_id" in event) || event.conversation_id !== conversationId) return false;
      if (event.type === "conversation.model_message") {
        return event.message.role === "user"
          || (event.message.role === "assistant" && event.finish_reason !== undefined);
      }
      if (event.type === "message.created") {
        return !modelVisibleKeys.has(`${event.run_id}:${event.role}`);
      }
      return false;
    });

    return visibleEvents.map((event) => {
        const role = event.type === "message.created" ? event.role : event.message.role;
        if (role !== "user" && role !== "assistant") {
          throw new Error(`Unsupported visible conversation role: ${role}`);
        }
        const message: VisibleConversationMessage = {
          run_id: event.run_id,
          role,
          content: event.type === "message.created"
            ? event.content
            : event.finish_reason === "content_filter"
              ? ""
              : event.message.content ?? "",
          timestamp: event.timestamp
        };
        if (event.type === "conversation.model_message" && event.message.attachments?.length) {
          message.attachments = event.message.attachments.map(({ text: _text, ...attachment }) => attachment);
        }
        if (event.type === "conversation.model_message" && event.finish_reason) {
          message.finish_reason = event.finish_reason;
          if (event.visible_parts) {
            message.parts = event.visible_parts;
          }
        }
        if (role === "assistant") {
          const toolCalls = [...(toolCallsByRun.get(event.run_id)?.values() ?? [])]
            .sort((left, right) => left.first_timestamp.localeCompare(right.first_timestamp));
          if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
          }
        }
        return message;
      });
  }

  async readCompactionState(conversationId: string): Promise<{
    window_number?: number;
    first_window_id?: string;
    previous_window_id?: string;
    window_id?: string;
  }> {
    const events = await this.readEvents();
    let state = {};
    for (const event of events) {
      if (event.type !== "conversation.compacted" || event.conversation_id !== conversationId) {
        continue;
      }
      state = {
        window_number: event.window_number,
        first_window_id: event.first_window_id,
        previous_window_id: event.previous_window_id,
        window_id: event.window_id
      };
    }
    return state;
  }

}

export function normalizePersistedStoreEvent(event: StoreEvent): StoreEvent {
  if (event.type === "session.started" && event.local_tools) {
    const local_tools = event.local_tools.map((name) => (
      ClientToolNameSchema.parse(normalizePersistedLocalToolName(name))
    ));
    return local_tools.every((name, index) => name === event.local_tools?.[index])
      ? event
      : { ...event, local_tools };
  }
  if (event.type === "tool.call") {
    const name = normalizePersistedLocalToolName(event.name);
    return name === event.name ? event : { ...event, name };
  }
  return event;
}

export function assertCanonicalPersistedToolNames(event: unknown): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const record = event as Record<string, unknown>;
  if (record.type === "session.started" && Array.isArray(record.local_tools)) {
    for (const name of record.local_tools) {
      assertCanonicalClientToolName(name, "session.started.local_tools");
    }
    return;
  }
  if (record.type === "tool.call") {
    if (record.locality === "client") {
      assertCanonicalClientToolName(record.name, "tool.call.name");
    } else {
      assertNotLegacyLocalToolName(record.name, "tool.call.name");
    }
    return;
  }
}

function assertCanonicalClientToolName(value: unknown, field: string): asserts value is ClientToolName {
  assertNotLegacyLocalToolName(value, field);
  if (!ClientToolNameSchema.safeParse(value).success) {
    throw new Error(`${field} must be a canonical local tool name`);
  }
}

function assertNotLegacyLocalToolName(value: unknown, field: string): void {
  if (typeof value !== "string") return;
  const canonical = normalizePersistedLocalToolName(value);
  if (canonical !== value) {
    throw new Error(`${field} must use canonical local tool name ${canonical}, not ${value}`);
  }
}

const persistedLocalToolNameMigrations = new Map<string, string>([
  ["fs.list", "file_list"],
  ["fs.search", "file_search"],
  ["fs.read", "file_read"],
  ["fs.write", "file_write"],
  ["fs.patch", "file_patch"],
  ["shell.exec", "shell_exec"],
  ["git.diff", "git_diff"]
]);

function normalizePersistedLocalToolName(name: string): string {
  return persistedLocalToolNameMigrations.get(name) ?? name;
}
