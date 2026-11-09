import type { ChannelCapabilities } from "../surfaces/contract.js";
import type { OutboundMessage } from "./types.js";

/** Cut at UTF-16 unit `at`, or one earlier rather than through a surrogate pair. */
function cut(text: string, at: number): number {
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

/** Split where a reader would: a paragraph, a line, a space, and only then through a word. Nothing is dropped. */
function segments(text: string, maxLength: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength);
    const at = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")].find(index => index > maxLength / 2);
    const end = at === undefined ? cut(rest, maxLength) : at;
    parts.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  return [...parts, rest];
}

/**
 * Degrades a reply to what the platform can show: buttons become a typed instruction, long text becomes
 * several messages in order. Buttons go on the last message and the quote on the first.
 */
export function render(message: OutboundMessage, capabilities: Pick<ChannelCapabilities, "buttons" | "maxLength">): OutboundMessage[] {
  const labels = [...new Set(message.buttons?.map(button => `「${button.label}」`))];
  const typed = Boolean(message.buttons?.length) && !capabilities.buttons;
  const text = typed ? `${message.text}\n\n回复${labels.join("或")}` : message.text;
  const parts = segments(text, capabilities.maxLength);
  return parts.map((part, index) => ({
    text: part,
    ...(index === 0 && message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(index === parts.length - 1 && !typed && message.buttons?.length ? { buttons: message.buttons } : {}),
  }));
}
