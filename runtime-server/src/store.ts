import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ConversationMessage } from "./protocol.js";
import type { CompactionPhase, CompactionReason, CompactionTrigger } from "./compaction.js";

export type RunStatus = "queued" | "running" | "waiting_for_tool" | "compacting" | "completed" | "failed" | "cancelled";

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
};

export type StoreEvent =
  | {
      type: "session.started";
      installation_id: string;
      client_version?: string;
      workspace_root?: string;
      local_tools?: string[];
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
      result?: unknown;
      error?: unknown;
      timestamp: string;
    }
  | {
      type: "skill.activated";
      conversation_id: string;
      run_id: string;
      name: string;
      path: string;
      scope?: string;
      directory: string;
      content: string;
      allowed_tools?: string;
      resource_paths?: string[];
      resource_manifest_truncated?: boolean;
      timestamp: string;
    }
  | {
      type: "skill.invoked";
      conversation_id?: string;
      run_id: string;
      name: string;
      path: string;
      scope: string;
      invocation_type: "implicit";
      reason: "script_run" | "skill_doc_read";
      source_tool_call_id: string;
      trigger: {
        tool: "shell_exec" | "file_read";
        command?: string;
        path?: string;
      };
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

  async append(event: StoreEventInput): Promise<void> {
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
      .map((line) => JSON.parse(line) as StoreEvent);
  }

  async readConversation(conversationId: string): Promise<ConversationMessage[]> {
    const events = await this.readEvents();
    const messages: ConversationMessage[] = [];
    for (const event of events) {
      if (!("conversation_id" in event) || event.conversation_id !== conversationId) {
        continue;
      }
      if (event.type === "conversation.compacted" && event.replacement_history) {
        messages.splice(0, messages.length, ...event.replacement_history);
      } else if (event.type === "conversation.model_message") {
        messages.push(event.message);
      } else if (event.type === "message.created") {
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
    return events
      .filter((event): event is Extract<StoreEvent, { type: "message.created" }> => (
        event.type === "message.created" && event.conversation_id === conversationId
      ))
      .map((event) => ({
        run_id: event.run_id,
        role: event.role,
        content: event.content,
        timestamp: event.timestamp
      }));
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
