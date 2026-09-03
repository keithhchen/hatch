import { Pool, type QueryResultRow } from "pg";
import type { ConversationMessage } from "./protocol.js";
import {
  assertCanonicalPersistedToolNames,
  normalizePersistedStoreEvent,
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
CREATE TABLE IF NOT EXISTS hatch_conversation_usage (
  scope_key TEXT PRIMARY KEY,
  event_count BIGINT NOT NULL,
  total_bytes BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS hatch_runtime_store_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const POSTGRES_CONVERSATION_USAGE_MIGRATION = `
WITH claimed_migration AS (
  INSERT INTO hatch_runtime_store_migrations (version)
  VALUES ('conversation-usage-v1')
  ON CONFLICT (version) DO NOTHING
  RETURNING version
), historical_usage AS (
  SELECT
    'conversation:' || conversation_id AS scope_key,
    COUNT(*)::bigint AS event_count,
    COALESCE(SUM(octet_length(payload::text)), 0)::bigint AS total_bytes
  FROM claimed_migration
  CROSS JOIN hatch_conversation_events
  WHERE claimed_migration.version = 'conversation-usage-v1'
    AND conversation_id IS NOT NULL
  GROUP BY conversation_id
  UNION ALL
  SELECT
    'binding:' || substring(conversation_id FROM '^scope:([a-f0-9]{24}):') AS scope_key,
    COUNT(*)::bigint AS event_count,
    COALESCE(SUM(octet_length(payload::text)), 0)::bigint AS total_bytes
  FROM claimed_migration
  CROSS JOIN hatch_conversation_events
  WHERE claimed_migration.version = 'conversation-usage-v1'
    AND conversation_id ~ '^scope:[a-f0-9]{24}:'
  GROUP BY substring(conversation_id FROM '^scope:([a-f0-9]{24}):')
  UNION ALL
  SELECT
    'global' AS scope_key,
    COUNT(*)::bigint AS event_count,
    COALESCE(SUM(octet_length(payload::text)), 0)::bigint AS total_bytes
  FROM claimed_migration
  CROSS JOIN hatch_conversation_events
  WHERE claimed_migration.version = 'conversation-usage-v1'
  GROUP BY claimed_migration.version
)
INSERT INTO hatch_conversation_usage (scope_key, event_count, total_bytes)
SELECT scope_key, event_count, total_bytes
FROM historical_usage
ON CONFLICT (scope_key) DO UPDATE SET
  event_count = GREATEST(hatch_conversation_usage.event_count, EXCLUDED.event_count),
  total_bytes = GREATEST(hatch_conversation_usage.total_bytes, EXCLUDED.total_bytes);
`;

const INSERT_EVENT_SQL = `
WITH requested AS (
  SELECT scope_key, event_count, total_bytes, max_events, max_bytes
  FROM jsonb_to_recordset($5::jsonb) AS limits(
    scope_key TEXT,
    event_count BIGINT,
    total_bytes BIGINT,
    max_events BIGINT,
    max_bytes BIGINT
  )
), reserved AS (
  INSERT INTO hatch_conversation_usage (scope_key, event_count, total_bytes)
  SELECT scope_key, event_count, total_bytes
  FROM requested
  WHERE event_count <= max_events AND total_bytes <= max_bytes
  ON CONFLICT (scope_key) DO UPDATE SET
    event_count = hatch_conversation_usage.event_count + 1,
    total_bytes = hatch_conversation_usage.total_bytes + EXCLUDED.total_bytes
  WHERE hatch_conversation_usage.event_count + 1 <= (
      SELECT max_events FROM requested WHERE requested.scope_key = hatch_conversation_usage.scope_key
    )
    AND hatch_conversation_usage.total_bytes + EXCLUDED.total_bytes <= (
      SELECT max_bytes FROM requested WHERE requested.scope_key = hatch_conversation_usage.scope_key
    )
  RETURNING scope_key
), quota_assertion AS (
  SELECT 1 / CASE
    WHEN COUNT(*) = (SELECT COUNT(*) FROM requested) THEN 1
    ELSE 0
  END AS admitted
  FROM reserved
)
INSERT INTO hatch_conversation_events
  (conversation_id, run_id, event_type, payload)
SELECT $1, $2, $3, $4::jsonb
FROM quota_assertion
WHERE admitted = 1
RETURNING id
`;

const SELECT_PAYLOAD_SQL = `
SELECT payload
FROM hatch_conversation_events
`;

const REPLAY_WINDOW_STATS_SQL = `
WITH latest_checkpoint AS (
  SELECT COALESCE(MAX(id), 0) AS start_id
  FROM hatch_conversation_events
  WHERE conversation_id = $1 AND event_type = 'conversation.compacted'
)
SELECT
  latest_checkpoint.start_id::bigint AS start_id,
  COUNT(events.id)::bigint AS event_count,
  COALESCE(SUM(octet_length(events.payload::text)), 0)::bigint AS total_bytes
FROM latest_checkpoint
LEFT JOIN hatch_conversation_events AS events
  ON events.conversation_id = $1 AND events.id >= latest_checkpoint.start_id
GROUP BY latest_checkpoint.start_id
`;

const SELECT_REPLAY_WINDOW_SQL = `
WITH latest_checkpoint AS (
  SELECT COALESCE(MAX(id), 0) AS start_id
  FROM hatch_conversation_events
  WHERE conversation_id = $1 AND event_type = 'conversation.compacted'
)
SELECT events.payload
FROM hatch_conversation_events AS events
CROSS JOIN latest_checkpoint
WHERE events.conversation_id = $1 AND events.id >= latest_checkpoint.start_id
ORDER BY events.id ASC
LIMIT $2
`;

const VISIBLE_WINDOW_STATS_SQL = `
WITH visible_window AS (
  SELECT payload
  FROM hatch_conversation_events
  WHERE conversation_id = $1
  ORDER BY id DESC
  LIMIT $2
)
SELECT
  (SELECT COUNT(*) FROM hatch_conversation_events WHERE conversation_id = $1)::bigint AS total_count,
  COUNT(*)::bigint AS event_count,
  COALESCE(SUM(octet_length(payload::text)), 0)::bigint AS total_bytes
FROM visible_window
`;

const SELECT_VISIBLE_WINDOW_SQL = `
WITH visible_window AS (
  SELECT id, payload
  FROM hatch_conversation_events
  WHERE conversation_id = $1
  ORDER BY id DESC
  LIMIT $2
)
SELECT payload
FROM visible_window
ORDER BY id ASC
`;

export type PostgresStoreOptions = {
  connectionString?: string;
  /** Alias for callers that use the existing RegistryStore option name. */
  databaseUrl?: string;
  pool?: PostgresQueryExecutor;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  queryTimeoutMs?: number;
  statementTimeoutMs?: number;
  maxConversationEvents?: number;
  maxConversationBytes?: number;
  maxGlobalEvents?: number;
  maxGlobalBytes?: number;
  maxScopeEvents?: number;
  maxScopeBytes?: number;
  maxReplayEvents?: number;
  maxReplayBytes?: number;
  environment?: NodeJS.ProcessEnv;
};

export class PostgresStore extends RuntimeStore {
  readonly pool: PostgresQueryExecutor;

  private readonly ownsPool: boolean;
  private readonly queryTimeoutMs: number;
  private readonly maxConversationEvents: number;
  private readonly maxConversationBytes: number;
  private readonly maxGlobalEvents: number;
  private readonly maxGlobalBytes: number;
  private readonly maxScopeEvents: number;
  private readonly maxScopeBytes: number;
  private readonly maxReplayEvents: number;
  private readonly maxReplayBytes: number;
  private schemaPromise: Promise<void> | undefined;
  private readonly appendChains = new Map<string, Promise<void>>();
  private readonly pendingAppends = new Set<Promise<void>>();

  constructor(connectionString?: string);
  constructor(options?: PostgresStoreOptions);
  constructor(pool: PostgresQueryExecutor);
  constructor(input: string | PostgresStoreOptions | PostgresQueryExecutor = {}) {
    // RuntimeStore is the compatibility surface consumed by the existing
    // broker/state machine. Its filesystem root is never used because every
    // overridden persistence method below writes to Postgres.
    super();
    if (typeof input === "string") {
      this.queryTimeoutMs = 5_000;
      this.maxConversationEvents = 10_000;
      this.maxConversationBytes = 64 * 1024 * 1024;
      this.maxGlobalEvents = 1_000_000;
      this.maxGlobalBytes = 1024 * 1024 * 1024;
      this.maxScopeEvents = 100_000;
      this.maxScopeBytes = 256 * 1024 * 1024;
      this.maxReplayEvents = 2_000;
      this.maxReplayBytes = 8 * 1024 * 1024;
      this.pool = new Pool({
        connectionString: input,
        connectionTimeoutMillis: 5_000,
        query_timeout: 5_000,
        statement_timeout: 5_000
      });
      this.ownsPool = true;
      return;
    }

    if (isQueryExecutor(input)) {
      this.queryTimeoutMs = 5_000;
      this.maxConversationEvents = 10_000;
      this.maxConversationBytes = 64 * 1024 * 1024;
      this.maxGlobalEvents = 1_000_000;
      this.maxGlobalBytes = 1024 * 1024 * 1024;
      this.maxScopeEvents = 100_000;
      this.maxScopeBytes = 256 * 1024 * 1024;
      this.maxReplayEvents = 2_000;
      this.maxReplayBytes = 8 * 1024 * 1024;
      this.pool = input;
      this.ownsPool = false;
      return;
    }

    const environment = input.environment ?? process.env;
    this.queryTimeoutMs = boundedDatabaseSetting(
      input.queryTimeoutMs,
      environment.HATCH_RUNTIME_DATABASE_QUERY_TIMEOUT_MS,
      5_000,
      "HATCH_RUNTIME_DATABASE_QUERY_TIMEOUT_MS"
    );
    this.maxConversationEvents = boundedDatabaseSetting(
      input.maxConversationEvents,
      environment.HATCH_RUNTIME_MAX_CONVERSATION_EVENTS,
      10_000,
      "HATCH_RUNTIME_MAX_CONVERSATION_EVENTS",
      1,
      1_000_000
    );
    this.maxConversationBytes = boundedDatabaseSetting(
      input.maxConversationBytes,
      environment.HATCH_RUNTIME_MAX_CONVERSATION_BYTES,
      64 * 1024 * 1024,
      "HATCH_RUNTIME_MAX_CONVERSATION_BYTES",
      1_024,
      1024 * 1024 * 1024
    );
    this.maxGlobalEvents = boundedDatabaseSetting(
      input.maxGlobalEvents,
      environment.HATCH_RUNTIME_MAX_GLOBAL_EVENTS,
      1_000_000,
      "HATCH_RUNTIME_MAX_GLOBAL_EVENTS",
      1,
      10_000_000
    );
    this.maxGlobalBytes = boundedDatabaseSetting(
      input.maxGlobalBytes,
      environment.HATCH_RUNTIME_MAX_GLOBAL_EVENT_BYTES,
      1024 * 1024 * 1024,
      "HATCH_RUNTIME_MAX_GLOBAL_EVENT_BYTES",
      1_024,
      1024 * 1024 * 1024
    );
    this.maxScopeEvents = boundedDatabaseSetting(
      input.maxScopeEvents,
      environment.HATCH_RUNTIME_MAX_SCOPE_EVENTS,
      100_000,
      "HATCH_RUNTIME_MAX_SCOPE_EVENTS",
      1,
      10_000_000
    );
    this.maxScopeBytes = boundedDatabaseSetting(
      input.maxScopeBytes,
      environment.HATCH_RUNTIME_MAX_SCOPE_EVENT_BYTES,
      256 * 1024 * 1024,
      "HATCH_RUNTIME_MAX_SCOPE_EVENT_BYTES",
      1_024,
      1024 * 1024 * 1024
    );
    this.maxReplayEvents = boundedDatabaseSetting(
      input.maxReplayEvents,
      environment.HATCH_RUNTIME_MAX_REPLAY_EVENTS,
      2_000,
      "HATCH_RUNTIME_MAX_REPLAY_EVENTS",
      1,
      100_000
    );
    this.maxReplayBytes = boundedDatabaseSetting(
      input.maxReplayBytes,
      environment.HATCH_RUNTIME_MAX_HISTORY_BYTES,
      8 * 1024 * 1024,
      "HATCH_RUNTIME_MAX_HISTORY_BYTES",
      1_024,
      256 * 1024 * 1024
    );

    if (input.pool) {
      this.pool = input.pool;
      this.ownsPool = false;
      return;
    }

    const connectionString = input.connectionString
      ?? input.databaseUrl
      ?? environment.HATCH_RUNTIME_DATABASE_URL;
    if (!connectionString) {
      throw new Error("Postgres conversation store requires a database connection string");
    }
    this.pool = new Pool({
      connectionString,
      ...(input.maxConnections === undefined ? {} : { max: input.maxConnections }),
      connectionTimeoutMillis: boundedDatabaseSetting(
        input.connectionTimeoutMs,
        environment.HATCH_RUNTIME_DATABASE_CONNECTION_TIMEOUT_MS,
        5_000,
        "HATCH_RUNTIME_DATABASE_CONNECTION_TIMEOUT_MS"
      ),
      query_timeout: this.queryTimeoutMs,
      statement_timeout: boundedDatabaseSetting(
        input.statementTimeoutMs,
        environment.HATCH_RUNTIME_DATABASE_STATEMENT_TIMEOUT_MS,
        5_000,
        "HATCH_RUNTIME_DATABASE_STATEMENT_TIMEOUT_MS"
      )
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
      this.schemaPromise = (async () => {
        await this.query(POSTGRES_CONVERSATION_STORE_SCHEMA);
        await this.query(POSTGRES_CONVERSATION_USAGE_MIGRATION);
      })();
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
    await Promise.allSettled([...this.pendingAppends]);
    if (this.ownsPool) {
      await this.pool.end?.();
    }
  }

  async append(event: PostgresStoreEventInput): Promise<void> {
    assertCanonicalPersistedToolNames(event);
    const record = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString()
    } as StoreEvent;
    const conversationId = optionalStringField(record, "conversation_id");
    const serializationKey = conversationId ? `conversation:${conversationId}` : "global-session-events";
    const previous = this.appendChains.get(serializationKey) ?? Promise.resolve();
    const write = previous.then(async () => {
      await this.ensureSchema();
      const payload = JSON.stringify(record);
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      const reservations: QuotaReservation[] = [{
        scope_key: "global",
        event_count: 1,
        total_bytes: payloadBytes,
        max_events: this.maxGlobalEvents,
        max_bytes: this.maxGlobalBytes
      }];
      const bindingScopeKey = conversationId ? boundConversationScopeKey(conversationId) : undefined;
      if (bindingScopeKey) {
        reservations.push({
          scope_key: bindingScopeKey,
          event_count: 1,
          total_bytes: payloadBytes,
          max_events: this.maxScopeEvents,
          max_bytes: this.maxScopeBytes
        });
      }
      if (conversationId) {
        reservations.push({
          scope_key: `conversation:${conversationId}`,
          event_count: 1,
          total_bytes: payloadBytes,
          max_events: this.maxConversationEvents,
          max_bytes: this.maxConversationBytes
        });
      }
      let result: { rows: QueryResultRow[] };
      try {
        result = await this.query<QueryResultRow>(INSERT_EVENT_SQL, [
          conversationId,
          optionalStringField(record, "run_id"),
          record.type,
          payload,
          JSON.stringify(reservations)
        ]);
      } catch (error) {
        if (isQuotaAssertionFailure(error)) throw storageQuotaError(conversationId);
        throw error;
      }
      if (result.rows.length === 0) {
        throw storageQuotaError(conversationId);
      }
    });
    const tail = write.catch(() => undefined);
    this.appendChains.set(serializationKey, tail);
    this.pendingAppends.add(write);
    void write.then(
      () => this.finishAppend(serializationKey, tail, write),
      () => this.finishAppend(serializationKey, tail, write)
    );
    await write;
  }

  async readEvents(conversationId?: string): Promise<StoreEvent[]> {
    if (conversationId === undefined) await Promise.allSettled([...this.pendingAppends]);
    else await this.waitForConversationAppends(conversationId);
    await this.ensureSchema();
    const result = conversationId === undefined
      ? await this.query<PayloadRow>(`${SELECT_PAYLOAD_SQL}ORDER BY id ASC`)
      : await this.query<PayloadRow>(`${SELECT_PAYLOAD_SQL}WHERE conversation_id = $1 ORDER BY id ASC`, [conversationId]);
    return result.rows.map((row) => eventFromPayload(row.payload));
  }

  async readConversation(conversationId: string): Promise<ConversationMessage[]> {
    const events = await this.readReplayEvents(conversationId);
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
          content: event.content,
          ...(event.attachments?.length ? { attachments: event.attachments } : {})
        });
      }
    }
    return messages;
  }

  async readVisibleConversation(conversationId: string): Promise<VisibleConversationMessage[]> {
    const events = await this.readVisibleEvents(conversationId);
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
          invocation_type: event.invocation_type ?? "explicit",
          reason: event.reason ?? "explicit_mention",
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

    const latestMessageCreatedIndex = new Map<string, number>();
    events.forEach((event, index) => {
      if (event.type === "message.created") {
        latestMessageCreatedIndex.set(`${event.run_id}:${event.role}`, index);
      }
    });
    const preferredModelVisibleKeys = new Set(
      events
        .filter((event): event is Extract<StoreEvent, { type: "conversation.model_message" }> => (
          event.type === "conversation.model_message"
          && (
            (event.message.role === "user" && event.message.kind !== "task_start")
            || (event.message.role === "assistant" && event.finish_reason !== undefined)
          )
        ))
        .map((event) => `${event.run_id}:${event.message.role}`)
    );
    const visibleEvents = events.filter((event, index): event is (
      Extract<StoreEvent, { type: "message.created" }>
      | Extract<StoreEvent, { type: "conversation.model_message" }>
    ) => {
      if (event.type === "conversation.model_message") {
        return (event.message.role === "user" && event.message.kind !== "task_start")
          || (event.message.role === "assistant" && (
            event.finish_reason !== undefined
            || index > (latestMessageCreatedIndex.get(`${event.run_id}:${event.message.role}`) ?? -1)
          ));
      }
      if (event.type === "message.created") {
        return !preferredModelVisibleKeys.has(`${event.run_id}:${event.role}`);
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
        const attachments = event.type === "conversation.model_message"
          ? event.message.attachments
          : event.attachments;
        if (attachments?.length) {
          message.attachments = attachments.map((attachment) => {
            if ("text" in attachment) {
              const { text: _text, ...reference } = attachment;
              return reference;
            }
            return attachment;
          });
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

  async visibleConversationTruncated(conversationId: string): Promise<boolean> {
    await this.waitForConversationAppends(conversationId);
    await this.ensureSchema();
    const stats = await this.query<VisibleWindowStatsRow>(VISIBLE_WINDOW_STATS_SQL, [
      conversationId,
      this.maxReplayEvents
    ]);
    return numericRowValue(stats.rows[0]?.total_count) > this.maxReplayEvents;
  }

  async readCompactionState(conversationId: string): Promise<{
    window_number?: number;
    first_window_id?: string;
    previous_window_id?: string;
    window_id?: string;
  }> {
    const events = await this.readReplayEvents(conversationId);
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

  private async readReplayEvents(conversationId: string): Promise<StoreEvent[]> {
    await this.waitForConversationAppends(conversationId);
    await this.ensureSchema();
    const stats = await this.query<ReplayWindowStatsRow>(REPLAY_WINDOW_STATS_SQL, [conversationId]);
    const eventCount = numericRowValue(stats.rows[0]?.event_count);
    const totalBytes = numericRowValue(stats.rows[0]?.total_bytes);
    if (eventCount > this.maxReplayEvents || totalBytes > this.maxReplayBytes) {
      throw new Error("Conversation replay window exceeds the bounded history limit; compact or start a new conversation.");
    }
    const result = await this.query<PayloadRow>(SELECT_REPLAY_WINDOW_SQL, [
      conversationId,
      this.maxReplayEvents
    ]);
    return result.rows.map((row) => eventFromPayload(row.payload));
  }

  private async readVisibleEvents(conversationId: string): Promise<StoreEvent[]> {
    await this.waitForConversationAppends(conversationId);
    await this.ensureSchema();
    const stats = await this.query<ConversationQuotaRow>(VISIBLE_WINDOW_STATS_SQL, [
      conversationId,
      this.maxReplayEvents
    ]);
    const totalBytes = numericRowValue(stats.rows[0]?.total_bytes);
    if (totalBytes > this.maxReplayBytes) {
      throw new Error("Visible conversation window exceeds the bounded history limit.");
    }
    const result = await this.query<PayloadRow>(SELECT_VISIBLE_WINDOW_SQL, [
      conversationId,
      this.maxReplayEvents
    ]);
    return result.rows.map((row) => eventFromPayload(row.payload));
  }

  private query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[] }> {
    const pending = this.pool.query<T>(text, values);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Postgres Runtime query timed out after ${this.queryTimeoutMs}ms`));
      }, this.queryTimeoutMs);
      pending.then(
        (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      );
    });
  }

  private async waitForConversationAppends(conversationId: string): Promise<void> {
    await this.appendChains.get(`conversation:${conversationId}`);
  }

  private finishAppend(scopeKey: string, tail: Promise<void>, write: Promise<void>): void {
    this.pendingAppends.delete(write);
    if (this.appendChains.get(scopeKey) === tail) this.appendChains.delete(scopeKey);
  }
}

export { PostgresStore as PostgresConversationStore, PostgresStore as PostgresRuntimeStore };

type PayloadRow = QueryResultRow & { payload: unknown };
type ConversationQuotaRow = QueryResultRow & { event_count: string | number; total_bytes: string | number };
type ReplayWindowStatsRow = ConversationQuotaRow & { start_id: string | number };
type VisibleWindowStatsRow = ConversationQuotaRow & { total_count: string | number };
type QuotaReservation = {
  scope_key: string;
  event_count: number;
  total_bytes: number;
  max_events: number;
  max_bytes: number;
};

function isQueryExecutor(value: unknown): value is PostgresQueryExecutor {
  return typeof value === "object"
    && value !== null
    && typeof (value as { query?: unknown }).query === "function";
}

function numericRowValue(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Postgres Runtime returned an invalid quota value");
  }
  return parsed;
}

function boundedDatabaseSetting(
  explicit: number | undefined,
  environmentValue: string | undefined,
  fallback: number,
  name: string,
  minimum = 1,
  maximum = 300_000
): number {
  const value = explicit ?? (environmentValue?.trim() ? Number(environmentValue) : fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalStringField(event: StoreEvent, field: "conversation_id" | "run_id"): string | null {
  const value = (event as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function boundConversationScopeKey(conversationId: string): string | undefined {
  const match = conversationId.match(/^scope:([a-f0-9]{24}):/);
  return match?.[1] ? `binding:${match[1]}` : undefined;
}

function isQuotaAssertionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === "22012" || (typeof value.message === "string" && /division by zero/i.test(value.message));
}

function storageQuotaError(conversationId: string | null): Error {
  return new Error(conversationId
    ? "Conversation storage quota exceeded for this conversation or access binding; start a new conversation or remove old history."
    : "Runtime global event storage quota exceeded.");
}

function eventFromPayload(payload: unknown): StoreEvent {
  if (typeof payload === "string") {
    return normalizePersistedStoreEvent(JSON.parse(payload) as StoreEvent);
  }
  if (payload && typeof payload === "object") {
    return normalizePersistedStoreEvent(payload as StoreEvent);
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
