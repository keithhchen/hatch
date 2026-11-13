/** Why an upstream call failed. Internal: it never leaves the server. */
export type UpstreamCause = "quota" | "rate_limited" | "configuration" | "transient" | "unknown";

const QUOTA = /(?:exceeded[\s_-]*(?:current[\s_-]*)?quota|insufficient[\s_-]*(?:balance|quota|credits?)|(?:balance|credits?|quota).{0,64}(?:exhausted|depleted|insufficient)|(?:exhausted|depleted).{0,32}(?:balance|credits?|quota)|account.{0,60}suspended|suspended.{0,40}(?:balance|billing|payment)|billing)/i;
const RATE_LIMITED = /\b429\b|rate[\s_-]*limit|too many requests/i;
const IDENTIFIER = /(?:\borg-[a-z0-9][a-z0-9_-]*\b|<?\bak-[a-z0-9][a-z0-9_-]*\b>?|\bsk-[a-z0-9][a-z0-9_-]*\b)/i;
// Keep this allow-list narrow: "request" and "response" also occur in Hatch's own harness boundary.
const SHAPED = /(?:provider|moonshot|openai|api[\s_-]*key|network|fetch|rate[\s_-]*limit|too many requests|timeout|timed out|socket|connection|econn[a-z]*|eai_again)/i;
const TRANSIENT = /(?:rate[\s_-]*limit|too many requests|temporar|timeout|timed out|network|fetch|socket|connection|econn[a-z]*|eai_again|overloaded|\bunavailable\b|internal[\s_-]*error)/i;
// A provider that has no capacity right now (Moonshot sends it as a 429): asking again after a backoff works, unlike a rate limit.
const OVERLOADED = /overloaded/i;
const PROVIDERS: Array<[RegExp, string]> = [[/moonshot|kimi/i, "moonshot"], [/openai/i, "openai"], [/anthropic|claude/i, "anthropic"], [/gemini|google/i, "google"], [/bailian|dashscope|qwen/i, "bailian"]];

const httpStatus = (text: string): number | undefined => {
  // Google sends no status prefix: its JSON body carries it as `"code":503`.
  const match = /^\s*([45]\d\d)\b/.exec(text) ?? /\b(?:http(?:\s+error)?|status(?:\s+code)?)\s*[:=]?\s*([45]\d\d)\b/i.exec(text) ?? /"code"\s*:\s*([45]\d\d)\b/.exec(text);
  return match ? Number(match[1]) : undefined;
};

/** A provider-authored body can carry organization and key identifiers: only this redacted form is ever stored, and only server-side. */
const redact = (text: string): string => text.replace(/\b(?:org-|ak-|sk-|tvly-|fc-)[A-Za-z0-9_-]+/gi, "[redacted]").slice(0, 1000);

/**
 * A failure of something Hatch pays for or calls: the model provider or a third-party platform.
 * It is thrown where the call fails, and only the failure boundary decides what a client sees: its `message` is the
 * provider's text with identifiers redacted (the Runtime reads it to spot an oversized request), for the server only.
 */
export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamCause,
    readonly provider: string,
    readonly status: number | undefined,
    readonly detail: string
  ) {
    super(detail);
    this.name = "UpstreamError";
  }

  /** An error from an upstream call, named: an unrecognized one is `unknown`, still upstream. `source` is the provider and model that were called, when the caller knows them. */
  static of(error: unknown, source = ""): UpstreamError {
    if (error instanceof UpstreamError) return error;
    const text = error instanceof Error ? error.message : String(error);
    const status = httpStatus(text);
    const quota = QUOTA.test(text);
    const shaped = quota || status !== undefined || IDENTIFIER.test(text) || SHAPED.test(text);
    const kind: UpstreamCause = quota ? "quota"
      : OVERLOADED.test(text) ? "transient"
      : RATE_LIMITED.test(text) ? "rate_limited"
      : status === 408 || status === 409 || status === 425 || (status !== undefined && status >= 500) || TRANSIENT.test(text) ? "transient"
      : shaped ? "configuration"
      : "unknown";
    const provider = PROVIDERS.find(([pattern]) => pattern.test(text) || pattern.test(source))?.[1] ?? "unknown";
    return new UpstreamError(kind, provider, status, redact(text));
  }
}
