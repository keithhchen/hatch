import { createHash } from "node:crypto";
import { replyMessageId } from "../conversationHistory.js";
import { protectedSkillPath, redactedToolOutput, redactedTrigger } from "./privateBoundary.js";
import type { RunStatus, StoreEvent, StoredFailure, VisibleConversationPart } from "../store.js";

/** What a client reads of the conversation's log: one event per row, at the row's position. */
export type PublicLogEvent = { position: number; type: string; run_id?: string; at: string; [field: string]: unknown };
export type LogRow = { position: number; event: StoreEvent };

/** A Run's status for a conversation written before every status change was a row: read from the Runs table at read time. */
export type LegacyRunState = { status: RunStatus; failure?: StoredFailure };

export const LOG_VALUE_CHARS = 2048;

/** A tool's arguments or result as the log keeps them: whole when small, otherwise its first 2 KB with `truncated`. The full detail is the tool-detail endpoint's. */
export function boundToolValue<T>(value: T): T | { truncated: true; text: string } {
  if (value === undefined || value === null) return value;
  const text = JSON.stringify(value);
  return text.length <= LOG_VALUE_CHARS ? value : { truncated: true, text: text.slice(0, LOG_VALUE_CHARS) };
}

const LOG_TYPES = new Set<StoreEvent["type"]>([
  "turn.state", "tool.call", "skill.activated", "skill.invoked", "skill.run", "assistant.text", "assistant.thinking", "reply.blocked",
  "message.queued", "compaction.started", "compaction.ended", "run.retrying", "run.superseded", "message.created"
]);

/** Rows the log can render. Everything else (session, runtime, skill sessions, compaction internals, the model's mid-turn messages) only advances positions. */
export const isLogRow = (event: StoreEvent): boolean => LOG_TYPES.has(event.type)
  || (event.type === "conversation.model_message"
    && ((event.message.role === "user" && event.message.kind !== "task_start") || (event.message.role === "assistant" && event.finish_reason !== undefined)));

/** SQL for the same predicate and for the same weight limits, so a page never loads what it will not show. */
export const LOG_ROW_SQL = `(event_type IN (${[...LOG_TYPES].map((type) => `'${type}'`).join(",")})
  OR (event_type = 'conversation.model_message' AND (
    (payload->'message'->>'role' = 'user' AND COALESCE(payload->'message'->>'kind', '') <> 'task_start')
    OR (payload->'message'->>'role' = 'assistant' AND payload->>'finish_reason' IS NOT NULL))))`;

const boundKey = (key: string): string => `CASE WHEN payload ? '${key}' AND octet_length((payload->'${key}')::text) > ${LOG_VALUE_CHARS}
  THEN jsonb_build_object('${key}', jsonb_build_object('truncated', true, 'text', left((payload->'${key}')::text, ${LOG_VALUE_CHARS}))) ELSE '{}'::jsonb END`;

export const LOG_PAYLOAD_SQL = `CASE
  WHEN event_type = 'tool.call' THEN payload || ${boundKey("arguments")} || ${boundKey("result")} || ${boundKey("error")}
  WHEN event_type = 'skill.activated' THEN payload - 'content'
  WHEN event_type = 'conversation.model_message' THEN
    jsonb_set(payload #- '{message,attachments}' #- '{message,model_images}', '{message}',
      ((payload->'message') - 'attachments' - 'model_images') || CASE WHEN jsonb_typeof(payload->'message'->'attachments') = 'array'
        THEN jsonb_build_object('attachments', (SELECT COALESCE(jsonb_agg(a - ARRAY['text','data_base64']), '[]'::jsonb)
          FROM jsonb_array_elements(payload->'message'->'attachments') a)) ELSE '{}'::jsonb END)
  ELSE payload END`;

type Entry = Record<string, unknown>;
type ToolRow = Extract<StoreEvent, { type: "tool.call" }>;
type SkillRow = Extract<StoreEvent, { type: "skill.activated" | "skill.invoked" | "skill.run" }>;
type ReplyRow = Extract<StoreEvent, { type: "conversation.model_message" }> & { visible_parts?: VisibleConversationPart[] };

