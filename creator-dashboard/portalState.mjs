import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { withSchemaLock } from "../packages/commerce/src/schemaLock.js";

const EMPTY_STATE = Object.freeze({
  contract_version: "1",
  checkout_sessions: {},
  creator_products: {},
  web_sessions: {},
  oauth_authorization_transactions: {},
  oauth_authorization_codes: {},
  oauth_access_tokens: {},
  oauth_refresh_tokens: {}
});

/**
 * Small durable workflow store for Portal state that is not a Commerce fact:
 * checkout release snapshots, Creator approvals/listings, and Factory form drafts.
 * Orders, entitlements, deliveries, revenue, refunds, and payouts stay in the
 * Commerce ledger/repository.
 */
export class PortalStateStore {
  #state;
  #writeChain = Promise.resolve();
  #pool;
  #ownsPool = false;

  constructor(options = {}) {
    this.filePath = options.filePath;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
    this.#state = structuredClone(options.state ?? EMPTY_STATE);
    this.#pool = options.pool;
    this.#ownsPool = options.ownsPool === true;
  }

  static async open(options = {}) {
    if (options.pool || options.Pool || options.connectionString) {
      const pool = options.pool ?? new options.Pool({
        connectionString: options.connectionString,
        ...(options.poolOptions ?? {})
      });
      const ownsPool = !options.pool;
      try {
        await withSchemaLock(pool, [`CREATE TABLE IF NOT EXISTS portal_workflow_state (
          singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
          state JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`]);
        await pool.query(
          `INSERT INTO portal_workflow_state (singleton, state)
           VALUES (TRUE, $1::jsonb)
           ON CONFLICT (singleton) DO NOTHING`,
          [JSON.stringify(EMPTY_STATE)]
        );
        const result = await pool.query("SELECT state FROM portal_workflow_state WHERE singleton = TRUE");
        const state = normalizeState(result.rows[0]?.state);
        await pool.query(
          "UPDATE portal_workflow_state SET state = $1::jsonb, updated_at = NOW() WHERE singleton = TRUE",
          [JSON.stringify(state)]
        );
        return new PortalStateStore({
          ...options,
          pool,
          ownsPool,
          state
        });
      } catch (error) {
        if (ownsPool) await pool.end?.().catch(() => undefined);
        throw error;
      }
    }
    let state = EMPTY_STATE;
    if (options.filePath) {
      try {
        state = normalizeState(JSON.parse(await readFile(options.filePath, "utf8")));
        await atomicWriteJson(options.filePath, state);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return new PortalStateStore({ ...options, state });
  }

  async refresh() {
    if (!this.#pool) return;
    const result = await this.#pool.query("SELECT state FROM portal_workflow_state WHERE singleton = TRUE");
    this.#state = normalizeState(result.rows[0]?.state);
  }

  async ready() {
    if (this.#pool) await this.#pool.query("SELECT 1");
    return true;
  }

  async close() {
    await this.#writeChain.catch(() => undefined);
    if (this.#ownsPool) await this.#pool?.end?.();
  }

  getWebSession(sessionId) {
    const session = clone(this.#state.web_sessions[sessionId]);
    if (!session || Date.parse(session.expires_at) <= this.clock().getTime()) return undefined;
    return session;
  }

  async createWebSession(registryToken, profile, options = {}) {
    const now = this.clock();
    const session = {
      session_id: this.idFactory("web_session"),
      ...(options.registryTokenCiphertext
        ? { registry_token_ciphertext: String(options.registryTokenCiphertext) }
        : { registry_token: String(registryToken) }),
      account_id: String(profile?.id ?? ""),
      created_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      expires_at: new Date(now.getTime() + Number(options.ttl_ms ?? 12 * 60 * 60_000)).toISOString()
    };
    await this.#mutate((state) => {
      for (const [id, current] of Object.entries(state.web_sessions)) {
        if (Date.parse(current.expires_at) <= now.getTime()) delete state.web_sessions[id];
      }
      state.web_sessions[session.session_id] = session;
    });
    return clone(session);
  }

  async deleteWebSession(sessionId) {
    await this.#mutate((state) => {
      delete state.web_sessions[sessionId];
    });
  }

  // OAuth records are part of the durable portal authority, not process-local
  // caches. Secret values are encrypted by the dashboard before they reach
  // this store; keys here are SHA-256 digests of the bearer/code values.
  getOAuthAuthorizationTransaction(transactionId) {
    return clone(this.#state.oauth_authorization_transactions[transactionId]);
  }

  async saveOAuthAuthorizationTransaction(transaction) {
    return this.#mutate((state) => {
      pruneExpiredOAuthRecords(state, this.clock());
      state.oauth_authorization_transactions[transaction.id] = clone(transaction);
      return transaction;
    });
  }

  async deleteOAuthAuthorizationTransaction(transactionId) {
    await this.#mutate((state) => {
      delete state.oauth_authorization_transactions[transactionId];
    });
  }

  getOAuthAuthorizationCode(codeDigest) {
    return clone(this.#state.oauth_authorization_codes[codeDigest]);
  }

  async saveOAuthAuthorizationCode(codeDigest, record) {
    return this.#mutate((state) => {
      pruneExpiredOAuthRecords(state, this.clock());
      state.oauth_authorization_codes[codeDigest] = clone(record);
      return record;
    });
  }

  async consumeOAuthAuthorizationCode(codeDigest) {
    return this.#mutate((state) => {
      pruneExpiredOAuthRecords(state, this.clock());
      const record = state.oauth_authorization_codes[codeDigest];
      if (!record) return undefined;
      delete state.oauth_authorization_codes[codeDigest];
      return record;
    });
  }

  getOAuthAccessToken(tokenDigest) {
    return clone(this.#state.oauth_access_tokens[tokenDigest]);
  }

  async saveOAuthAccessToken(tokenDigest, record) {
    return this.#mutate((state) => {
      pruneExpiredOAuthRecords(state, this.clock());
      state.oauth_access_tokens[tokenDigest] = clone(record);
      return record;
    });
  }

  async deleteOAuthAccessToken(tokenDigest) {
    await this.#mutate((state) => {
      delete state.oauth_access_tokens[tokenDigest];
    });
  }

  getOAuthRefreshToken(tokenDigest) {
    return clone(this.#state.oauth_refresh_tokens[tokenDigest]);
  }

  async saveOAuthRefreshToken(tokenDigest, record) {
    return this.#mutate((state) => {
      pruneExpiredOAuthRecords(state, this.clock());
      state.oauth_refresh_tokens[tokenDigest] = clone(record);
      return record;
    });
  }

  async deleteOAuthRefreshToken(tokenDigest) {
    await this.#mutate((state) => {
      delete state.oauth_refresh_tokens[tokenDigest];
    });
  }

  getCheckoutSession(sessionId) {
    return checkoutView(this.#state.checkout_sessions[sessionId], this.clock());
  }

  findCheckoutSessionByRequest(buyerId, requestKey) {
    return checkoutView(Object.values(this.#state.checkout_sessions).find((session) => (
      session.buyer_id === buyerId && session.request_key === requestKey
    )), this.clock());
  }

  findCheckoutSessionByPaymentId(paymentId) {
    return checkoutView(Object.values(this.#state.checkout_sessions).find((session) => (
      session.payment_id === paymentId
    )), this.clock());
  }

  async createCheckoutSession(input) {
    return this.#mutate((state) => {
      const existing = input.request_key
        ? Object.values(state.checkout_sessions).find((session) => (
          session.buyer_id === input.buyer_id && session.request_key === input.request_key
        ))
        : undefined;
      if (existing) return existing;
      const now = this.clock();
      const session = {
        ...clone(input),
        checkout_session_id: this.idFactory("checkout"),
        status: "open",
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 30 * 60_000).toISOString()
      };
      state.checkout_sessions[session.checkout_session_id] = session;
      return session;
    });
  }

  async completeCheckout(sessionId, outcome) {
    return this.#mutate((state) => {
      const session = requireRecord(state.checkout_sessions[sessionId], "checkout_not_found", "Checkout session was not found.");
      if (session.status === "completed") return session;
      if (session.status === "open" && Date.parse(session.expires_at) <= this.clock().getTime()) {
        session.status = "expired";
        session.updated_at = this.clock().toISOString();
        throw stateError("checkout_expired", "Checkout session has expired.", 409);
      }
      Object.assign(session, clone(outcome), {
        status: "completed",
        reconcile_last_error: null,
        updated_at: this.clock().toISOString()
      });
      return session;
    });
  }

  async noteCheckoutReconcileFailure(sessionId, error) {
    return this.#mutate((state) => {
      const session = requireRecord(state.checkout_sessions[sessionId], "checkout_not_found", "Checkout session was not found.");
      session.reconcile_attempts = Number(session.reconcile_attempts ?? 0) + 1;
      session.reconcile_last_error = {
        category: String(error?.code ?? "reconcile_failed"),
        occurred_at: this.clock().toISOString()
      };
      session.updated_at = this.clock().toISOString();
      return session;
    });
  }

  async markCheckoutCompensated(sessionId, outcome) {
    return this.#mutate((state) => {
      const session = requireRecord(state.checkout_sessions[sessionId], "checkout_not_found", "Checkout session was not found.");
      if (session.status === "refunded") return session;
      if (session.status !== "fulfillment_pending") {
        throw stateError("checkout_not_compensatable", "Only pending fulfillment can be compensated.", 409);
      }
      Object.assign(session, clone(outcome), {
        status: "refunded",
        payment_status: "refunded",
        reconcile_last_error: null,
        compensated_at: this.clock().toISOString(),
        updated_at: this.clock().toISOString()
      });
      return session;
    });
  }

  async markCheckoutFulfillmentPending(sessionId, outcome) {
    return this.#mutate((state) => {
      const session = requireRecord(state.checkout_sessions[sessionId], "checkout_not_found", "Checkout session was not found.");
      if (session.status === "completed") return session;
      if (!["open", "payment_pending", "fulfillment_pending"].includes(session.status)) {
        throw stateError("checkout_not_confirmable", "Checkout session cannot be fulfilled in its current state.", 409);
      }
      Object.assign(session, clone(outcome), {
        status: "fulfillment_pending",
        fulfillment_started_at: session.fulfillment_started_at ?? this.clock().toISOString(),
        updated_at: this.clock().toISOString()
      });
      return session;
    });
  }

  async markCheckoutReleaseChanged(sessionId, currentProduct) {
    return this.#mutate((state) => {
      const session = requireRecord(state.checkout_sessions[sessionId], "checkout_not_found", "Checkout session was not found.");
      if (["completed", "fulfillment_pending"].includes(session.status)) return session;
      session.status = "release_changed";
      session.release_change = {
        previous_release: clone(session.release ?? null),
        current_release: currentProduct ? {
          release_id: currentProduct.release_id ?? currentProduct.corpus_digest,
          corpus_digest: currentProduct.corpus_digest
        } : null,
        detected_at: this.clock().toISOString()
      };
      session.updated_at = this.clock().toISOString();
      return session;
    });
  }

  async markCheckoutPayment(sessionId, payment) {
    return this.#mutate((state) => {
      const session = requireRecord(state.checkout_sessions[sessionId], "checkout_not_found", "Checkout session was not found.");
      if (["completed", "fulfillment_pending"].includes(session.status)) return session;
      if (!["open", "payment_pending", "requires_action", "payment_failed"].includes(session.status)) {
        throw stateError("checkout_not_payable", "Checkout session cannot accept a payment update.", 409);
      }
      const providerStatus = String(payment.status ?? "pending");
      const status = providerStatus === "requires_action"
        ? "requires_action"
        : ["failed", "cancelled"].includes(providerStatus)
          ? "payment_failed"
          : "payment_pending";
      Object.assign(session, {
        payment_id: String(payment.payment_id),
        payment_status: providerStatus,
        payment_redirect_url: payment.redirect_url ?? null,
        payment_provider: payment.provider ?? null,
        status,
        updated_at: this.clock().toISOString()
      });
      return session;
    });
  }

  listPendingCheckouts() {
    return clone(Object.values(this.#state.checkout_sessions).filter((session) => session.status === "fulfillment_pending"));
  }

  listCheckoutSessions() {
    return clone(Object.values(this.#state.checkout_sessions));
  }

  listCreatorProducts(creatorId) {
    return clone(Object.values(this.#state.creator_products).filter((item) => (
      creatorId === undefined || item.creator_id === creatorId
    )));
  }

  getCreatorProduct(creatorId, productId) {
    return clone(this.#state.creator_products[creatorProductKey(creatorId, productId)]);
  }

  async withdrawProduct(creatorId, productId, expectedVersion, input = {}) {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      const commandPayload = {
        expected_version: expectedVersion,
        reason: String(input.reason ?? "").trim()
      };
      if (replayProductCommand(record, "product.withdraw", input.command_key, commandPayload)) return record;
      assertNoDeploymentInProgress(record);
      assertExpectedVersion(record, expectedVersion);
      if (record.status === "withdrawn") return record;
      const reason = String(input.reason ?? "").trim();
      if (!reason) throw stateError("audit_reason_required", "Explain why this product is being withdrawn.", 422);
      record.version += 1;
      record.status = "withdrawn";
      record.withdrawn_at = this.clock().toISOString();
      record.updated_at = record.withdrawn_at;
      appendAudit(record, "product.withdrawn", creatorId, reason, {
        release_id: record.release?.release_id ?? null,
        corpus_digest: record.release?.corpus_digest ?? null
      }, this.clock());
      rememberProductCommand(record, "product.withdraw", input.command_key, commandPayload);
      return record;
    });
  }

  async #mutate(change) {
    let result;
    const operation = this.#writeChain.catch(() => undefined).then(async () => {
      if (this.#pool) {
        const client = await this.#pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock($1)", [1_849_721_044]);
          const locked = await client.query(
            "SELECT state FROM portal_workflow_state WHERE singleton = TRUE FOR UPDATE"
          );
          const next = normalizeState(locked.rows[0]?.state);
          result = change(next);
          await client.query(
            `UPDATE portal_workflow_state
                SET state = $1::jsonb, updated_at = NOW()
              WHERE singleton = TRUE`,
            [JSON.stringify(next)]
          );
          await client.query("COMMIT");
          this.#state = next;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        return;
      }
      const next = structuredClone(this.#state);
      result = change(next);
      if (this.filePath) await atomicWriteJson(this.filePath, next);
      this.#state = next;
    });
    this.#writeChain = operation.catch(() => undefined);
    await operation;
    return clone(result);
  }
}

