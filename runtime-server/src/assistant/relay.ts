import type { AgentRuntime, RunContext } from "../agentRuntime.js";
import type { OutboundMessage, RunStart } from "../protocol.js";
import type { AssistantStateRepository, Interview } from "./state.js";

/** A message the Assistant did not get from the Expert has a client message id that starts with this. */
export const SYSTEM_MESSAGE_PREFIX = "sys:";
export const isSystemMessageId = (id: string | undefined): boolean => Boolean(id?.startsWith(SYSTEM_MESSAGE_PREFIX));

/** What an interview's own words arrive as: the Assistant says them as they are, without a model. */
export const RELAY_MARK = "[访谈] ";

/** Port: where the Expert's words go while an interview holds the conversation. */
export interface InterviewDesk {
  tell(accountId: string, interview: Interview, text: string): Promise<void>;
}

/**
 * The Assistant's runtime while an interview holds its conversation. It is not a model: the Expert's words go to the
 * interview, and the interview's words, which arrive as relay messages, come out as the Assistant's reply. Everything
 * else about the conversation (order, steering, history, resume) is Chat's, as for any Run.
 */
export class InterviewRelay implements AgentRuntime {
  constructor(private readonly deps: { accountId: string; state: AssistantStateRepository; desk: InterviewDesk }) {}

  async *run(input: RunStart, ctx: RunContext): AsyncIterable<OutboundMessage> {
    const said: string[] = [];
    let pending = [input.message.content];
    while (pending.length) {
      for (const text of pending) {
        if (text.startsWith(RELAY_MARK)) { said.push(text.slice(RELAY_MARK.length)); continue; }
        if (!text.trim()) continue;
        const interview = await this.deps.state.interview(this.deps.accountId);
        if (!interview) throw new Error("The interview ended before this message reached it.");
        await this.deps.desk.tell(this.deps.accountId, interview, text);
      }
      // Messages that joined this Run go the same way before it ends.
      pending = ((await ctx.claimSteered?.()) ?? []).map(message => message.content ?? "");
    }
    if (said.length) yield { type: "assistant.delta", run_id: input.run_id, delta: { kind: "text", content: said.join("\n\n") } };
    yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
  }
}

/** Whether the next message of a conversation belongs to the interview rather than to the model. */
export const isRelayed = (text: string, interviewing: boolean): boolean => interviewing || text.startsWith(RELAY_MARK);
