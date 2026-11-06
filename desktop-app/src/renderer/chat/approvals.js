import { Observable } from "../observable.js";

/**
 * Window-wide queue of local tool calls the native gate is holding for the
 * user. Each conversation's executor adds requests; the conversation view
 * answers them inline, the sidebar shows a badge per conversation, and the
 * attention port turns the count into a Dock badge / notification.
 */
export class ApprovalCenter extends Observable {
  constructor({ onRequest = () => {} } = {}) {
    super({ pending: [] });
    this.onRequest = onRequest;
  }

  /** @returns {Promise<boolean>} the user's decision */
  ask({ conversationId, agentKey, request }) {
    return new Promise(resolve => {
      const entry = {
        id: `${conversationId}:${request.tool_call_id}`,
        conversationId,
        agentKey,
        request,
        decide: approved => {
          this.remove(entry.id);
          resolve(approved);
        }
      };
      this.setState(state => ({ pending: [...state.pending.filter(item => item.id !== entry.id), entry] }));
      this.onRequest(entry);
    });
  }

  remove(id) {
    this.setState(state => ({ pending: state.pending.filter(item => item.id !== id) }));
  }

  /** Deny everything a conversation still holds (it closed or disconnected). */
  denyAll(conversationId) {
    for (const entry of this.state.pending.filter(item => item.conversationId === conversationId)) entry.decide(false);
  }

  countFor(conversationId) {
    return this.state.pending.filter(item => item.conversationId === conversationId).length;
  }
}