export function stateError(code, message, status = 422, details) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = clone(details);
  return error;
}

function normalizeState(value) {
  return {
    contract_version: "1",
    checkout_sessions: mapObjectValues(value?.checkout_sessions, stripRemovedCheckoutFields),
    creator_products: mapObjectValues(value?.creator_products, stripRemovedCreatorProductFields),
    web_sessions: objectValue(value?.web_sessions),
    oauth_authorization_transactions: objectValue(value?.oauth_authorization_transactions),
    oauth_authorization_codes: objectValue(value?.oauth_authorization_codes),
    oauth_access_tokens: objectValue(value?.oauth_access_tokens),
    oauth_refresh_tokens: objectValue(value?.oauth_refresh_tokens)
  };
}

function pruneExpiredOAuthRecords(state, now) {
  const maps = [
    state.oauth_authorization_transactions,
    state.oauth_authorization_codes,
    state.oauth_access_tokens,
    state.oauth_refresh_tokens
  ];
  const nowMs = now.getTime();
  for (const records of maps) {
    for (const [key, record] of Object.entries(records)) {
      const rawExpiry = record?.expiresAt ?? record?.expires_at;
      const expiresAt = typeof rawExpiry === "number" ? rawExpiry : Date.parse(String(rawExpiry ?? ""));
      if (Number.isFinite(expiresAt) && expiresAt <= nowMs) delete records[key];
    }
  }
}

