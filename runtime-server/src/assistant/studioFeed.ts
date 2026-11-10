import type { ConversationEvent } from "../conversations/conversation.js";
import type { EventLog } from "../conversations/eventLog.js";
import { RunEventHub } from "../chat/runEventHub.js";
import type { RuntimeStore, StoreEventInput } from "../store.js";

/** The account's Assistant conversation id in Chat, and the key of its event log in Studio. */
export const assistantConversationId = (accountId: string): string => `conversation:assistant:${accountId}`;
export const assistantFeedKey = (accountId: string): string => `assistant:${accountId}`;
/** The account behind an Assistant conversation id; nothing for any other conversation. */
export const accountOfConversation = (conversationId: string): string | undefined => /^conversation:assistant:([0-9a-f-]{36})$/.exec(conversationId)?.[1];

type Hubbed = Record<string, unknown>;

/** What a Chat event means to a Studio observer, in Studio's own words. Most events mean nothing to it. */
function studioEvents(event: Hubbed, endedRuns: Set<string>): ConversationEvent[] {
  const runId = String(event.run_id ?? "");
  const end = (status: string, error?: unknown): ConversationEvent[] => {
    if (endedRuns.has(runId)) return [];
    endedRuns.add(runId);
    return [{ type: "run_end", status, ...(error ? { error } : {}) }, { type: "state" }];
  };
  switch (event.type) {
    case "message.accepted": return [{ type: "message" }, { type: "state" }];
    case "assistant.delta": {
      const delta = event.delta as { kind?: string; content?: string; delta?: string; contentIndex?: number } | undefined;
      if (delta?.kind === "text" && delta.content) return [{ type: "delta", text: delta.content }];
      // Reasoning is carried as Chat has it, per content index, so the page lays it among the steps and words as it happened.
      if (delta?.kind === "thinking_start") return [{ type: "thinking", contentIndex: delta.contentIndex }];
      if (delta?.kind === "thinking_delta") return [{ type: "thinking_delta", contentIndex: delta.contentIndex, delta: delta.delta }];
      return delta?.kind === "thinking_end" ? [{ type: "thinking_end", contentIndex: delta.contentIndex, content: delta.content }] : [];
    }
    case "tool_call.delta": {
      const name = String(event.name ?? "");
      // The id and the model's own one-line description of the step are what an observer needs to show it; arguments and results stay in Chat.
      const step = { name, id: event.tool_call_id, ...(event.activity_message ? { activity: event.activity_message } : {}) };
      if (event.status === "requested") return [{ type: "tool", ...step }];
      return event.status === "completed" || event.status === "failed" ? [{ type: "tool_end", ...step, isError: event.status === "failed" }] : [];
    }
    case "turn.state": {
      const status = String(event.status);
      if (status === "compacting") return [{ type: "compacting" }, { type: "state" }];
      if (status === "completed" || status === "cancelled" || status === "interrupted") return end(status);
      return status === "failed" ? [] : [{ type: "state" }];
    }
    case "turn.failed": {
      const error = event.error as { code?: string } | undefined;
      return end(error?.code === "run_cancelled" ? "cancelled" : error?.code === "run_interrupted" ? "interrupted" : "failed", error);
    }
    default: return [];
  }
}

/**
 * What Studio observers see of the Assistant's Runs: Chat's events in Studio's vocabulary, in the account's event log, so any
 * client resumes by cursor as it does for a worker. Chat owns the conversation; this is only how Studio watches it.
 */
export class StudioEventProjection {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly ended = new Map<string, Set<string>>();

  constructor(private readonly log: EventLog) {}

  /** Records what a Chat event means to Studio. Never waits for anyone and never throws into the Run. */
  project(conversationId: string, event: Hubbed): void {
    const account = accountOfConversation(conversationId);
    if (!account) return;
    const ended = this.ended.get(conversationId) ?? new Set<string>();
    this.ended.set(conversationId, ended);
    const key = assistantFeedKey(account);
    for (const shown of studioEvents(event, ended)) this.enqueue(key, () => this.log.append(key, shown)).catch(error => console.error("[assistant events]", error));
  }

  /** An assistant message and its `message_end` become visible together: a snapshot never sees one without the other. */
  commitMessage<T>(conversationId: string, persist: () => Promise<T>): Promise<T> {
    const account = accountOfConversation(conversationId);
    if (!account) return persist();
    const key = assistantFeedKey(account);
    return this.enqueue(key, () => this.log.commit(key, { type: "message_end" }, persist));
  }

  private enqueue<T>(key: string, step: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(key) ?? Promise.resolve()).then(step);
    this.tails.set(key, run.catch(() => undefined));
    return run;
  }
}

/** Chat's hub, with every event it publishes also shown to Studio. */
export class StudioHub extends RunEventHub {
  constructor(private readonly projection: StudioEventProjection, relay?: ConstructorParameters<typeof RunEventHub>[0]) { super(relay); }

  override publish(conversationId: string, event: Hubbed): void {
    super.publish(conversationId, event);
    this.projection.project(conversationId, event);
  }
}

type Constructor<T> = new (...args: any[]) => T;

/** A transcript store whose final assistant messages are committed together with the `message_end` Studio shows for them. */
export function studioTranscripts<Base extends Constructor<RuntimeStore>>(Base: Base) {
  return class StudioTranscripts extends Base {
    projection?: StudioEventProjection;

    override async append(event: StoreEventInput): Promise<void> {
      const final = event.type === "conversation.model_message" && event.message.role === "assistant" && event.finish_reason !== undefined;
      if (final && this.projection) return this.projection.commitMessage(event.conversation_id, () => super.append(event));
      return super.append(event);
    }
  };
}
