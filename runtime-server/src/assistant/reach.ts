import type { Pool } from "pg";

/** Account-level facts the Assistant's schedule needs. Stored on accounts. */
export class AccountReach {
  constructor(private pool: Pool) {}
  async ensureSchema(): Promise<void> { await this.pool.query("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS timezone TEXT"); }
  async timezone(accountId: string): Promise<string> {
    return (await this.pool.query("SELECT timezone FROM accounts WHERE id = $1", [accountId])).rows[0]?.timezone || "UTC";
  }
  async setTimezone(accountId: string, timezone: string): Promise<void> {
    if (!validTimezone(timezone)) return;
    await this.pool.query("UPDATE accounts SET timezone = $2 WHERE id = $1 AND timezone IS DISTINCT FROM $2", [accountId, timezone]);
  }
  /** Accounts that own at least one active Product: the ones whose Assistant runs the daily check. */
  async assistantAccounts(): Promise<Array<{ accountId: string; timezone: string }>> {
    return (await this.pool.query(`
      SELECT a.id, a.timezone FROM accounts a
      WHERE EXISTS (SELECT 1 FROM hatch_creator_products p WHERE p.creator_id = a.id::text AND p.status = 'active')
    `)).rows.map(row => ({ accountId: row.id, timezone: row.timezone || "UTC" }));
  }
}

export function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return value.length <= 64; } catch { return false; }
}

export function localHour(timezone: string, now: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
}

export function localDate(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
