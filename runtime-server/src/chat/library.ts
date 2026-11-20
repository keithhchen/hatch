import type { ConversationRepository } from "../conversationRepository.js";
import { log } from "../observability/log.js";

/** Port: an account's library, the Agents it keeps to come back to. Saving one already there changes nothing. */
export interface Library {
  /** False when the Agent cannot be saved: the account's own, or one no longer live. */
  save(accountId: string, productId: string): Promise<boolean>;
}

/** The library as the Dashboard keeps it, reached with the Commerce service token. */
export class HttpLibrary implements Library {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!baseUrl.trim() || !serviceToken.trim()) throw new Error("Library URL and service token are required");
  }

  async save(accountId: string, productId: string): Promise<boolean> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/v1/internal/library/save`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.serviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ account_id: accountId, product_id: productId }),
      signal: AbortSignal.timeout(5_000)
    });
    // An Agent that is gone or withdrawn is not saved, and there is nothing to retry.
    if (response.status === 404 || response.status === 409) return false;
    if (!response.ok) throw new Error(`The library refused to save an Agent (${response.status})`);
    return ((await response.json()) as { saved?: boolean }).saved === true;
  }
}

/**
 * Saving is idempotent, so a failure is simply tried again after a short pause. It throws only when every attempt failed;
 * nothing is remembered as saved, so the next Run that starts for the account asks again.
 */
export class RetryingLibrary implements Library {
  constructor(
    private readonly library: Library,
    private readonly delaysMs: readonly number[] = [200, 1_000, 3_000],
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async save(accountId: string, productId: string): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.library.save(accountId, productId); }
      catch (error) {
        if (attempt >= this.delaysMs.length) throw error;
        await this.sleep(this.delaysMs[attempt]!);
      }
    }
  }
}

/**
 * A Product whose buyers come in by an access code has no library for them: they find their report through the code, so
 * nothing is saved for its conversations. Every other Product is saved as ever.
 */
export class CodeGatedLibrary implements Library {
  constructor(private readonly library: Library, private readonly gate: { required(productId: string): Promise<boolean> }) {}

  async save(accountId: string, productId: string): Promise<boolean> {
    if (await this.gate.required(productId)) {
      log.debug("library_save_skipped", { product_id: productId, reason: "access_code" });
      return false;
    }
    return this.library.save(accountId, productId);
  }
}

/**
 * A visitor who signs in brings their conversations along: first their Agents are saved to the account's library, then the
 * conversations become the account's. Each step can be repeated, and nothing moves until every Agent is saved, so a failure at any
 * point leaves the visitor as they were and doing it again finishes the job.
 */
export class GuestCarryOver {
  constructor(private readonly deps: { repository: Pick<ConversationRepository, "ownedProductIds" | "reown">; library: Library }) {}

  async carry(guestOwner: string, accountId: string): Promise<{ moved: number }> {
    for (const productId of await this.deps.repository.ownedProductIds(guestOwner)) await this.deps.library.save(accountId, productId);
    return { moved: await this.deps.repository.reown(guestOwner, accountId) };
  }
}
