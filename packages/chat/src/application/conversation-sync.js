import {
  bridgeConversationHistory,
  drainConversationJournal,
  includeActiveConversationRun,
  mergeConversationPage,
  validateSnapshotPage
} from "../domain/snapshot.js";
import { ChatError } from "./errors.js";

/**
 * Serialized snapshot reconciliation for one Conversation at a time.
 * The first read takes the latest page; later reads drain the journal from
 * the committed cursor first, so a snapshot can never move the projection
 * behind state it has already shown. Reads are queued, so a slow response
 * cannot overtake a newer one.
 */
export class ConversationSync {
  constructor(transport) {
    this.transport = transport;
    this.epoch = 0;
    this.reset();
  }

  reset() {
    this.epoch += 1;
    this.cursor = null;
    this.queue = Promise.resolve();
  }

  /**
   * @param {string} conversationId
   * @param {{ current(): object[], activeRunId(): string|null, isCurrent(): boolean }} context
   * @returns {Promise<{snapshot: object, messages: object[]}|null>} null when superseded
   */
  refresh(conversationId, context) {
    const task = this.queue.then(() => this.read(conversationId, context));
    this.queue = task.catch(() => {});
    return task;
  }

  async read(conversationId, { current, activeRunId, isCurrent }) {
    const epoch = this.epoch;
    const live = () => epoch === this.epoch && isCurrent();
    const transport = this.transport;
    if (!live()) return null;
    const journalCursor = this.cursor === null
      ? 0
      : await drainConversationJournal(options => transport.events(conversationId, options), this.cursor, live);
    if (journalCursor === null || !live()) return null;
    const baseline = current();
    const snapshot = await transport.snapshot(conversationId);
    if (!live()) return null;
    if (snapshot?.conversation?.id !== conversationId) throw new ChatError("historyIdentityMismatch");
    let page = await bridgeConversationHistory(validateSnapshotPage(snapshot, journalCursor), baseline,
      options => transport.history(conversationId, options), live);
    if (!page) return null;
    page = await includeActiveConversationRun(page, activeRunId(), runId => transport.run(conversationId, runId), live);
    if (!page) return null;
    this.cursor = Math.max(this.cursor ?? 0, page.cursor);
    return { snapshot: page, messages: mergeConversationPage(current(), page.messages, { baseline }) };
  }
}
