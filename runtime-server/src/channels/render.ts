import type { ChannelCapabilities } from "../surfaces/contract.js";
import type { OutboundMessage } from "./types.js";

/** The longest prefix, in UTF-16 units, within both limits and never through a surrogate pair. */
function fit(text: string, maxLength: number, maxBytes: number): number {
  let units = 0; let bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (units + char.length > maxLength || bytes > maxBytes) break;
    units += char.length;
  }
  return units;
}

/** Split where a reader would: a paragraph, a line, a space, and only then through a word. Nothing is dropped. */
function segments(text: string, maxLength: number, maxBytes: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxLength || Buffer.byteLength(rest) > maxBytes) {
    const size = fit(rest, maxLength, maxBytes);
    const window = rest.slice(0, size);
    const at = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")].find(index => index > size / 2);
    const end = at ?? size;
    parts.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  return [...parts, rest];
}

/**
 * Degrades a reply to what the platform can show: buttons become a typed instruction, long text becomes
 * several messages in order. Buttons go on the last message and the quote on the first.
 */
export function render(message: OutboundMessage, capabilities: Pick<ChannelCapabilities, "buttons" | "maxLength" | "maxBytes">): OutboundMessage[] {
  const labels = [...new Set(message.buttons?.map(button => `「${button.label}」`))];
  const typed = Boolean(message.buttons?.length) && !capabilities.buttons;
  const linked = message.link && !capabilities.buttons ? `${message.text}\n\n${message.link.url}` : message.text;
  const text = typed ? `${linked}\n\n回复${labels.join("或")}` : linked;
  const parts = segments(text, capabilities.maxLength, capabilities.maxBytes ?? Infinity);
  return parts.map((part, index) => ({
    text: part,
    ...(index === 0 && message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(index === parts.length - 1 && !typed && message.buttons?.length ? { buttons: message.buttons } : {}),
    ...(index === parts.length - 1 && message.link && capabilities.buttons ? { link: message.link } : {}),
  }));
}
