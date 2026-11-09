import type { Pool } from "pg";

export type Rate = { capacity: number; perSecond: number };

/** Port: a token bucket every process shares. */
export interface RateLimiter {
  /** Takes one token. Zero means go ahead; otherwise the milliseconds until one is free. */
  take(key: string, rate: Rate, now?: Date): Promise<number>;
}

export class PostgresRateLimiter implements RateLimiter {
  private constructor(private pool: Pool) {}
  static async open(pool: Pool): Promise<PostgresRateLimiter> {
    await pool.query("CREATE TABLE IF NOT EXISTS hatch_channel_rate (key TEXT PRIMARY KEY, tokens DOUBLE PRECISION NOT NULL, updated_at TIMESTAMPTZ NOT NULL)");
    return new PostgresRateLimiter(pool);
  }
  /** One statement: the refill, the check and the take cannot interleave with another process. */
  async take(key: string, rate: Rate, now = new Date()): Promise<number> {
    const refilled = "LEAST($2::float8, bucket.tokens + GREATEST(extract(epoch FROM ($4::timestamptz - bucket.updated_at)), 0) * $3::float8)";
    const taken = await this.pool.query(`INSERT INTO hatch_channel_rate AS bucket (key, tokens, updated_at) VALUES ($1, $2::float8 - 1, $4::timestamptz)
      ON CONFLICT (key) DO UPDATE SET tokens = ${refilled} - 1, updated_at = $4::timestamptz WHERE ${refilled} >= 1 RETURNING tokens`,
    [key, rate.capacity, rate.perSecond, now]);
    return taken.rowCount ? 0 : Math.ceil(1000 / rate.perSecond);
  }
}
