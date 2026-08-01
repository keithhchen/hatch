import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ConversationMessage } from "./protocol.js";
import type { CompactionPhase, CompactionReason, CompactionTrigger } from "./compaction.js";
import { projectToolArgumentsForVisibility, projectToolResultForVisibility } from "./toolVisibility.js";

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
  tool_calls?: VisibleConversationToolCall[];
  skill_events?: VisibleConversationSkillEvent[];
  skill_runs?: VisibleConversationSkillRun[];
};

export type VisibleConversationSkillRun = {
  run_id: string;
  skill_run_id: string;
  skill_id: string;
  name: string;
  status: "requested" | "running" | "completed" | "failed" | "cancelled";
  error?: { code: string; message: string };
  timestamp: string;
};

export type VisibleConversationToolCall = {
  run_id: string;
  tool_call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "requested" | "completed" | "failed" | "cancelled";
  locality?: "server" | "client";
  approval?: "none" | "auto" | "ask";
  scope?: "main" | "skill_run";
  skill_run_id?: string;
  result?: unknown;
  error?: unknown;
  first_timestamp: string;
  timestamp: string;
};

export type VisibleConversationSkillEvent = {
  run_id: string;
  name: string;
  path: string;
  scope?: string;
  status: "activated" | "invoked";
  invocation_type: "explicit" | "implicit";
  reason: "explicit_mention" | "script_run" | "skill_doc_read";
  source_tool_call_id?: string;
  trigger?: {
    tool: "shell_exec" | "file_read";
    command?: string;
    path?: string;
  };
  resource_paths?: string[];
  resource_manifest_truncated?: boolean;
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
      locality?: "server" | "client";
      approval?: "none" | "auto" | "ask";
      scope?: "main" | "skill_run";
      skill_run_id?: string;
      result?: unknown;
      error?: unknown;
      timestamp: string;
    }
  | {
      type: "skill.session";
      conversation_id: string;
      parent_run_id: string;
      skill_run_id: string;
      skill_id: string;
      name: string;
      status: "created" | "running" | "waiting_for_tool" | "completed" | "failed" | "cancelled";
      error?: { code: string; message: string };
      timestamp: string;
    }
  | {
      type: "skill.session.message";
      conversation_id: string;
      parent_run_id: string;
      skill_run_id: string;
      message: ConversationMessage;
      timestamp: string;
    }
  | {
      type: "skill.session.compacted";
      conversation_id: string;
      parent_run_id: string;
      skill_run_id: string;
      replacement_history: ConversationMessage[];
      window_number: number;
      first_window_id: string;
      previous_window_id?: string;
      window_id: string;
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
      type: "skill.run";
      conversation_id: string;
      run_id: string;
      skill_run_id: string;
      skill_id: string;
      name: string;
      status: "requested" | "running" | "completed" | "failed" | "cancelled";
      error?: { code: string; message: string };
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
    const toolCallsByRun = new Map<string, Map<string, VisibleConversationToolCall>>();
    const skillEventsByRun = new Map<string, VisibleConversationSkillEvent[]>();
    const skillRunsByRun = new Map<string, Map<string, VisibleConversationSkillRun>>();
    const skillEventKeysByRun = new Map<string, Set<string>>();
    const appendVisibleSkillEvent = (event: VisibleConversationSkillEvent): void => {
      const runSkillEvents = skillEventsByRun.get(event.run_id) ?? [];
      const runSkillKeys = skillEventKeysByRun.get(event.run_id) ?? new Set<string>();
      const key = visibleSkillEventKey(event);
      if (runSkillKeys.has(key)) {
        return;
      }
      runSkillEvents.push(event);
      runSkillKeys.add(key);
      skillEventsByRun.set(event.run_id, runSkillEvents);
      skillEventKeysByRun.set(event.run_id, runSkillKeys);
    };
    for (const event of events) {
      if (event.type === "tool.call" && event.conversation_id === conversationId) {
        const runTools = toolCallsByRun.get(event.run_id) ?? new Map<string, VisibleConversationToolCall>();
        const existing = runTools.get(event.tool_call_id);
        runTools.set(event.tool_call_id, {
          run_id: event.run_id,
          tool_call_id: event.tool_call_id,
          name: event.name,
          arguments: projectToolArgumentsForVisibility(event.scope, event.name, event.arguments),
          status: event.status,
          locality: event.locality ?? existing?.locality,
          approval: event.approval ?? existing?.approval,
          scope: event.scope ?? existing?.scope,
          skill_run_id: event.skill_run_id ?? existing?.skill_run_id,
          result: event.result
            ? projectToolResultForVisibility(event.scope, event.name, event.result as Record<string, unknown>)
            : existing?.result,
          error: event.error ?? existing?.error,
          first_timestamp: existing?.first_timestamp ?? event.timestamp,
          timestamp: event.timestamp
        });
        toolCallsByRun.set(event.run_id, runTools);
      }
      if (event.type === "skill.activated" && event.conversation_id === conversationId) {
        appendVisibleSkillEvent({
          run_id: event.run_id,
          name: event.name,
          path: event.path,
          scope: event.scope,
          status: "activated",
          invocation_type: "explicit",
          reason: "explicit_mention",
          resource_paths: event.resource_paths,
          resource_manifest_truncated: event.resource_manifest_truncated,
          timestamp: event.timestamp
        });
      }
      if (event.type === "skill.invoked" && event.conversation_id === conversationId) {
        appendVisibleSkillEvent({
          run_id: event.run_id,
          name: event.name,
          path: event.path,
          scope: event.scope,
          status: "invoked",
          invocation_type: event.invocation_type,
          reason: event.reason,
          source_tool_call_id: event.source_tool_call_id,
          trigger: event.trigger,
          timestamp: event.timestamp
        });
      }
      if (event.type === "skill.run" && event.conversation_id === conversationId) {
        const runs = skillRunsByRun.get(event.run_id) ?? new Map<string, VisibleConversationSkillRun>();
        runs.set(event.skill_run_id, {
          run_id: event.run_id,
          skill_run_id: event.skill_run_id,
          skill_id: event.skill_id,
          name: event.name,
          status: event.status,
          error: event.error,
          timestamp: event.timestamp
        });
        skillRunsByRun.set(event.run_id, runs);
      }
    }

    return events
      .filter((event): event is Extract<StoreEvent, { type: "message.created" }> => (
        event.type === "message.created" && event.conversation_id === conversationId
      ))
      .map((event) => {
        const message: VisibleConversationMessage = {
          run_id: event.run_id,
          role: event.role,
          content: event.content,
          timestamp: event.timestamp
        };
        if (event.role === "assistant") {
          const toolCalls = [...(toolCallsByRun.get(event.run_id)?.values() ?? [])]
            .sort((left, right) => left.first_timestamp.localeCompare(right.first_timestamp));
          if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
          }
          const skillEvents = [...(skillEventsByRun.get(event.run_id) ?? [])]
            .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
          if (skillEvents.length > 0) {
            message.skill_events = skillEvents;
          }
          const skillRuns = [...(skillRunsByRun.get(event.run_id)?.values() ?? [])]
            .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
          if (skillRuns.length > 0) {
            message.skill_runs = skillRuns;
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

  async readSkillSession(skillRunId: string): Promise<{
    skill_run_id: string;
    skill_id: string;
    name: string;
    status: Extract<StoreEvent, { type: "skill.session" }>["status"];
    messages: ConversationMessage[];
  } | undefined> {
    const events = await this.readEvents();
    let session: {
      skill_run_id: string;
      skill_id: string;
      name: string;
      status: Extract<StoreEvent, { type: "skill.session" }>["status"];
      messages: ConversationMessage[];
    } | undefined;
    for (const event of events) {
      if (event.type === "skill.session" && event.skill_run_id === skillRunId) {
        if (!session) {
          session = {
            skill_run_id: event.skill_run_id,
            skill_id: event.skill_id,
            name: event.name,
            status: event.status,
            messages: []
          };
        } else {
          session.status = event.status;
        }
      } else if (event.type === "skill.session.message" && event.skill_run_id === skillRunId && session) {
        session.messages.push(event.message);
      } else if (event.type === "skill.session.compacted" && event.skill_run_id === skillRunId && session) {
        session.messages = [...event.replacement_history];
      }
    }
    return session;
  }

}

function visibleSkillEventKey(event: VisibleConversationSkillEvent): string {
  return [
    event.run_id,
    event.status,
    event.path,
    event.reason,
    event.source_tool_call_id ?? ""
  ].join("\u0000");
}
