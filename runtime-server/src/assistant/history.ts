import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChannelKind } from "../channels/types.js";
import type { MessageOrigin, WorkbenchBackend } from "../factoryAgents/store.js";
import type { RuntimeStore } from "../store.js";
import { SYSTEM_MESSAGE_PREFIX } from "./systemMessage.js";
import type { AssistantStateRepository, LastExpert } from "./state.js";

/** The shape the old conversation kept its own state in. Only this read-time boundary knows it. */
type LegacyDesk = { lastExpert?: LastExpert & { source: "web" | ChannelKind } };

/** The Assistant used to keep its conversation in its workspace's session. That session is read once, here, and never again. */
const textOf = (message: AgentMessage): string => {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((block): block is { type: "text"; text: string } => block?.type === "text").map(block => block.text).join("") : "";
};
const originOf = (message: AgentMessage) => (message as { origin?: MessageOrigin }).origin;
const hasToolCall = (message: AgentMessage): boolean => {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) && content.some(block => block?.type === "toolCall");
};

/**
 * The one-time import of an account's Assistant history into Chat. The boundary is read-time and one-way: what the old
 * conversation said becomes the first messages of the Chat conversation, where the Expert last
 * spoke moves to the Assistant's state, and the old session keeps only the files the Expert gave. Nothing is written twice.
 */
export class LegacyAssistantHistory {
  constructor(private readonly deps: {
    backend: (accountId: string) => WorkbenchBackend;
    state: AssistantStateRepository;
    store: Pick<RuntimeStore, "append" | "readConversation">;
  }) {}

  async importInto(accountId: string, conversationId: string): Promise<void> {
    const backend = this.deps.backend(accountId);
    const id = (await Promise.all((await backend.listIds()).map(async candidate => ({ id: candidate, loaded: await backend.load(candidate) }))))
      .find(entry => entry.loaded.session.role === "assistant");
    if (!id) return;
    const { messages } = id.loaded.session;
    const assistantDesk = (id.loaded.session as { assistantDesk?: LegacyDesk }).assistantDesk;
    const imported = (await this.deps.store.readConversation(conversationId)).length > 0;
    if (!imported) await this.append(conversationId, messages);
    if (assistantDesk?.lastExpert) await this.deps.state.expertSpoke(accountId, assistantDesk.lastExpert);
    if (messages.length || assistantDesk) await backend.transact(id.id, session => { session.messages = []; session.context = []; delete (session as { assistantDesk?: LegacyDesk }).assistantDesk; });
  }

  private async append(conversationId: string, messages: AgentMessage[]): Promise<void> {
    let turn = 0;
    for (const message of messages) {
      const timestamp = new Date(message.timestamp ?? Date.now()).toISOString();
      if (message.role === "user") {
        const origin = originOf(message);
        const expert = origin?.kind === "expert";
        const text = expert ? origin.text?.trim() || (origin.images?.length ? "（发了一张图片）" : "") : textOf(message).trim();
        if (!text) continue;
        turn += 1;
        const key = `legacy:${origin?.itemId ?? turn}`;
        await this.deps.store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: `legacy-${turn}`, client_message_id: expert ? key : `${SYSTEM_MESSAGE_PREFIX}${key}`, message: { role: "user", content: text }, timestamp });
      } else if (message.role === "assistant" && !hasToolCall(message) && turn > 0) {
        const text = textOf(message).trim();
        if (text) await this.deps.store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: `legacy-${turn}`, message: { role: "assistant", content: text }, finish_reason: "stop", timestamp });
      }
    }
  }
}