const runIdOf = (event: StoreEvent): string | undefined => "run_id" in event ? event.run_id : undefined;
const hash = (...parts: unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const publicAttachments = (attachments: ReadonlyArray<object> | undefined) =>
  attachments?.length ? attachments.map((attachment) => "text" in attachment ? (({ text: _text, ...reference }: Record<string, unknown>) => reference)(attachment as Record<string, unknown>) : attachment) : undefined;

const toolFields = (tool: ToolRow): Entry => ({
  tool_call_id: tool.tool_call_id, name: tool.name, arguments: boundToolValue(tool.arguments), status: tool.status,
  ...(tool.activity_message !== undefined ? { activity_message: tool.activity_message } : {}),
  ...(tool.locality ? { locality: tool.locality } : {}), ...(tool.approval ? { approval: tool.approval } : {}),
  ...(tool.scope ? { scope: tool.scope } : {}), ...(tool.skill_run_id ? { skill_run_id: tool.skill_run_id } : {}),
  ...(tool.result !== undefined ? { result: boundToolValue(tool.result) } : {}), ...(tool.error !== undefined ? { error: boundToolValue(tool.error) } : {}),
  detail_ref: { run_id: tool.run_id, tool_call_id: tool.tool_call_id }
});

const skillFields = (event: SkillRow): Entry => {
  if (event.type === "skill.run") return { skill_run_id: event.skill_run_id, skill_id: event.skill_id, name: event.name, status: event.status, ...(event.error ? { error: event.error } : {}) };
  const common = { name: event.name, path: event.path, scope: event.scope, invocation_type: event.type === "skill.activated" ? event.invocation_type ?? "explicit" : event.invocation_type };
  return event.type === "skill.activated"
    ? { ...common, status: "activated", reason: event.reason ?? "explicit_mention", resource_paths: event.resource_paths ?? [], resource_manifest_truncated: event.resource_manifest_truncated ?? false }
    : { ...common, status: "invoked", reason: event.reason, source_tool_call_id: event.source_tool_call_id, trigger: event.trigger };
};

/** A tool call's rows merged as the history always merged them: the latest status, and anything an earlier row said that a later one did not. */
const mergedTool = (rows: ToolRow[]): ToolRow => rows.reduce((merged, row) => ({
  ...row,
  activity_message: row.activity_message ?? merged.activity_message, locality: row.locality ?? merged.locality, approval: row.approval ?? merged.approval,
  scope: row.scope ?? merged.scope, skill_run_id: row.skill_run_id ?? merged.skill_run_id, result: row.result ?? merged.result, error: row.error ?? merged.error
}));

type RunLegacy = { tools: Map<string, ToolRow[]>; skills: SkillRow[]; replies: ReplyRow[]; states: number; users: number };

/**
 * The public events of rows, oldest first: the one projection of the log, for HTTP pages and live frames alike.
 * `rows` may reach beyond what is shown: positions outside [from, to] only give context.
 *
 * Conversations written before the log carry a Run's reply as one model message with `visible_parts`, its steps as `tool.call`
 * and `skill.*` rows, and no `run_seq`. They are read, never rewritten: such a Run shows as one `assistant.reply` at its reply's
 * position, and a Run whose status was only ever "queued" takes its present status from `runStates`.
 */
export function publicLogEvents(rows: LogRow[], options: { from?: number; to?: number; modernRuns?: Set<string>; runStates?: Map<string, LegacyRunState> } = {}): PublicLogEvent[] {
  const { from = 0, to = Number.POSITIVE_INFINITY, runStates } = options;
  const modern = options.modernRuns ?? new Set(rows.flatMap(({ event }) => event.run_seq !== undefined && runIdOf(event) ? [runIdOf(event)!] : []));
  const legacy = new Map<string, RunLegacy>();
  const modelKeys = new Set<string>();
  for (const { event } of rows) {
    if (event.type === "conversation.model_message" && ((event.message.role === "user" && event.message.kind !== "task_start") || (event.message.role === "assistant" && event.finish_reason !== undefined))) {
      modelKeys.add(`${event.run_id}:${event.message.role}`);
    }
    const run = runIdOf(event);
    if (!run || modern.has(run)) continue;
    const state: RunLegacy = legacy.get(run) ?? { tools: new Map(), skills: [], replies: [], states: 0, users: 0 };
    legacy.set(run, state);
    if (event.type === "tool.call") state.tools.set(event.tool_call_id, [...state.tools.get(event.tool_call_id) ?? [], event]);
    else if (event.type === "skill.activated" || event.type === "skill.invoked" || event.type === "skill.run") state.skills.push(event);
    else if (event.type === "turn.state") state.states += 1;
    else if (event.type === "conversation.model_message" && event.message.role === "assistant" && event.finish_reason !== undefined) state.replies.push(event);
  }
  const events: PublicLogEvent[] = [];
  const replyOrdinal = new Map<string, number>();
  const userOrdinal = new Map<string, number>();
  for (const { position, event } of rows) {
    const run = runIdOf(event);
    const emit = (type: string, fields: Entry = {}) => { if (position >= from && position <= to) events.push({ position, type, ...(run ? { run_id: run } : {}), at: event.timestamp, ...fields }); };
    const old = run && !modern.has(run) ? legacy.get(run) : undefined;
    switch (event.type) {
      case "conversation.model_message": {
        const { message } = event;
        if (message.role === "user") {
          if (message.kind === "task_start") break;
          const ordinal = userOrdinal.get(event.run_id) ?? 0;
          userOrdinal.set(event.run_id, ordinal + 1);
          const attachments = publicAttachments(message.attachments);
          emit("user.message", { id: event.client_message_id ?? `msg_${hash(event.conversation_id, event.run_id, "user", ordinal)}`, content: message.typed ?? message.content ?? "", ...(attachments ? { attachments } : {}) });
        } else if (old && event.finish_reason !== undefined) {
          const ordinal = replyOrdinal.get(event.run_id) ?? 0;
          replyOrdinal.set(event.run_id, ordinal + 1);
          const entries = legacyEntries(event as ReplyRow, old, ordinal === 0);
          if (entries.length || event.finish_reason === "content_filter") emit("assistant.reply", { id: event.message_id ?? replyMessageId(event.run_id, ordinal + 1), entries, finish_reason: event.finish_reason });
        }
        break;
      }
      case "message.created": {
        if (modelKeys.has(`${event.run_id}:${event.role}`)) break;
        if (event.role === "user") emit("user.message", { id: `msg_${hash(event.conversation_id, event.run_id, "user", 0)}`, content: event.content, ...(publicAttachments(event.attachments) ? { attachments: publicAttachments(event.attachments) } : {}) });
        else emit("assistant.reply", { id: replyMessageId(event.run_id, 1), entries: [{ kind: "text", content: event.content }] });
        break;
      }
      case "turn.state": {
        const present = old && old.states === 1 && event.to === "queued" ? runStates?.get(event.run_id) : undefined;
        emit("run.state", {
          status: present?.status ?? event.to,
          ...(event.reason ? { reason: event.reason } : {}),
          ...((present?.failure ?? event.failure) ? { failure: present?.failure ?? event.failure } : {}),
          ...(event.finish_reason ? { finish_reason: event.finish_reason } : {}),
          ...(event.client_message_id ? { client_message_id: event.client_message_id } : {})
        });
        break;
      }
      case "message.queued": {
        const attachments = publicAttachments(event.message.attachments);
        emit("message.queued", { id: event.client_message_id, content: event.message.content, ...(attachments ? { attachments } : {}) });
        break;
      }
      case "tool.call":
        // A legacy Run that has a reply shows its steps inside it; one without shows each as it was.
        if (!old?.replies.length) emit("tool.call", toolFields(event));
        break;
      case "skill.activated": case "skill.invoked": case "skill.run":
        if (!old?.replies.length) emit(event.type, skillFields(event));
        break;
      case "assistant.text": emit("assistant.text", { content: event.content }); break;
      case "assistant.thinking": emit("assistant.thinking", { index: event.index, phase: event.phase, ...(event.delta !== undefined ? { delta: event.delta } : {}), ...(event.content !== undefined ? { content: event.content } : {}) }); break;
      case "reply.blocked": emit("reply.blocked"); break;
      case "compaction.started": case "compaction.ended":
        emit(event.type, { compaction_id: event.compaction_id, ...(event.degraded ? { degraded: true } : {}), ...(event.aborted ? { aborted: true } : {}), ...(event.window_id ? { window_id: event.window_id } : {}) });
        break;
      case "run.retrying": emit("run.retrying", { until: event.until }); break;
      case "run.superseded": emit("run.superseded", { by: event.by }); break;
      default: break;
    }
  }
  return events;
}

/** One old reply's parts, in the order they were shown: from `visible_parts` when the reply kept them, otherwise its words then its steps. */
function legacyEntries(reply: ReplyRow, run: RunLegacy, first: boolean): Entry[] {
  const text = reply.finish_reason === "content_filter" ? "" : reply.message.typed ?? reply.message.content ?? "";
  const tool = (id: string): Entry[] => run.tools.has(id) ? [{ kind: "tool", tool: toolFields(mergedTool(run.tools.get(id)!)) }] : [];
  if (reply.visible_parts) {
    return reply.visible_parts.flatMap((part): Entry[] => {
      if (part.type === "text") return text.slice(part.start, part.end) ? [{ kind: "text", content: text.slice(part.start, part.end) }] : [];
      if (part.type === "thinking") return [{ kind: "thinking", index: part.contentIndex, content: part.content }];
      if (part.type === "tool_call") return tool(part.tool_call_id);
      if (part.type === "skill_event") {
        const found = run.skills.find((skill) => skill.type !== "skill.run" && skillFields(skill).status === part.status && skill.name === part.name
          && (skill.type !== "skill.invoked" || skill.source_tool_call_id === part.source_tool_call_id));
        return found ? [{ kind: "skill", ...skillFields(found) }] : [];
      }
      const found = run.skills.find((skill) => skill.type === "skill.run" && skill.skill_run_id === part.skill_run_id);
      const latest = run.skills.filter((skill) => skill.type === "skill.run" && skill.skill_run_id === part.skill_run_id).at(-1) ?? found;
      return latest ? [{ kind: "skill_run", ...skillFields(latest) }] : [];
    });
  }
  return [...(text ? [{ kind: "text", content: text }] : []), ...(first ? [...run.tools.keys()].flatMap(tool) : [])];
}

/** The text a Run produced, as the model keeps it when the Run ends without a reply: its text rows, a paragraph apart where a step stood between. Nothing when the guard blocked it. */
export function runText(events: StoreEvent[], runId: string): string {
  let text = "";
  let stepSince = false;
  for (const event of events) {
    if (runIdOf(event) !== runId) continue;
    if (event.type === "reply.blocked") return "";
    if (event.type === "assistant.text") { text += (text && stepSince ? "\n\n" : "") + event.content; stepSince = false; }
    else if (event.type === "tool.call" || event.type === "skill.activated" || event.type === "skill.invoked" || event.type === "skill.run" || event.type === "assistant.thinking") stepSince = true;
  }
  return text;
}

/** What a buyer sees of the Expert's private corpus, applied to public events as it is to history. */
export function protectPublicLogEvents(events: PublicLogEvent[], productId: string): PublicLogEvent[] {
  const entry = (item: Entry): Entry => {
    if (item.kind === "tool") return { ...item, tool: protectTool(item.tool as Entry) };
    if (item.kind === "skill") return protectSkill(item);
    return item;
  };
  const protectTool = (tool: Entry): Entry => tool.locality === "server" && /^file[._]/.test(String(tool.name)) ? { ...tool, ...redactedToolOutput(tool.result) } : tool;
  const protectSkill = (skill: Entry): Entry => ({
    ...skill, path: protectedSkillPath(productId, String(skill.name)),
    ...(skill.resource_paths ? { resource_paths: [] } : {}), ...(skill.resource_manifest_truncated !== undefined ? { resource_manifest_truncated: false } : {}),
    ...(skill.trigger ? { trigger: redactedTrigger(skill.trigger as { path?: string }) } : {})
  });
  return events.map((event) => {
    if (event.type === "tool.call") return protectTool(event) as PublicLogEvent;
    if (event.type === "skill.activated" || event.type === "skill.invoked") return protectSkill(event) as PublicLogEvent;
    if (event.type === "assistant.reply") return { ...event, entries: (event.entries as Entry[]).map(entry) };
    return event;
  });
}

/** For a conversation whose page never shows a tool's arguments or result: the steps are named, not opened. */
export function withoutToolDetail(events: PublicLogEvent[]): PublicLogEvent[] {
  const strip = (tool: Entry): Entry => { const { result: _result, error: _error, ...rest } = tool; return { ...rest, arguments: {} }; };
  return events.map((event) => {
    if (event.type === "tool.call") return strip(event) as PublicLogEvent;
    if (event.type === "assistant.reply") return { ...event, entries: (event.entries as Entry[]).map((item) => item.kind === "tool" ? { ...item, tool: strip(item.tool as Entry) } : item) };
    return event;
  });
}

/** How a client asks for the log: the events after a position, or the latest turns (before a position). Paginated; never the whole history. */
export type LogQuery = { after: number; limit: number } | { turns: number; before?: number };
export const MAX_LOG_PAGE = 500;
export const MAX_LOG_TURNS = 50;

export function parseLogQuery(params: URLSearchParams, refuse: (message: string) => Error): LogQuery {
  const integer = (name: string, min: number, max: number): number | undefined => {
    const raw = params.get(name);
    if (raw === null) return undefined;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw refuse(`${name} must be an integer between ${min} and ${max}.`);
    return value;
  };
  const turns = integer("turns", 1, MAX_LOG_TURNS);
  if (turns !== undefined) {
    if (params.has("after") || params.has("limit")) throw refuse("Use either turns or after, not both.");
    const before = integer("before", 1, Number.MAX_SAFE_INTEGER);
    return { turns, ...(before !== undefined ? { before } : {}) };
  }
  if (params.has("before")) throw refuse("before goes with turns.");
  return { after: integer("after", 0, Number.MAX_SAFE_INTEGER) ?? 0, limit: integer("limit", 1, MAX_LOG_PAGE) ?? 200 };
}
