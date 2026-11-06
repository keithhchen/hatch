import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messageText } from "../factoryAgents/imageRefs.js";
import type { MessageOrigin } from "../factoryAgents/store.js";
import type { PublicMessage } from "./conversation.js";

const originOf = (message: AgentMessage) => (message as { origin?: MessageOrigin }).origin;
const at = (message: AgentMessage) => new Date(message.timestamp ?? 0).toISOString();
/** Position in the session's append-only history: the id of any message nobody stamped. */
const positionId = (index: number) => `m${index + 1}`;

type AskUserDetails = { type?: string; questions?: Array<{ question: string; options?: Array<{ content: string }> }> };
const questionsOf = (message: AgentMessage): string[] => {
  const details = (message as { details?: AskUserDetails }).details;
  if (message.role !== "toolResult" || details?.type !== "askuser") return [];
  return (details.questions ?? []).map((q, i) => `${i + 1}. ${q.question}${q.options?.length ? ` (${q.options.map(o => o.content).join(" / ")})` : ""}`);
};
const textOf = (message: AgentMessage) => messageText(message).trim();

/** What the user said, or nothing for messages the host injected. */
function userLine(message: AgentMessage, index: number): PublicMessage | undefined {
  const origin = originOf(message);
  if (origin && origin.kind !== "expert") return undefined;
  const text = (origin?.text ?? textOf(message)).trim();
  if (!text) return undefined;
  const images = origin?.images?.map(file => file.split("/").pop()!) ?? [];
  return { id: origin?.itemId ?? positionId(index), role: "user", text, created_at: at(message), ...(images.length ? { attachments: images.map(name => ({ type: "image" as const, name })) } : {}) };
}

type Block = { type: string; name?: string };
/** A model message that calls tools other than askuser is a step in the turn, not its answer. */
const isStep = (message: AgentMessage) => {
  const content = (message as { content?: unknown }).content;
  const calls = (Array.isArray(content) ? content as Block[] : []).filter(block => block.type === "toolCall");
  return calls.length > 0 && !calls.some(call => call.name === "askuser");
};

/**
 * A session's history as a conversation: what the user said, and per turn the worker's final reply.
 * Tool calls, thinking, intermediate remarks, system prompts and host-injected context stay out.
 * Only messages that end a model loop count as replies, so a shown message never changes or goes
 * away while the turn goes on. Questions the worker asked with askuser are part of its reply.
 */
export function projectMessages(history: AgentMessage[]): PublicMessage[] {
  const out: PublicMessage[] = [];
  let reply: PublicMessage | undefined;
  let questions: string[] = [];
  const settle = () => {
    const text = [reply?.text, questions.join("\n")].filter(Boolean).join("\n\n");
    if (reply && text) out.push({ ...reply, text });
    reply = undefined; questions = [];
  };
  history.forEach((message, index) => {
    if (message.role === "user") { settle(); const line = userLine(message, index); if (line) out.push(line); }
    else if (message.role === "assistant") {
      const text = textOf(message);
      if (!isStep(message) && (text || !reply)) reply = { id: positionId(index), role: "assistant", text, created_at: at(message) };
    } else questions.push(...questionsOf(message));
  });
  settle();
  return out;
}
