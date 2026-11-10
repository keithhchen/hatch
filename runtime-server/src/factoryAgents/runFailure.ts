import { classifyFactoryProviderFailure } from "../creatorLearning/factoryLlm.js";

/** Why a Run ended in failure, as every surface shows it: the shape of Chat's `turn.failed` error. */
export type RunFailure = { code: "provider_quota" | "provider_rate_limited" | "provider_error" | "run_failed"; message: string };

const MESSAGES: Record<Exclude<RunFailure["code"], "run_failed">, string> = {
  provider_quota: "The model provider has no quota or balance left. Recharge the provider account, then send the message again.",
  provider_rate_limited: "The model provider is rate limiting requests. Wait a moment, then send the message again.",
  provider_error: "The model provider could not answer. Send the message again; if it keeps failing, check the provider configuration."
};

/** A failed session always says why: sessions that failed before codes existed read as a plain failed Run. */
export const failureOf = (session: { error?: string; errorCode?: string }): RunFailure =>
  ({ code: (session.errorCode ?? "run_failed") as RunFailure["code"], message: session.error ?? "The Run failed. Send the message again." });

const SUSPENDED = /account.{0,60}suspended|suspended.{0,40}(?:balance|billing|payment)|billing/i;
const RATE_LIMITED = /\b429\b|rate[\s_-]*limit|too many requests/i;

/**
 * Names a failed Run for people and for clients. A provider failure leaves as its code and a fixed message:
 * a provider's own body can carry organization and key identifiers, so it is never copied.
 * Any other failure keeps `describe(error)`, the caller's redacted text.
 */
export function classifyRunFailure(error: unknown, describe: (error: unknown) => string): RunFailure {
  const text = error instanceof Error ? error.message : String(error);
  const provider = classifyFactoryProviderFailure(error);
  if (provider?.code === "provider_quota" || SUSPENDED.test(text)) return { code: "provider_quota", message: MESSAGES.provider_quota };
  if (RATE_LIMITED.test(text)) return { code: "provider_rate_limited", message: MESSAGES.provider_rate_limited };
  if (provider) return { code: "provider_error", message: MESSAGES.provider_error };
  return { code: "run_failed", message: describe(error) };
}