function mapObjectValues(value, transform) {
  return Object.fromEntries(Object.entries(objectValue(value)).map(([key, item]) => [key, transform(item)]));
}

function stripRemovedCheckoutFields(value) {
  const session = clone(value) ?? {};
  delete session.offer_snapshot;
  delete session.quote_change;
  return session;
}

function stripRemovedCreatorProductFields(value) {
  const product = clone(value) ?? {};
  delete product.offer_draft;
  delete product.offer_active;
  for (const key of ["publish_operation", "last_publish_operation", "rollback_operation", "last_rollback_operation"]) {
    if (!product[key] || typeof product[key] !== "object") continue;
    delete product[key].offer_revision;
    delete product[key].offer_activated_at;
  }
  if (product.status === "offer_required") product.status = "ready_to_preview";
  return product;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}


function checkoutView(value, now) {
  const session = clone(value);
  if (session?.status === "open" && Date.parse(session.expires_at) <= now.getTime()) {
    session.status = "expired";
  }
  return session;
}

function requireRecord(value, code, message) {
  if (!value) throw stateError(code, message, 404);
  return value;
}

function creatorProductKey(creatorId, productId) {
  return `${creatorId}:${productId}`;
}


function appendAudit(record, action, actorId, reason, details, occurredAt) {
  record.audit_log ??= [];
  const auditId = `audit_${randomUUID().replaceAll("-", "")}`;
  const normalizedReason = String(reason ?? "").trim() || "unspecified";
  const normalizedDetails = clone(details ?? {});
  const aggregateId = `${record.creator_id}:${record.product_id}`;
  const correlationId = normalizedDetails.operation_id ?? auditId;
  const payloadDigest = `sha256:${createHash("sha256").update(JSON.stringify({
    action,
    actor_id: actorId,
    reason: normalizedReason,
    aggregate_id: aggregateId,
    details: normalizedDetails
  })).digest("hex")}`;
  record.audit_log.push({
    schema_version: 1,
    audit_id: auditId,
    action,
    actor_id: actorId,
    actor_type: "creator",
    service_name: "dashboard-bff",
    tenant_id: record.creator_id,
    aggregate_type: "creator_product",
    aggregate_id: aggregateId,
    request_id: normalizedDetails.request_id ?? null,
    correlation_id: correlationId,
    causation_id: normalizedDetails.causation_id ?? null,
    reason: normalizedReason,
    details: normalizedDetails,
    payload_digest: payloadDigest,
    occurred_at: occurredAt.toISOString()
  });
}

