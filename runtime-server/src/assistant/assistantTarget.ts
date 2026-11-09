import { ACCEPTED_UPLOAD_EXTENSIONS } from "../factoryAgents/markdownConverter.js";
import { imageMime } from "../factoryAgents/imageRefs.js";
import { safeError } from "../factoryAgents/runtime.js";
import type { Handled, Inbound, TargetHandler } from "../channels/ports.js";
import { CHANNEL_LABELS, type ChannelKind } from "../channels/types.js";
import type { AssistantService } from "./assistant.js";

const DONE: Handled = { replied: true };

/** The Assistant behind a self Connection: the Expert, in a linked chat, talking to their own Assistant. */
export class AssistantTarget implements TargetHandler {
  constructor(private assistant: Pick<AssistantService, "ingest" | "receiveFile" | "approve" | "decline" | "linked">) {}

  linked(connection: { ownerAccountId: string }): Promise<string> { return this.assistant.linked(connection.ownerAccountId); }

  async handle(inbound: Inbound): Promise<Handled> {
    const { connection, principal, event, adapter, id } = inbound;
    const accountId = connection.ownerAccountId;
    // The router only admits the owner here. Studio actions never depend on that alone.
    if (principal.kind !== "account" || principal.accountId !== accountId) throw new Error("Only the owner reaches the Assistant");
    const kind = connection.channel as ChannelKind;
    const origin = { id, eventId: id, ...(event.messageRef ? { messageRef: event.messageRef } : {}) };

    if (event.button) {
      const { taskId, action } = event.button;
      try {
        if (!taskId) { await adapter.acknowledge?.(event); return DONE; }
        const task = action === "approve" ? await this.assistant.approve(accountId, taskId) : await this.assistant.decline(accountId, taskId);
        await adapter.acknowledge?.(event, "好");
        await this.assistant.ingest(accountId, { source: "task", taskId: task.id, text: `专家在 ${CHANNEL_LABELS[kind]} 点了「${action === "approve" ? "确认" : "取消"}」。`, ...origin });
      } catch (error) { await (adapter.acknowledge ? adapter.acknowledge(event, safeError(error)) : inbound.notify(safeError(error))); }
      return DONE;
    }

    if (event.file) {
      const { name, size } = event.file;
      if (!imageMime(name) && !ACCEPTED_UPLOAD_EXTENSIONS.some(extension => name.toLowerCase().endsWith(extension))) { await inbound.notify(`这种文件我还读不了。可以发图片，或 ${ACCEPTED_UPLOAD_EXTENSIONS.join("、")}。`); return DONE; }
      if ((size ?? 0) > adapter.maxFileBytes) { await inbound.notify(`这个文件太大，${CHANNEL_LABELS[kind]} 传不过来。可以放到 Studio 里传。`); return DONE; }
      // A failed download throws: the event stays in the inbox and is tried again, also after a restart.
      const bytes = await adapter.download(event.file);
      try { await this.assistant.receiveFile(accountId, name, bytes, kind, { ...origin, ...(event.text ? { caption: event.text } : {}) }); }
      catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "image_too_large" && code !== "file_unreadable") throw error;
        await inbound.notify((error as Error).message);
        return DONE;
      }
      return { replied: false };
    }

    if (!event.text?.trim()) { await inbound.notify("这种消息我还读不了，可以发文字、图片或文档。"); return DONE; }
    await this.assistant.ingest(accountId, { source: kind, text: event.text.trim(), ...origin });
    return { replied: false };
  }
}
