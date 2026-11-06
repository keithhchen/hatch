import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MessageOrigin } from "./store.js";

const REF = "hatch-file:";
const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
/** Images resent to the model each turn cost tokens: only the latest few go as pixels. */
const MAX_LIVE_IMAGES = 4;

export function imageMime(name: string): string | undefined { return MIME[path.extname(name).toLowerCase()]; }

/** A user message whose images are workspace references. History stores the reference, never the bytes. */
export function userMessage(text: string, images: string[] = [], origin?: MessageOrigin): AgentMessage {
  return { role: "user", timestamp: Date.now(), ...(origin ? { origin } : {}), content: [{ type: "text", text }, ...images.map(file => ({ type: "image" as const, mimeType: imageMime(file) ?? "image/jpeg", data: `${REF}${file}` }))] };
}

type Block = { type: string; data?: string; text?: string };
export function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? (content as Block[]).map(block => block.type === "text" ? block.text ?? "" : "").join("") : "";
}
const isRef = (block: Block) => block.type === "image" && Boolean(block.data?.startsWith(REF));
const blocks = (message: AgentMessage): Block[] | undefined => message.role === "user" && Array.isArray(message.content) ? message.content as Block[] : undefined;
const asText = (block: Block): Block => ({ type: "text", text: `（之前的图片：${block.data!.slice(REF.length)}）` });

/** For calls that don't need the pixels, such as compaction summaries. */
export function imagesAsText(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(message => blocks(message)?.some(isRef) ? { ...message, content: blocks(message)!.map(block => isRef(block) ? asText(block) : block) } as AgentMessage : message);
}

/** What the model receives: the latest images as bytes, older ones as text. The stored messages are untouched. */
export async function hydrateImages(messages: AgentMessage[], read: (file: string) => Promise<Buffer>): Promise<AgentMessage[]> {
  let budget = MAX_LIVE_IMAGES;
  const result = [...messages];
  for (let index = messages.length - 1; index >= 0; index--) {
    const content = blocks(messages[index]!);
    if (!content?.some(isRef)) continue;
    const next: Block[] = [];
    for (const block of [...content].reverse()) {
      if (!isRef(block)) { next.unshift(block); continue; }
      if (budget <= 0) { next.unshift(asText(block)); continue; }
      budget--;
      next.unshift({ ...block, data: (await read(block.data!.slice(REF.length))).toString("base64") });
    }
    result[index] = { ...messages[index]!, content: next } as AgentMessage;
  }
  return result;
}
