import type { Pool } from "pg";
import { emptyTokens, emptySurfaces, monthStart, sumDays, USAGE_SURFACES, utcDay, type DailyUsage, type SurfaceTokens, type TokenCount, type UsageEvent, type UsageReader, type UsageRecorder, type UsageSurface } from "./usage.js";

const DDL = [
  `CREATE TABLE IF NOT EXISTS hatch_usage_events (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    surface TEXT NOT NULL CHECK (surface IN ('studio_web', 'studio_api', 'chat_web', 'responses_api')),
    api_key_id TEXT,
    product_id TEXT,
    run_id TEXT,
    model TEXT NOT NULL,
    input_tokens BIGINT NOT NULL,
    cached_input_tokens BIGINT NOT NULL,
    output_tokens BIGINT NOT NULL,
    reasoning_tokens BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS hatch_usage_events_account_created ON hatch_usage_events (account_id, created_at)",
  `CREATE TABLE IF NOT EXISTS hatch_usage_daily (
    account_id TEXT NOT NULL,
    surface TEXT NOT NULL,
    day DATE NOT NULL,
    input_tokens BIGINT NOT NULL,
    cached_input_tokens BIGINT NOT NULL,
    output_tokens BIGINT NOT NULL,
    reasoning_tokens BIGINT NOT NULL,
    PRIMARY KEY (account_id, surface, day)
  )`
];

/**
 * Tables made before the four surfaces carry 'studio' and 'chat_api'. Rewrites them once: events by who made the request
 * (a Studio call with an API key is studio_api), then the rollup from the events, which are its source. The old CHECK is
 * the marker, so a later boot finds nothing to do.
 */
export const MIGRATE_SURFACES = `
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'hatch_usage_events'::regclass AND conname = 'hatch_usage_events_surface_check' AND pg_get_constraintdef(oid) LIKE '%chat_api%') THEN
    ALTER TABLE hatch_usage_events DROP CONSTRAINT hatch_usage_events_surface_check;
    UPDATE hatch_usage_events SET surface = CASE
      WHEN surface = 'chat_api' THEN 'responses_api'
      WHEN surface = 'studio' AND api_key_id IS NOT NULL THEN 'studio_api'
      WHEN surface = 'studio' THEN 'studio_web'
      ELSE surface END
      WHERE surface IN ('studio', 'chat_api');
    ALTER TABLE hatch_usage_events ADD CONSTRAINT hatch_usage_events_surface_check
      CHECK (surface IN ('studio_web', 'studio_api', 'chat_web', 'responses_api'));
    DELETE FROM hatch_usage_daily;
    INSERT INTO hatch_usage_daily (account_id, surface, day, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens)
      SELECT account_id, surface, (created_at AT TIME ZONE 'UTC')::date, SUM(input_tokens), SUM(cached_input_tokens), SUM(output_tokens), SUM(reasoning_tokens)
      FROM hatch_usage_events GROUP BY account_id, surface, (created_at AT TIME ZONE 'UTC')::date;
  END IF;
END $$`;

/**
 * The ledger in Postgres. An event is appended and the day's rollup incremented in one transaction; the event's id is its
 * identity, so a retried write finds it and changes nothing.
 */
export class PostgresUsageLedger implements UsageRecorder, UsageReader {
  private ready?: Promise<void>;
  constructor(private readonly pool: Pool) {}

  private schema(): Promise<void> {
    this.ready ??= this.migrate().catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }

  /** One transaction under an advisory lock, so boots running together take turns and the later one finds nothing to do. */
  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('hatch_usage_schema'))");
      for (const statement of [...DDL, MIGRATE_SURFACES]) await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async record(event: UsageEvent): Promise<void> {
    await this.schema();
    const at = event.at ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO hatch_usage_events (id, account_id, surface, api_key_id, product_id, run_id, model, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
        [event.id, event.accountId, event.surface, event.apiKeyId ?? null, event.productId ?? null, event.runId ?? null, event.model,
          event.inputTokens, event.cachedInputTokens, event.outputTokens, event.reasoningTokens, at]
      );
      if (inserted.rowCount) {
        await client.query(
          `INSERT INTO hatch_usage_daily (account_id, surface, day, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (account_id, surface, day) DO UPDATE SET
             input_tokens = hatch_usage_daily.input_tokens + EXCLUDED.input_tokens,
             cached_input_tokens = hatch_usage_daily.cached_input_tokens + EXCLUDED.cached_input_tokens,
             output_tokens = hatch_usage_daily.output_tokens + EXCLUDED.output_tokens,
             reasoning_tokens = hatch_usage_daily.reasoning_tokens + EXCLUDED.reasoning_tokens`,
          [event.accountId, event.surface, utcDay(at), event.inputTokens, event.cachedInputTokens, event.outputTokens, event.reasoningTokens]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async forRun(runId: string): Promise<TokenCount> {
    await this.schema();
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(cached_input_tokens), 0) AS cached, COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(reasoning_tokens), 0) AS reasoning
       FROM hatch_usage_events WHERE run_id = $1`, [runId]
    );
    const row = rows[0];
    return row ? { input: Number(row.input), cachedInput: Number(row.cached), output: Number(row.output), reasoning: Number(row.reasoning) } : emptyTokens();
  }

  async daily(accountId: string, from: string, to: string): Promise<DailyUsage[]> {
    await this.schema();
    const { rows } = await this.pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, surface, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens
       FROM hatch_usage_daily WHERE account_id = $1 AND day BETWEEN $2::date AND $3::date ORDER BY day`,
      [accountId, from, to]
    );
    const byDay = new Map<string, SurfaceTokens>();
    for (const row of rows) {
      if (!(USAGE_SURFACES as readonly string[]).includes(row.surface)) continue;
      const surfaces = byDay.get(row.day) ?? emptySurfaces();
      byDay.set(row.day, surfaces);
      surfaces[row.surface as UsageSurface] = {
        input: Number(row.input_tokens), cachedInput: Number(row.cached_input_tokens), output: Number(row.output_tokens), reasoning: Number(row.reasoning_tokens)
      };
    }
    return [...byDay].map(([day, usage]) => ({ day, usage }));
  }

  async monthToDate(accountId: string, now = new Date()): Promise<SurfaceTokens> {
    return sumDays(await this.daily(accountId, monthStart(now), utcDay(now)));
  }
}
