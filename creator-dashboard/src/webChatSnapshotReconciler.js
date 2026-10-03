function messageIdentity(message) {
  return `${message.run_id}:${message.role}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function sameMessage(left, right) {
  return ["run_id", "role", "content", "timestamp", "attachments", "finish_reason", "parts", "tool_calls", "skill_events", "skill_runs"]
    .every(field => sameValue(left[field], right[field]));
}

function messageTime(message) {
  const value = Date.parse(message.timestamp ?? "");
  return Number.isFinite(value) ? value : 0;
}

export class WebChatSnapshotReconciler {
  constructor() {
    this.cursors = new Map();
  }

  reconcile(conversationId, currentMessages, snapshot) {
    const cursor = Number.isSafeInteger(snapshot.cursor) ? snapshot.cursor : Number.NaN;
    const previousCursor = this.cursors.get(conversationId) ?? -1;
    if (Number.isFinite(cursor) && cursor < previousCursor) {
      return { accepted: false, cursor: previousCursor, messages: currentMessages };
    }
    if (Number.isFinite(cursor)) this.cursors.set(conversationId, cursor);

    const unmatched = new Set(currentMessages);
    const serverMessages = (snapshot.messages ?? []).map(message => {
      const existing = currentMessages.find(candidate => unmatched.has(candidate) && candidate.id === message.id)
        ?? currentMessages.find(candidate => unmatched.has(candidate)
          && candidate.run_id === message.run_id
          && candidate.role === message.role
          && (candidate.optimistic || candidate.provisional || candidate.transient));
      if (existing) unmatched.delete(existing);
      const renderKey = existing?.renderKey ?? messageIdentity(message);
      if (existing && !existing.optimistic && !existing.provisional && !existing.transient && sameMessage(existing, message)) return existing;
      return { ...message, renderKey };
    });

    const retainedMessages = [...unmatched].filter(message => (
      message.optimistic || message.provisional || message.transient || Boolean(message.id)
    ));
    const nextMessages = [...retainedMessages, ...serverMessages]
      .sort((left, right) => messageTime(left) - messageTime(right));
    const unchanged = nextMessages.length === currentMessages.length
      && nextMessages.every((message, index) => message === currentMessages[index]);
    return {
      accepted: true,
      cursor: Number.isFinite(cursor) ? cursor : previousCursor,
      messages: unchanged ? currentMessages : nextMessages
    };
  }

  reset(conversationId) {
    this.cursors.delete(conversationId);
  }
}
