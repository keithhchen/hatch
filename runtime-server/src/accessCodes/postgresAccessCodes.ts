import { randomBytes, randomInt } from "node:crypto";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import type { Locale } from "../locale.js";
import type { AccessCodes, AccessCodeOrder, AccessCodeSource, AccessCodeStatus, AccessCodeView, Activation, PayChannel, RedeemResult, CodeOutcome, DueCode } from "./accessCodes.js";

export const ACCESS_CODES_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_access_codes (
  code TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'used', 'void')),
  source TEXT NOT NULL DEFAULT 'free' CHECK (source IN ('free', 'paid', 'event')),
  out_trade_no TEXT UNIQUE,
  amount_fen INTEGER,
  email TEXT,
  pay_channel TEXT CHECK (pay_channel IN ('jsapi', 'h5')),
  transaction_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  used_by_conversation_id TEXT
);
ALTER TABLE hatch_access_codes ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE hatch_access_codes ADD COLUMN IF NOT EXISTS locale TEXT CHECK (locale IN ('zh', 'en', 'ja'));
ALTER TABLE hatch_access_codes ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hatch_access_codes ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE hatch_access_codes ADD COLUMN IF NOT EXISTS outcome TEXT CHECK (outcome IN ('ready', 'failed'));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hatch_access_codes_source_check' AND pg_get_constraintdef(oid) LIKE '%event%') THEN
    ALTER TABLE hatch_access_codes DROP CONSTRAINT IF EXISTS hatch_access_codes_source_check;
    ALTER TABLE hatch_access_codes ADD CONSTRAINT hatch_access_codes_source_check CHECK (source IN ('free', 'paid', 'event'));
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`;

// MSC and six characters, free or bought. No 0, 1, I, L or O: a code is read and typed by hand.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const newCode = () => `MSC${Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")}`;
const normalize = (code: string) => code.trim().toUpperCase();

type Row = { code: string; product_id: string; status: AccessCodeStatus; source: AccessCodeSource; email: string | null; name: string | null; locale: Locale | null; used_by_conversation_id: string | null; outcome: CodeOutcome | null; attempts: number };
const orderOf = (row: Row): AccessCodeOrder => ({ code: row.code, productId: row.product_id, email: row.email, name: row.name, locale: row.locale, status: row.status, source: row.source });

export class PostgresAccessCodes implements AccessCodes {
  /** `priceFen` is what a bought code costs: stored on the order, and the only amount that activates it. Without it codes can be redeemed, not sold. */
  constructor(private readonly db: PostgresQueryExecutor, private readonly priceFen?: number) {}

  async initialize(): Promise<void> { await this.db.query(ACCESS_CODES_SCHEMA); }

  async createPending(input: { productId: string; email: string; name?: string; payChannel?: PayChannel; locale?: Locale }) {
    if (this.priceFen === undefined) throw new Error("Access codes are not for sale: no price is configured.");
    // A code that collides with another is drawn again; the primary key is the arbiter.
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = newCode(), outTradeNo = `hp${randomBytes(12).toString("hex")}`;
      const inserted = await this.db.query(
        `INSERT INTO hatch_access_codes (code, product_id, status, source, out_trade_no, amount_fen, email, pay_channel, name, locale) VALUES ($1, $2, 'pending', 'paid', $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING RETURNING code`,
        [code, input.productId, outTradeNo, this.priceFen, input.email, input.payChannel ?? null, input.name ?? null, input.locale ?? null]);
      if (inserted.rows.length) return { code, outTradeNo };
    }
    throw new Error("Could not draw a free access code.");
  }

  async issueFree(productId: string): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = newCode();
      const inserted = await this.db.query(
        `INSERT INTO hatch_access_codes (code, product_id, status, source) VALUES ($1, $2, 'active', 'free') ON CONFLICT DO NOTHING RETURNING code`, [code, productId]);
      if (inserted.rows.length) return code;
    }
    throw new Error("Could not draw a free access code.");
  }

  async activatePaid(input: { outTradeNo: string; transactionId: string; amountFen: number }): Promise<Activation | undefined> {
    const won = await this.db.query<Row>(
      `UPDATE hatch_access_codes SET status = 'active', transaction_id = $2, paid_at = now()
       WHERE out_trade_no = $1 AND status = 'pending' AND amount_fen = $3 RETURNING code, product_id, status, source, email, name, locale, used_by_conversation_id`,
      [input.outTradeNo, input.transactionId, input.amountFen]);
    if (won.rows[0]) return { ...orderOf(won.rows[0]), activated: true };
    const order = await this.order(input.outTradeNo);
    return order && { ...order, activated: false };
  }

  async redeem(input: { code: string; productId: string; conversationId: string }): Promise<RedeemResult> {
    const code = normalize(input.code);
    const won = await this.db.query(
      `UPDATE hatch_access_codes SET status = 'used', used_at = now(), used_by_conversation_id = $3
       WHERE code = $1 AND product_id = $2 AND status = 'active' AND source <> 'event' RETURNING code`,
      [code, input.productId, input.conversationId]);
    if (won.rows.length) return { ok: true };
    // Lost: read why. A code used by this very conversation is the same redeem repeated.
    const row = (await this.db.query<Row>("SELECT * FROM hatch_access_codes WHERE code = $1", [code])).rows[0];
    if (!row || row.status === "void") return { ok: false, reason: "not_found" };
    if (row.product_id !== input.productId) return { ok: false, reason: "wrong_product" };
    if (row.status === "used") return row.used_by_conversation_id === input.conversationId ? { ok: true } : { ok: false, reason: "used" };
    if (row.source === "event") return { ok: false, reason: "used" };
    return { ok: false, reason: "not_paid" };
  }

  async lookup(code: string) {
    const row = (await this.db.query<Row>("SELECT * FROM hatch_access_codes WHERE code = $1", [normalize(code)])).rows[0];
    return row ? { status: row.status, source: row.source, productId: row.product_id, conversationId: row.used_by_conversation_id, outcome: row.outcome } : null;
  }

  async due(now: Date, limit: number): Promise<DueCode[]> {
    const rows = (await this.db.query<Row>(
      `SELECT code, product_id, used_by_conversation_id, attempts FROM hatch_access_codes
       WHERE status = 'used' AND outcome IS NULL AND used_by_conversation_id IS NOT NULL AND COALESCE(next_attempt_at, used_at + interval '15 seconds') <= $1
       ORDER BY used_at, code LIMIT $2`, [now, limit])).rows;
    return rows.map(row => ({ code: row.code, productId: row.product_id, conversationId: row.used_by_conversation_id!, attempts: row.attempts }));
  }

  async claim(code: string, attempts: number, nextAt: Date): Promise<boolean> {
    const won = await this.db.query(
      "UPDATE hatch_access_codes SET attempts = attempts + 1, next_attempt_at = $3 WHERE code = $1 AND attempts = $2 AND outcome IS NULL AND status = 'used' RETURNING code",
      [normalize(code), attempts, nextAt]);
    return won.rows.length > 0;
  }

  async conclude(code: string, outcome: CodeOutcome): Promise<void> {
    await this.db.query("UPDATE hatch_access_codes SET outcome = $2 WHERE code = $1 AND outcome IS NULL", [normalize(code), outcome]);
  }

  async peek(code: string): Promise<AccessCodeView | undefined> {
    const row = (await this.db.query<Row>("SELECT * FROM hatch_access_codes WHERE code = $1", [normalize(code)])).rows[0];
    return row && { code: row.code, productId: row.product_id, status: row.status, source: row.source, usedByConversationId: row.used_by_conversation_id };
  }

  async order(outTradeNo: string): Promise<AccessCodeOrder | undefined> {
    const row = (await this.db.query<Row>("SELECT * FROM hatch_access_codes WHERE out_trade_no = $1", [outTradeNo])).rows[0];
    return row && orderOf(row);
  }
}
