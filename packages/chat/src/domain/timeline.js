/**
 * Entries of an assistant reply: text, thinking, tool (incl. approval state), skill and skill_run. The reply's entries are
 * built by the one fold over the conversation log (chat-log.js); these are the shapes and the pure helpers it uses.
 */
export const ACTIVITY_KINDS = Object.freeze(["thinking", "tool", "skill", "skill_run"]);
const activityKinds = new Set(ACTIVITY_KINDS);

export function skillEntryId(event) {
  return event.status === "invoked"
    ? ["skill", event.run_id, "invoked", event.source_tool_call_id ?? "", event.path, event.reason].join(":")
    : ["skill", event.run_id, "activated", event.path, event.reason].join(":");
}

export function skillRunEntryId(event) {
  return ["skill-run", event.run_id, event.skill_run_id].join(":");
}

/** A step never goes backwards: an answer older than what the page already heard leaves a finished step finished. */
const STATUS_ORDER = { requested: 0, running: 1, completed: 2, failed: 2, cancelled: 2 };
export const laterStatus = (previous, next) => {
  if (!next) return previous ?? "requested";
  return previous && (STATUS_ORDER[previous] ?? 0) > (STATUS_ORDER[next] ?? 0) ? previous : next;
};

/** The tool entry for a `tool.call` event, over the entry it updates. */
export function toolEntry(event, previous) {
  const content = previous?.content;
  return {
    kind: "tool",
    id: previous?.id ?? `tool-${event.tool_call_id}`,
    title: (event.name ?? content?.name ?? "tool").replaceAll("_", " "),
    content: {
      runId: event.run_id ?? content?.runId,
      toolCallId: event.tool_call_id,
      name: event.name ?? content?.name ?? "tool",
      activityMessage: event.activity_message ?? content?.activityMessage,
      arguments: event.arguments ?? content?.arguments ?? {},
      locality: event.locality ?? content?.locality,
      approval: event.approval ?? content?.approval,
      result: event.result ?? content?.result,
      error: event.error ?? content?.error,
      detailRef: event.detail_ref ?? content?.detailRef
    },
    status: laterStatus(previous?.status, event.status)
  };
}

/** skill.activated / skill.invoked. */
export const skillEntry = event => {
  const id = skillEntryId(event);
  return { kind: "skill", id, title: event.name, status: event.status, content: { runId: event.run_id, name: event.name, path: event.path, reason: event.reason, sourceToolCallId: event.source_tool_call_id, invocationType: event.invocation_type } };
};

/** skill.run, over the entry it updates. */
export const skillRunEntry = (event, previous) => {
  const id = skillRunEntryId(event);
  return { kind: "skill_run", id, title: event.name, status: laterStatus(previous?.status, event.status), content: { runId: event.run_id, skillRunId: event.skill_run_id, skillId: event.skill_id, name: event.name, error: event.error } };
};

/**
 * Consecutive activity entries collapse into one activity group. Entries the
 * `standalone` predicate selects (e.g. a tool awaiting approval) stay their
 * own row so their controls are never hidden behind the group.
 */
export function groupTimelineEntries(entries, standalone = () => false) {
  const groupable = entry => activityKinds.has(entry.kind) && !standalone(entry);
  const grouped = [];
  for (let index = 0; index < entries.length;) {
    if (!groupable(entries[index])) {
      grouped.push(entries[index++]);
      continue;
    }
    const activities = [];
    while (index < entries.length && groupable(entries[index])) activities.push(entries[index++]);
    grouped.push({ kind: "activity_group", id: "activity-group-" + activities[0].id, entries: activities });
  }
  return grouped;
}

/**
 * Steps that no text interrupts are one row, even when they span replies: a reply that starts with steps joins the reply
 * before it when that one ended with steps. `kinds` are the activity kinds the host shows; empty thinking and blank text
 * count as nothing.
 */
export function foldStepOnlyMessages(messages, kinds = ACTIVITY_KINDS) {
  const shown = entry => !(entry.kind === "thinking" && !entry.streaming && !entry.content?.trim()) && !(entry.kind === "text" && !String(entry.content ?? "").trim())
    && (!ACTIVITY_KINDS.includes(entry.kind) || kinds.includes(entry.kind));
  const isStep = entry => entry !== undefined && kinds.includes(entry.kind);
  const folded = [];
  for (const message of messages) {
    const last = folded.at(-1);
    if (last?.role === "assistant" && message.role === "assistant" && isStep(last.timeline.filter(shown).at(-1)) && isStep(message.timeline.filter(shown)[0])) {
      folded[folded.length - 1] = { ...last, timeline: [...last.timeline, ...message.timeline], transient: message.transient };
    } else folded.push(message);
  }
  return folded;
}

/**
 * A message the user submitted that the log does not carry yet. `clientMessageId` is minted when the user sends and is the
 * message's id everywhere: the log's `user.message` (or `message.queued`) with that id replaces the placeholder.
 */
export class PendingSubmission {
  constructor({ conversationId, runId, clientMessageId, content, attachments, files }) {
    this.conversationId = conversationId;
    this.runId = runId;
    this.clientMessageId = clientMessageId;
    this.content = content;
    this.attachments = attachments;
    this.files = files;
    /** The user must send again: the send failed in a way that may or may not have reached the server. */
    this.awaitingUser = false;
    /** Handed to the transport on this connection; a transport that outlives its connection does not hand it twice. */
    this.dispatched = false;
    /** This message started the Run, rather than joining one that was already running. */
    this.leadsRun = false;
    /** The server took it while a Run was going: it waits, queued, until the Run takes it up. */
    this.queued = false;
  }

  /** What survives a page reload: the words and the already-uploaded attachments, never the files. */
  record() {
    return { conversationId: this.conversationId, clientMessageId: this.clientMessageId, content: this.content, attachments: this.attachments };
  }

  static fromRecord(record, { runId }) {
    return new PendingSubmission({ ...record, runId, files: [] });
  }

  optimisticMessage() {
    return {
      id: this.clientMessageId,
      renderKey: this.clientMessageId,
      run_id: this.runId,
      role: "user",
      content: this.content,
      timestamp: new Date().toISOString(),
      attachments: this.attachments.map(({ text: _text, data_base64: _data, ...attachment }) => attachment),
      optimistic: true,
      state: this.queued ? "queued" : "sending"
    };
  }
}
