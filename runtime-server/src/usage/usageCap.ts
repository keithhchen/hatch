import { ChatError } from "../chat/principal.js";
import { billableTokens, monthlyTokenCap, USAGE_SURFACES, type UsageReader } from "./usage.js";

export const USAGE_CAP_EXCEEDED = "usage_cap_exceeded";

export const resetDay = (resetsAt: Date): string => resetsAt.toISOString().slice(0, 10);
const nextMonth = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/** The account has spent its month. Carries the numbers; the wire message names none, an adapter that may show them does. */
export class UsageCapExceeded extends ChatError {
  constructor(readonly accountId: string, readonly used: number, readonly cap: number, readonly resetsAt: Date) {
    super(USAGE_CAP_EXCEEDED, `Monthly token limit reached. It resets on ${resetDay(resetsAt)}.`, 429);
    this.name = "UsageCapExceeded";
  }
}

/** Asked before a new Run starts. A Run already in flight is never asked again. */
export type RunCap<Scope> = (scope: Scope) => Promise<void>;

/**
 * The monthly token cap: what an account has spent this calendar month (UTC), across every surface, against one limit.
 * A below-cap reading is remembered briefly so a busy account is not a database read per message; an over-cap reading never is.
 */
export class UsageCap {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly reader: Pick<UsageReader, "monthToDate">,
    readonly cap: number | null,
    private readonly options: { ttlMs?: number; now?: () => Date } = {}
  ) {}

  static fromEnvironment(reader: Pick<UsageReader, "monthToDate">, env: NodeJS.ProcessEnv): UsageCap {
    return new UsageCap(reader, monthlyTokenCap(env));
  }

  /** Throws UsageCapExceeded when the account has reached the cap. No cap, no read. */
  async assertWithinCap(accountId: string): Promise<void> {
    const { cap } = this;
    if (cap === null) return;
    const now = (this.options.now ?? (() => new Date()))();
    const checkedAt = this.seen.get(accountId);
    if (checkedAt !== undefined && now.getTime() - checkedAt <= (this.options.ttlMs ?? 10_000)) return;
    const month = await this.reader.monthToDate(accountId, now);
    const used = USAGE_SURFACES.reduce((sum, surface) => sum + billableTokens(month[surface]), 0);
    if (used >= cap) { this.seen.delete(accountId); throw new UsageCapExceeded(accountId, used, cap, nextMonth(now)); }
    this.seen.set(accountId, now.getTime());
  }

  /** A guard for a host whose Runs are paid by `payer(scope)`. */
  guard<Scope>(payer: (scope: Scope) => string): RunCap<Scope> {
    return scope => this.assertWithinCap(payer(scope));
  }
}
