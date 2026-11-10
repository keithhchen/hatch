import { ChatError } from "../chat/principal.js";
import { safeError } from "../factoryAgents/runtime.js";
import type { ChannelConnection } from "../channels/connections.js";
import type { Handled, Inbound, ReplyPolicy, TargetHandler } from "../channels/ports.js";
import { CHANNEL_LABELS, type ChannelKind } from "../channels/types.js";
import { imageMime } from "../factoryAgents/imageRefs.js";
import type { ContentPart } from "../surfaces/contract.js";
import type { AssistantService } from "./assistant.js";

const DONE: Handled = { replied: true };

/** The Assistant behind a self Connection: the Expert, in a linked chat, talking to their own Assistant. */
export class AssistantTarget implements TargetHandler {
  constructor(private assistant: Pick<AssistantService, "hear" | "upload" | "approve" | "decline" | "linked" | "reviewButtons">) {}

  linked(connection: { ownerAccountId: string }): Promise<string> { return this.assistant.linked(connection.ownerAccountId); }

  /** A Run that said nothing sends nothing, and a reply that leaves a task waiting for the Expert's decision carries its buttons. */
  replyPolicy = async (_connection: ChannelConnection, runId: string): Promise<ReplyPolicy> => {
    const buttons = await this.assistant.reviewButtons(runId);
    return { quietWhenEmpty: true, ...(buttons.length ? { buttons } : {}) };
  };

  async handle(inbound: Inbound): Promise<Handled> {
    const { connection, principal, event, adapter, id } = inbound;
    const accountId = connection.ownerAccountId;
    // The router only admits the owner here. Studio actions never depend on that alone.
    if (principal.kind !== "account" || principal.accountId !== accountId) throw new Error("Only the owner reaches the Assistant");
    const kind = connection.channel as ChannelKind;
    const origin = { id, source: kind, ...(event.messageRef ? { messageRef: event.messageRef } : {}) };

    if (event.button) {
      const { taskId, action } = event.button;
      try {
        if (!taskId) { await adapter.acknowledge?.(event); return DONE; }
        const task = action === "approve" ? await this.assistant.approve(accountId, taskId) : await this.assistant.decline(accountId, taskId);
        await adapter.acknowledge?.(event, "好");
        const { runId } = await this.assistant.hear(accountId, { ...origin, system: true, parts: [{ type: "text", text: `[任务 ${task.id}] 专家在 ${CHANNEL_LABELS[kind]} 点了「${action === "approve" ? "确认" : "取消"}」。` }] });
        return { replied: false, runId };
      } catch (error) { await (adapter.acknowledge ? adapter.acknowledge(event, safeError(error)) : inbound.notify(safeError(error))); }
      return DONE;
    }

    const parts: ContentPart[] = [];
    if (event.text?.trim()) parts.push({ type: "text", text: event.text.trim() });
    try {
      if (event.file) {
        const { name, size } = event.file;
        if ((size ?? 0) > adapter.maxFileBytes) { await inbound.notify(`这个文件太大，${CHANNEL_LABELS[kind]} 传不过来。可以放到 Studio 里传。`); return DONE; }
        // A failed download throws: the event stays in the inbox and is tried again, also after a restart.
        const bytes = await adapter.download(event.file);
        const { assetId } = await this.assistant.upload(accountId, name, bytes);
        parts.push({ type: imageMime(name) ? "image" : "file", assetId });
      }
      if (!parts.length) { await inbound.notify("这种消息我还读不了，可以发文字、图片或文档。"); return DONE; }
      const { runId } = await this.assistant.hear(accountId, { ...origin, parts });
      return { replied: false, runId };
    } catch (error) {
      // A refusal that no retry changes goes back to the sender; anything else returns the event to the queue.
      if (!(error instanceof ChatError && (error.status < 500 || error.status === 501))) throw error;
      await inbound.notify(error.message);
      return DONE;
    }
  }
}
