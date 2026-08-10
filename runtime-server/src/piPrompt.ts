import { createPiAgent } from "./piModel.js";

export type PiAgentPromptOptions = {
  systemPrompt?: string;
  prompt: string;
  temperature?: number;
  responseFormat?: unknown;
  signal?: AbortSignal;
};

export type PiAgentPromptRunner = (options: PiAgentPromptOptions) => Promise<string>;

/**
 * Run one product-owned subtask through the same Pi Agent primitive as the
 * main runtime. Product workflows may choose the prompt and provider payload,
 * but they do not get a second model client or a separate turn budget.
 */
export async function runPiAgentPrompt(options: PiAgentPromptOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const agent = createPiAgent({
    initialState: {
      systemPrompt: options.systemPrompt ?? "",
      messages: [],
      tools: []
    },
    agentOptions: {
      onPayload: async (payload) => {
        const next = { ...(payload as Record<string, unknown>) };
        if (options.temperature !== undefined) next.temperature = options.temperature;
        if (options.responseFormat !== undefined) next.response_format = options.responseFormat;
        return next;
      }
    }
  });
  const abort = (): void => agent.abort();
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    // Covers a cancellation that wins after Agent construction but before its
    // prompt owns an AbortController.
    options.signal?.throwIfAborted();
    await agent.prompt(options.prompt);
    options.signal?.throwIfAborted();
    const message = [...agent.state.messages]
      .reverse()
      .find((candidate) => candidate.role === "assistant");
    if (!message || message.role !== "assistant") {
      throw new Error("Pi Agent prompt ended without an assistant response");
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? `Pi Agent prompt stopped: ${message.stopReason}`);
    }
    const content = textContent(message.content);
    if (!content.trim()) throw new Error("Pi Agent prompt returned an empty response");
    return content;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    agent.abort();
  }
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .filter((block): block is { type: "text"; text: string } => (
      Boolean(block)
      && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("");
}
