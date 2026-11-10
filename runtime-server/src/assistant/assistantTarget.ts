import { safeError } from "../factoryAgents/runtime.js";
import type { ChannelConnection } from "../channels/connections.js";
import type { ChatTarget } from "../channels/chatTarget.js";
import type { Handled, Inbound, ReplyPolicy } from "../channels/ports.js";
import { CHANNEL_LABELS, type ChannelKind } from "../channels/types.js";
import type { ContentPart } from "../surfaces/contract.js";
import type { AssistantService } from "./assistant.js";

const DONE: Handled = { replied: true };

/** What the Assistant is told a guest's message is: said by someone the Expert authorized, never by the Expert. */
const asGuest = (label: string | undefined, text: string): string => `[${(label ?? "").replace(/[\[\]\r\n]/g, " ").trim().slice(0, 40) || "被授权的人"}，专家授权的人，不是专家本人] ${text}`;

/** The Assistant behind a self Connection: the Expert, in a linked chat, talking to their own Assistant; and the people they invited. */
export class AssistantTarget implements ChatTarget {
  constructor(private assistant: Pick<AssistantService, "hear" | "upload" | "approve" | "decline" | "linked" | "reviewButtons">) {}

  async linked(connection: { ownerAccountId: string }, role: "owner" | "guest"): Promise<string> {
    return role === "guest" ? "连上了。专家授权你和助理说话，直接说就行。" : this.assistant.linked(connection.ownerAccountId);
  }

  /** A Run that said nothing sends nothing, and a reply that leaves a task waiting for the Expert's decision carries its buttons. */
  replyPolicy = async (_connection: ChannelConnection, runId: string): Promise<ReplyPolicy> => {
    const buttons = await this.assistant.reviewButtons(runId);
    return { quietWhenEmpty: true, ...(buttons.length ? { buttons } : {}) };
  };

  wording = { tooLarge: ({ connection }: Inbound) => `这个文件太大，${CHANNEL_LABELS[connection.channel as ChannelKind]} 传不过来。可以放到 Studio 里传。`, unreadable: "这种消息我还读不了，可以发文字、图片或文档。" };

  /** The router admits the owner, and guests the owner invited. Studio actions never depend on that alone. */
  async admit({ connection, principal, speaker }: Inbound): Promise<undefined> {
    const guest = speaker.role === "guest";
    if (guest ? principal.kind !== "contact" || principal.connectionId !== connection.id : principal.kind !== "account" || principal.accountId !== connection.ownerAccountId) throw new Error("Only the owner and their guests reach the Assistant");
    return undefined;
  }

  said({ speaker }: Inbound, text: string | undefined, attached: boolean): string | undefined {
    if (speaker.role !== "guest") return text;
    return text ? asGuest(speaker.label, text) : attached ? asGuest(speaker.label, "（发来一个文件）") : undefined;
  }

  upload({ connection }: Inbound, file: { name: string; bytes: Buffer }) { return this.assistant.upload(connection.ownerAccountId, file.name, file.bytes); }

  send(inbound: Inbound, { key, parts }: { key: string; parts: ContentPart[] }) { return this.assistant.hear(inbound.connection.ownerAccountId, { ...origin(inbound, key), parts }); }

  /** The press is told to the Assistant first, as a message of its own; only then is the task decided. A failure before it is retried, and a retry is the same message. */
  async press(inbound: Inbound, key: string): Promise<Handled> {
    const { connection, event, adapter, speaker } = inbound;
    const accountId = connection.ownerAccountId;
    await this.admit(inbound);
    if (speaker.role === "guest") { await adapter.acknowledge?.(event, "只有专家本人可以确认"); return DONE; }
    const { taskId, action } = event.button!;
    if (!taskId) { await adapter.acknowledge?.(event); return DONE; }
    const { runId } = await this.assistant.hear(accountId, { ...origin(inbound, key), system: true, parts: [{ type: "text", text: `[任务 ${taskId}] 专家在 ${CHANNEL_LABELS[connection.channel as ChannelKind]} 点了「${action === "approve" ? "确认" : "取消"}」。` }] });
    try {
      await (action === "approve" ? this.assistant.approve(accountId, taskId) : this.assistant.decline(accountId, taskId));
      await adapter.acknowledge?.(event, "好");
    } catch (error) { await (adapter.acknowledge ? adapter.acknowledge(event, safeError(error)) : inbound.notify(safeError(error))); }
    return { replied: false, runId };
  }
}

/** A guest is not the Expert: their words are marked, and they never move where the Assistant looks for the Expert. */
const origin = ({ connection, event, speaker }: Inbound, id: string) => ({ id, source: connection.channel as ChannelKind, ...(event.messageRef ? { messageRef: event.messageRef } : {}), ...(speaker.role === "guest" ? { guest: true as const } : {}) });