function replayProductCommand(record, action, commandKey, payload) {
  if (!commandKey) return false;
  const receipt = record.command_receipts?.[`${action}:${commandKey}`];
  if (!receipt) return false;
  if (receipt.payload_digest !== portalCommandDigest(action, payload)) {
    throw stateError("idempotency_conflict", "This command key was already used with a different payload.", 409);
  }
  return true;
}

function rememberProductCommand(record, action, commandKey, payload) {
  if (!commandKey) return;
  record.command_receipts ??= {};
  record.command_receipts[`${action}:${commandKey}`] = {
    action,
    command_key: commandKey,
    payload_digest: portalCommandDigest(action, payload),
    completed_at: record.updated_at
  };
}

function portalCommandDigest(action, payload) {
  return `sha256:${createHash("sha256").update(canonicalJson({ action, payload })).digest("hex")}`;
}




function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function creatorProductRecord(state, creatorId, productId) {
  const key = creatorProductKey(creatorId, productId);
  state.creator_products[key] ??= {
    creator_id: creatorId,
    product_id: productId,
    version: 0,
    status: "candidate_required",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  return state.creator_products[key];
}

function assertExpectedVersion(record, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === "") return;
  if (!Number.isInteger(Number(expectedVersion)) || Number(expectedVersion) !== record.version) {
    throw stateError("stale_version", "This record changed in another tab. Refresh and try again.", 409);
  }
}

function assertNoDeploymentInProgress(record) {
  if (record.publish_operation || record.rollback_operation) {
    throw stateError("deployment_in_progress", "Finish the pending publish or rollback before changing its candidate.", 409);
  }
}



async function atomicWriteJson(destination, value) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}
