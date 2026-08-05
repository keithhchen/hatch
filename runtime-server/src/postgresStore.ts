import { Pool, type QueryResultRow } from "pg";
import type { ConversationMessage } from "./protocol.js";
import {
  RuntimeStore,
  type StoreEvent,
  type VisibleConversationMessage,
  type VisibleConversationSkillEvent,
  type VisibleConversationSkillRun,
  type VisibleConversationToolCall
} from "./store.js";

export type PostgresStoreEventInput = Parameters<RuntimeStore["append"]>[0];

export type PostgresQueryExecutor = {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end?: () => Promise<void>;
};

/**
 * The runtime store intentionally uses one append-only event table. It is a
 * conversation-history adapter, not a durable recovery or effect journal.
 */
export const POSTGRES_CONVERSATION_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_conversation_events (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT,
  run_id TEXT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hatch_conversation_events_conversation_idx
  ON hatch_conversation_events (conversation_id, id);
`;

const INSERT_EVENT_SQL = `
INSERT INTO hatch_conversation_events
  (conversation_id, run_id, event_type, payload)
VALUES ($1, $2, $3, $4::jsonb)
`;

const SELECT_PAYLOAD_SQL = `
SELECT payload
FROM hatch_conversation_events
`;

export type PostgresStoreOptions = {
  connectionString?: string;
  /** Alias for callers that use the existing RegistryStore option name. */
  databaseUrl?: string;
  pool?: PostgresQueryExecutor;
  maxConnections?: number;
  environment?: NodeJS.ProcessEnv;
};

export class PostgresStore extends RuntimeStore {
  readonly pool: PostgresQueryExecutor;

  private readonly ownsPool: boolean;
  private schemaPromise: Promise<void> | undefined;
  private appendChain: Promise<void> = Promise.resolve();

  constructor(connectionString?: string);
  constructor(options?: PostgresStoreOptions);
  constructor(pool: PostgresQueryExecutor);
  constructor(input: string | PostgresStoreOptions | PostgresQueryExecutor = {}) {
    // RuntimeStore is the compatibility surface consumed by the existing
    // broker/state machine. Its filesystem root is never used because every
    // overridden persistence method below writes to Postgres.
    super();
    if (typeof input === "string") {
      this.pool = new Pool({ connectionString: input });
      this.ownsPool = true;
      return;
    }

    if (isQueryExecutor(input)) {
      this.pool = input;
      this.ownsPool = false;
      return;
    }

    if (input.pool) {
      this.pool = input.pool;
      this.ownsPool = false;
      return;
    }

    const environment = input.environment ?? process.env;
    const connectionString = input.connectionString
      ?? input.databaseUrl
      ?? environment.HATCH_RUNTIME_DATABASE_URL
      ?? environment.HATCH_REGISTRY_DATABASE_URL
      ?? environment.DATABASE_URL;
    if (!connectionString) {
      throw new Error("Postgres conversation store requires a database connection string");
    }
    this.pool = new Pool({
      connectionString,
      ...(input.maxConnections === undefined ? {} : { max: input.maxConnections })
    });
    this.ownsPool = true;
  }

  static async open(options: string | PostgresStoreOptions = {}): Promise<PostgresStore> {
    const store = typeof options === "string"
      ? new PostgresStore(options)
      : new PostgresStore(options);
    await store.ensureSchema();
    return store;
  }

  async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.pool.query(POSTGRES_CONVERSATION_STORE_SCHEMA).then(() => undefined);
    }
    await this.schemaPromise;
  }

  async initialize(): Promise<void> {
    await this.ensureSchema();
  }

  async migrate(): Promise<void> {
    await this.ensureSchema();
  }

  async close(): Promise<void> {
    await this.appendChain;
    if (this.ownsPool) {
      await this.pool.end?.();
    }
  }

  async append(event: PostgresStoreEventInput): Promise<void> {
    const record = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString()
    } as StoreEvent;
    const write = this.appendChain.then(async () => {
      await this.ensureSchema();
      await this.pool.query(INSERT_EVENT_SQL, [
        optionalStringField(record, "conversation_id"),
        optionalStringField(record, "run_id"),
        record.type,
        JSON.stringify(record)
      ]);
    });
    this.appendChain = write.catch(() => undefined);
    await write;
  }

  async readEvents(conversationId?: string): Promise<StoreEvent[]> {
    await this.appendChain;
    await this.ensureSchema();
    const result = conversationId === undefined
      ? await this.pool.query<PayloadRow>(`${SELECT_PAYLOAD_SQL}ORDER BY id ASC`)
      : await this.pool.query<PayloadRow>(`${SELECT_PAYLOAD_SQL}WHERE conversation_id = $1 ORDER BY id ASC`, [conversationId]);
    return result.rows.map((row) => eventFromPayload(row.payload));
  }

  async readConversation(conversationId: string): Promise<ConversationMessage[]> {
    const events = await this.readEvents(conversationId);
    const messages: ConversationMessage[] = [];
    const modelAssistantRuns = new Set(
      events
        .filter((event): event is Extract<StoreEvent, { type: "conversation.model_message" }> => (
          event.type === "conversation.model_message"
          && event.message.role === "assistant"
        ))
        .map((event) => event.run_id)
    );
    for (const event of events) {
      if (event.type === "conversation.compacted" && event.replacement_history !== undefined) {
        messages.splice(0, messages.length, ...event.replacement_history);
      } else if (event.type === "conversation.model_message") {
        messages.push(event.message);
      } else if (event.type === "message.created") {
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
    const events = await this.readEvents(conversationId);
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
      if (event.type === "tool.call") {
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
          scope: event.scope ?? existing?.scope,
          skill_run_id: event.skill_run_id ?? existing?.skill_run_id,
          result: event.result ?? existing?.result,
          error: event.error ?? existing?.error,
          first_timestamp: existing?.first_timestamp ?? event.timestamp,
          timestamp: event.timestamp
        });
        toolCallsByRun.set(event.run_id, runTools);
      }
      if (event.type === "skill.activated") {
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
      if (event.type === "skill.invoked") {
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
      if (event.type === "skill.run") {
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
      .filter((event): event is Extract<StoreEvent, { type: "message.created" }> => event.type === "message.created")
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
    const events = await this.readEvents(conversationId);
    let state: {
      window_number?: number;
      first_window_id?: string;
      previous_window_id?: string;
      window_id?: string;
    } = {};
    for (const event of events) {
      if (event.type !== "conversation.compacted") {
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

export { PostgresStore as PostgresConversationStore, PostgresStore as PostgresRuntimeStore };

type PayloadRow = QueryResultRow & { payload: unknown };

function isQueryExecutor(value: unknown): value is PostgresQueryExecutor {
  return typeof value === "object"
    && value !== null
    && typeof (value as { query?: unknown }).query === "function";
}

function optionalStringField(event: StoreEvent, field: "conversation_id" | "run_id"): string | null {
  const value = (event as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function eventFromPayload(payload: unknown): StoreEvent {
  if (typeof payload === "string") {
    return JSON.parse(payload) as StoreEvent;
  }
  if (payload && typeof payload === "object") {
    return payload as StoreEvent;
  }
  throw new Error("Postgres conversation event payload is not a JSON object");
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
