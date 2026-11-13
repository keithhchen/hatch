import type { AgentMessage } from "@earendil-works/pi-agent-core";

type Block = { type: string; thinkingSignature?: string; thoughtSignature?: string; textSignature?: string };

const bare = (block: Block): Block => {
  const { thinkingSignature: _a, thoughtSignature: _b, textSignature: _c, ...rest } = block;
  return rest;
};

/**
 * A request-only view of the transcript for a model call: what the model thought in turns that are over (thinking blocks and
 * the provider signatures that vouch for them: Gemini `thoughtSignature`, Moonshot/DeepSeek `reasoning_content`) is dropped.
 * Providers want those back only inside the turn still running, whose tool loop must replay them intact; `earlier` says which
 * messages are the turns that are over. Stored history is never changed.
 */
export function withoutEarlierReasoning(messages: AgentMessage[], earlier: ReadonlySet<AgentMessage>): AgentMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !earlier.has(message)) return [message];
    const content = (message.content as Block[]).filter((block) => block.type !== "thinking").map(bare);
    return content.length ? [{ ...message, content } as AgentMessage] : [];
  });
}
