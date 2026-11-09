import type { GraphError } from "./metaChannel.js";
import { MetaMessagingChannel } from "./metaMessaging.js";

const API = "https://graph.instagram.com/v27.0";
const MAX_BYTES = 1000;
/** Error 100 with this subcode: Meta Business AI owns the conversation and the app was not handed it. */
const BUSINESS_AI_OWNS_THREAD = 2534037;

/** Cut text into pieces of at most `max` UTF-8 bytes, never inside a character. */
export function splitBytes(text: string, max: number): string[] {
  const pieces: string[] = [];
  let piece = ""; let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > max) { pieces.push(piece); piece = ""; bytes = 0; }
    piece += char; bytes += size;
  }
  return [...pieces, piece];
}

/** Instagram Messaging (Instagram login). The tenant is the professional account, the contact the IGSID. */
export class InstagramChannel extends MetaMessagingChannel {
  readonly kind = "instagram" as const;
  protected readonly object = "instagram";
  /** The documented limit is 1000 bytes, which no character count can promise: `chunks` keeps each message inside it. */
  protected readonly textLimit = MAX_BYTES;
  protected endpoint(account: string): string { return `${API}/${account}/messages`; }
  protected chunks(text: string): string[] { return splitBytes(text, MAX_BYTES); }
  /** Not a delivery problem to retry: say who holds the conversation. */
  protected explain(error: GraphError = {}): string {
    return error.error_subcode === BUSINESS_AI_OWNS_THREAD ? `Instagram Business AI owns this conversation; reply only after it passes control (${error.code}/${error.error_subcode})` : super.explain(error);
  }
}
