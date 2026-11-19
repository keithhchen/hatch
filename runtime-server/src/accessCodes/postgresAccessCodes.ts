import { randomBytes, randomInt } from "node:crypto";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import type { AccessCodes, AccessCodeOrder, AccessCodeSource, AccessCodeStatus, AccessCodeView, Activation, PayChannel, RedeemResult } from "./accessCodes.js";

export const ACCESS_CODES_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_access_codes (
  code TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'used', 'void')),
  source TEXT NOT NULL DEFAULT 'free' CHECK (source IN ('free', 'paid')),
  out_trade_no TEXT UNIQUE,
  amount_fen INTEGER,
  email TEXT,
  pay_channel TEXT CHECK (pay_channel IN ('jsapi', 'h5')),
  transaction_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  used_by_conversation_id TEXT
);`;

// MSC and six characters, free or bought. No 0, 1, I, L or O: a code is read and typed by hand.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const newCode = () => `MSC${Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")}`;
const normalize = (code: string) => code.trim().toUpperCase();

type Row = { code: string; product_id: string; status: AccessCodeStatus; source: AccessCodeSource; email: string | null; used_by_conversation_id: string | null };
const orderOf = (row: Row): AccessCodeOrder => ({ code: row.code, productId: row.product_id, email: row.email, status: row.status, source: row.source });

export class PostgresAccessCodes implements AccessCodes {
  /** `priceFen` is what a bought code costs: stored on the order, and the only amount that activates it. Without it codes can be redeemed, not sold. */
  constructor(private readonly db: PostgresQueryExecutor, private readonly priceFen?: number) {}

  async initialize(): Promise<void> { await this.db.query(ACCESS_CODES_SCHEMA); }

  async createPending(input: { productId: string; email: string; payChannel?: PayChannel }) {
    if (this.priceFen === undefined) throw new Error("Access codes are not for sale: no price is configured.");
    // A code that collides with another is drawn again; the primary key is the arbiter.
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = newCode(), outTradeNo = `hp${randomBytes(12).toString("hex")}`;
      const inserted = await this.db.query(
        `INSERT INTO hatch_access_codes (code, product_id, status, source, out_trade_no, amount_fen, email, pay_channel) VALUES ($1, $2, 'pending', 'paid', $3, $4, $5, $6)
         ON CONFLICT DO NOTHING RETURNING code`,
        [code, input.productId, outTradeNo, this.priceFen, input.email, input.payChannel ?? null]);
      if (inserted.rows.length) return { code, outTradeNo };
    }
    throw new Error("Could not draw a free access code.");
  }

  async activatePaid(input: { outTradeNo: string; transactionId: string; amountFen: number }): Promise<Activation | undefined> {
    const won = await this.db.query<Row>(
      `UPDATE hatch_access_codes SET status = 'active', transaction_id = $2, paid_at = now()
       WHERE out_trade_no = $1 AND status = 'pending' AND amount_fen = $3 RETURNING code, product_id, status, source, email, used_by_conversation_id`,
      [input.outTradeNo, input.transactionId, input.amountFen]);
    if (won.rows[0]) return { ...orderOf(won.rows[0]), activated: true };
    const order = await this.order(input.outTradeNo);
    return order && { ...order, activated: false };
  }

  async redeem(input: { code: string; productId: string; conversationId: string }): Promise<RedeemResult> {
    const code = normalize(input.code);
    const won = await this.db.query(
      `UPDATE hatch_access_codes SET status = 'used', used_at = now(), used_by_conversation_id = $3
       WHERE code = $1 AND product_id = $2 AND status = 'active' RETURNING code`,
      [code, input.productId, input.conversationId]);
    if (won.rows.length) return { ok: true };
    // Lost: read why. A code used by this very conversation is the same redeem repeated.
    const row = (await this.db.query<Row>("SELECT * FROM hatch_access_codes WHERE code = $1", [code])).rows[0];
    if (!row || row.status === "void") return { ok: false, reason: "not_found" };
    if (row.product_id !== input.productId) return { ok: false, reason: "wrong_product" };
    if (row.status === "used") return row.used_by_conversation_id === input.conversationId ? { ok: true } : { ok: false, reason: "used" };
    return { ok: false, reason: "not_paid" };
  }

  async lookup(code: string) {
    const view = await this.peek(code);
    return view ? { status: view.status, source: view.source, productId: view.productId, conversationId: view.usedByConversationId } : null;
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
