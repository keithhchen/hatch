/**
 * Ports the chat application depends on. Each host (Web, Desktop) supplies
 * adapters; the package never knows about cookies, bearer tokens, Tauri,
 * access identifiers or routes. Base classes throw so a missing method fails
 * loudly instead of silently pretending to work.
 */
const unimplemented = (port, method) => { throw new Error(`${port}.${method} is not implemented`); };

/**
 * Durable Conversation API plus the live Runtime session. The adapter owns the
 * access scope (whatever the host binds a Conversation with) and auth.
 */
export class ConversationTransport {
  /** @param {string|null} cursor @returns {Promise<{conversations: object[], next_cursor?: string|null}>} */
  list(_cursor) { return unimplemented("ConversationTransport", "list"); }
  /** @param {{briefAnswers?: {field_id: string, value: string}[]}} input @returns {Promise<{conversation: object}>} */
  create(_input) { return unimplemented("ConversationTransport", "create"); }
  /** Latest `view=page` snapshot. @returns {Promise<object>} */
  snapshot(_conversationId) { return unimplemented("ConversationTransport", "snapshot"); }
  /** Older history page. @param {{beforeCursor: string}} options @returns {Promise<object>} */
  history(_conversationId, _options) { return unimplemented("ConversationTransport", "history"); }
  /** Journal page. @param {{afterCursor: number, throughCursor?: number}} options @returns {Promise<object>} */
  events(_conversationId, _options) { return unimplemented("ConversationTransport", "events"); }
  /** One durable Run. @returns {Promise<object>} */
  run(_conversationId, _runId) { return unimplemented("ConversationTransport", "run"); }
  /** Full tool detail for a stored `detail_ref`. @returns {Promise<{tool: object}>} */
  toolDetail(_conversationId, _detailRef) { return unimplemented("ConversationTransport", "toolDetail"); }
  /** A URL the view can load for a durable asset. @returns {string} */
  assetUrl(_conversationId, _assetId) { return unimplemented("ConversationTransport", "assetUrl"); }
  /**
   * Open the live Runtime session for one Conversation.
   * @param {string} conversationId
   * @param {{ onOpen(): void, onEvent(event: object): void, onClose(): void }} handlers
   * @returns {RuntimeConnection}
   */
  connect(_conversationId, _handlers) { return unimplemented("ConversationTransport", "connect"); }
}

/** One live Runtime session (protocol 0.8 client frames). */
export class RuntimeConnection {
  /** client.hello, declaring `localTools`. */
  hello(_localTools) { return unimplemented("RuntimeConnection", "hello"); }
  /** client.message. @param {{runId, clientMessageId, content?, attachments?, taskStart?, localTools}} message */
  send(_message) { return unimplemented("RuntimeConnection", "send"); }
  /** tool_call.result. */
  toolResult(_runId, _toolCallId, _result) { return unimplemented("RuntimeConnection", "toolResult"); }
  /** turn.cancel. */
  cancel(_runId) { return unimplemented("RuntimeConnection", "cancel"); }
  /** @returns {boolean} */
  get ready() { return unimplemented("RuntimeConnection", "ready"); }
  close() { return unimplemented("RuntimeConnection", "close"); }
}

/** Turns user-picked files into protocol attachments. */
export class AttachmentSource {
  /** Upper bound of attachments per message. */
  get limit() { return 8; }
  /** @param {string} mediaType @returns {boolean} whether the view shows it as a picture */
  accepts(_mediaType) { return unimplemented("AttachmentSource", "accepts"); }
  /** @param {File[]|object[]} files @returns {Promise<object[]>} protocol attachments */
  prepareAll(_files) { return unimplemented("AttachmentSource", "prepareAll"); }
}

/**
 * AttachmentViewer is a React component port:
 *   ({ src, alt, title, closeLabel, viewLabel, children }) => ReactNode
 * The package ships `ImageViewer` as the default implementation.
 */

/**
 * Executes Runtime tool requests on the client. `localTools` is the
 * capability declaration sent with hello/message; it is not a grant.
 * Results are protocol `tool_call.result` bodies: { status, result?, error? }.
 */
export class ToolExecutor {
  /** @returns {string[]} */
  get localTools() { return []; }
  /** @param {object} request tool_call.request @returns {Promise<{status: string, result?: any, error?: object}>} */
  execute(_request) { return unimplemented("ToolExecutor", "execute"); }
  /** Stop local work for a run. */
  cancel(_runId) { return unimplemented("ToolExecutor", "cancel"); }
  /** @param {object} request approval.request @returns {Promise<{approved: boolean, error?: object}>} */
  requestApproval(_request) { return unimplemented("ToolExecutor", "requestApproval"); }
}

/** Composer draft persistence: unsent text and files, per host-defined scope. */
export class DraftStore {
  /** @returns {{text: string, files: any[]}} */
  read(_scope) { return unimplemented("DraftStore", "read"); }
  write(_scope, _draft) { return unimplemented("DraftStore", "write"); }
}

/** A real in-memory DraftStore for hosts without durable drafts (Web today). */
export class MemoryDraftStore extends DraftStore {
  constructor() { super(); this.drafts = new Map(); }
  read(scope) { return this.drafts.get(scope) ?? { text: "", files: [] }; }
  write(scope, draft) { this.drafts.set(scope, draft); }
}
