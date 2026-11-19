import type { BriefSnapshot } from "../brief.js";
import type { ConversationRecord, ConversationRepository, EndedRun, RunEnding } from "../conversationRepository.js";
import { log } from "../observability/log.js";
import type { Prompts } from "../prompts.js";
import type { RuntimeStore } from "../store.js";

/** A title is at most this long: in characters for Chinese and Japanese, which carry more per character, and for the rest. */
export const TITLE_MAX_CJK = 24;
export const TITLE_MAX_LATIN = 50;
/** What of the user's words and of the reply goes to the model. */
const INTENT_CHARS = 1_000;
const REPLY_CHARS = 1_000;
const BRIEF_VALUE_CHARS = 300;
/** A title is a background call: it waits this long, then the next completed Run tries again. */
export const TITLE_TIMEOUT_MS = 20_000;
/** The history is read back this many pages (200 messages each) to find the first message of a long conversation. */
const MAX_HISTORY_PAGES = 10;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const TRAILING = /[\s。.!！?？,，、;；:：…·~\-–—]+$/u;
const WRAPS = [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"], ["《", "》"], ["【", "】"], ["(", ")"], ["（", "）"], ["[", "]"]] as const;
const wrapped = (text: string) => text.length > 1 && WRAPS.some(([open, close]) => text.startsWith(open) && text.endsWith(close));
const GENERIC = new Set(["chat", "conversation", "new chat", "new conversation", "untitled", "help", "title", "对话", "聊天", "新对话", "新聊天", "无标题", "会話", "新しい会話", "チャット", "無題"]);

/**
 * What the model wrote, made a title: its first line, with the wrapping the model likes (quotes, brackets, markdown, a "Title:"
 * label) and any trailing punctuation removed, cut to length. `undefined` when nothing usable is left or it is generic.
 */
export function cleanTitle(raw: string): string | undefined {
  let text = raw.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
  text = text.replace(/^#+\s*/u, "").replace(/^[*_`]+|[*_`]+$/gu, "").replace(/^(?:title|标题|題名|タイトル)\s*[:：]\s*/iu, "").trim();
  // Quotes and brackets are removed only as a pair around the whole title: "Plan (v2)" keeps its bracket.
  text = text.replace(/\s+/gu, " ");
  for (let before = ""; before !== text;) {
    before = text;
    text = text.replace(TRAILING, "");
    if (wrapped(text)) text = text.slice(1, -1).trim();
  }
  const chars = [...text];
  const max = CJK.test(text) ? TITLE_MAX_CJK : TITLE_MAX_LATIN;
  if (chars.length > max) {
    text = chars.slice(0, max).join("");
    // A Latin title is cut at a word, not in the middle of one.
    if (!CJK.test(text)) { const space = text.lastIndexOf(" "); if (space > max / 2) text = text.slice(0, space); }
    text = text.replace(TRAILING, "");
  }
  return !text || GENERIC.has(text.toLowerCase()) ? undefined : text;
}

const clip = (text: string, chars: number) => { const all = [...text.trim()]; return all.length > chars ? `${all.slice(0, chars).join("")}…` : all.join(""); };

/** The answers of a conversation started from a Brief, as the subject the user came with. */
function briefText(brief: BriefSnapshot): string {
  return brief.fields.filter(field => field.value?.trim()).map(field => `- ${clip(field.label, 120)}: ${clip(field.value!, BRIEF_VALUE_CHARS)}`).join("\n");
}

export type TitleMessage = { role: "user" | "assistant"; content: string };

/**
 * What the model is shown. A conversation started from a Brief is about the Brief's answers (its first user message is a system
 * reminder, not words the user wrote); any other is about the first thing the user wrote. The first reply follows when there is one.
 * `undefined` when there is nothing yet to name.
 */
export function titleInput(conversation: Pick<ConversationRecord, "briefSnapshot">, messages: readonly TitleMessage[]): string | undefined {
  const brief = conversation.briefSnapshot ? briefText(conversation.briefSnapshot) : "";
  const asked = brief ? `The user filled in a form:\n${brief}` : (() => {
    const first = messages.find(message => message.role === "user" && message.content.trim());
    return first ? `The user wrote:\n${clip(first.content, INTENT_CHARS)}` : "";
  })();
  if (!asked) return undefined;
  const reply = messages.find(message => message.role === "assistant" && message.content.trim());
  return reply ? `${asked}\n\nThe first reply began:\n${clip(reply.content, REPLY_CHARS)}` : asked;
}

/** Where a title comes from: one short completion on the model of the `title` role. */
export type TitleModel = (request: { system: string; user: string; signal: AbortSignal }) => Promise<string>;

type History = Pick<RuntimeStore, "readVisibleConversationPage">;
type Repository = Pick<ConversationRepository, "getConversation" | "setTitleIfUnset">;

/**
 * Names a conversation after its first completed Run. The title is written once, by a conditional update, so concurrent
 * instances and retries write at most once and a title a user set is never replaced. It never delays or changes a Run: it
 * runs after the Run ended, bounded by a timeout, and a failure only leaves the title empty for the next completed Run to try.
 */
export class ConversationTitles {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: { repository: Repository; history: History; prompts: Prompts; model: TitleModel; timeoutMs?: number;
    /** Conversations that are not chats (a report) are never titled. */
    skip?: (conversationId: string) => Promise<boolean> }) {}

  /**
   * To be told of every Run that ended. Resolves to the conversation when this call gave it its title, `undefined` otherwise.
   * It does not reject.
   */
  async runEnded(ended: EndedRun, ending: RunEnding): Promise<ConversationRecord | undefined> {
    if (!ended.ended || ending.status !== "completed") return undefined;
    const id = ended.run.conversationId;
    // One attempt per conversation at a time in this process; across processes the conditional update decides.
    if (this.inFlight.has(id)) return undefined;
    this.inFlight.add(id);
    try {
      return await this.title(id);
    } catch (error) {
      log.warn("conversation_title_failed", { conversationId: id, error });
      return undefined;
    } finally { this.inFlight.delete(id); }
  }

  private async title(id: string): Promise<ConversationRecord | undefined> {
    const conversation = await this.deps.repository.getConversation(id);
    if (!conversation || conversation.title || await this.deps.skip?.(id)) return undefined;
    const input = titleInput(conversation, await this.firstMessages(id));
    if (!input) return undefined;
    const system = await this.deps.prompts.get("title");
    const title = cleanTitle(await this.bounded(signal => this.deps.model({ system, user: input, signal })));
    if (!title) return undefined;
    return this.deps.repository.setTitleIfUnset(id, title);
  }

  /** The model's answer within the time allowed: it is asked to stop at the deadline, and not waited for past it even if it does not. */
  private async bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("The title model did not answer in time")), this.deps.timeoutMs ?? TITLE_TIMEOUT_MS);
    try {
      return await Promise.race([work(controller.signal), new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason)))]);
    } finally { clearTimeout(timer); }
  }

  /** The start of the conversation: the oldest page of its visible history. */
  private async firstMessages(id: string): Promise<TitleMessage[]> {
    let page = await this.deps.history.readVisibleConversationPage(id, { limit: 200 });
    for (let pages = 1; page.has_more && page.before_cursor && pages < MAX_HISTORY_PAGES; pages++) {
      page = await this.deps.history.readVisibleConversationPage(id, { limit: 200, beforeCursor: page.before_cursor });
    }
    return page.messages;
  }
}
