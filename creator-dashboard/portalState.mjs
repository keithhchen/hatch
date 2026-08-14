import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = Object.freeze({
  contract_version: "1",
  checkout_sessions: {},
  creator_products: {},
  factory_drafts: {},
  web_sessions: {}
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
        await pool.query(`CREATE TABLE IF NOT EXISTS portal_workflow_state (
          singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
          state JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
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
      registry_token: String(registryToken),
      account_id: String(profile?.id ?? ""),
      role: profile?.role ?? null,
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

  getFactoryDraft(creatorId, draftId = "default") {
    const draft = this.#state.factory_drafts[factoryDraftKey(creatorId, draftId)];
    return clone(draft ?? {
      draft_id: draftId,
      creator_id: creatorId,
      version: 0,
      task_name: "",
      task_brief: "",
      sources: [{ id: "S1", title: "", authority: "private_material", content: "" }],
      saved_at: null
    });
  }

  async saveFactoryDraft(creatorId, draftId, input, expectedVersion, commandKey) {
    return this.#mutate((state) => {
      const key = factoryDraftKey(creatorId, draftId);
      const current = state.factory_drafts[key] ?? this.getFactoryDraft(creatorId, draftId);
      const content = {
        task_name: String(input.task_name ?? ""),
        task_brief: String(input.task_brief ?? ""),
        sources: Array.isArray(input.sources) ? clone(input.sources) : []
      };
      const payloadDigest = factoryDraftDigest(content);
      if (commandKey && current.last_command?.key === commandKey) {
        if (current.last_command.payload_digest !== payloadDigest) {
          throw stateError("idempotency_conflict", "This Factory save key was already used with different content.", 409);
        }
        return current;
      }
      // If the server committed but the response was lost, a client may retry
      // the identical snapshot with a fresh transport key and its prior
      // expected_version. Treat that exact content as recovery, never as a
      // stale overwrite.
      if (Number(expectedVersion) !== Number(current.version)
        && Number(expectedVersion) === Number(current.version) - 1
        && factoryDraftDigest(current) === payloadDigest) {
        return current;
      }
      assertExpectedVersion(current, expectedVersion);
      const next = {
        draft_id: draftId,
        creator_id: creatorId,
        version: current.version + 1,
        ...content,
        ...(commandKey ? { last_command: { key: commandKey, payload_digest: payloadDigest } } : {}),
        saved_at: this.clock().toISOString()
      };
      state.factory_drafts[key] = next;
      return next;
    });
  }

  async clearFactoryDraft(creatorId, draftId = "default") {
    await this.#mutate((state) => {
      delete state.factory_drafts[factoryDraftKey(creatorId, draftId)];
    });
  }

  async beginFactoryDraftStart(creatorId, draftId, expectedVersion, commandKey) {
    return this.#mutate((state) => {
      const key = factoryDraftKey(creatorId, draftId);
      const draft = state.factory_drafts[key] ?? this.getFactoryDraft(creatorId, draftId);
      if (!draft || draft.version <= 0) {
        throw stateError("factory_draft_empty", "Save the Factory draft before starting distillation.", 422);
      }
      if (!commandKey) throw stateError("idempotency_required", "Factory start requires an Idempotency-Key.", 422);
      const payloadDigest = portalCommandDigest("factory.start", {
        draft_id: draftId,
        expected_version: Number(expectedVersion)
      });
      const existing = draft.start_commands?.[commandKey];
      if (existing) {
        if (existing.payload_digest !== payloadDigest) {
          throw stateError("idempotency_conflict", "This Factory start key was already used with a different draft version.", 409);
        }
        return { draft, receipt: existing };
      }
      assertExpectedVersion(draft, expectedVersion);
      draft.start_commands ??= {};
      draft.start_commands[commandKey] = {
        command_key: commandKey,
        payload_digest: payloadDigest,
        status: "started",
        started_at: this.clock().toISOString()
      };
      state.factory_drafts[key] = draft;
      return { draft, receipt: draft.start_commands[commandKey] };
    });
  }

  async completeFactoryDraftStart(creatorId, draftId, commandKey, run) {
    return this.#mutate((state) => {
      const draft = requireRecord(
        state.factory_drafts[factoryDraftKey(creatorId, draftId)],
        "factory_draft_empty",
        "Factory draft was not found."
      );
      const receipt = requireRecord(
        draft.start_commands?.[commandKey],
        "factory_start_not_pending",
        "Factory start command was not found."
      );
      if (receipt.status === "completed") return { draft, receipt };
      receipt.status = "completed";
      receipt.run = clone(run);
      receipt.completed_at = this.clock().toISOString();
      return { draft, receipt };
    });
  }

  listCreatorProducts(creatorId) {
    return clone(Object.values(this.#state.creator_products).filter((item) => (
      creatorId === undefined || item.creator_id === creatorId
    )));
  }

  getCreatorProduct(creatorId, productId) {
    return clone(this.#state.creator_products[creatorProductKey(creatorId, productId)]);
  }

  async seedPublishedProduct(creatorId, productId, catalogSnapshot) {
    if (!catalogSnapshot?.corpus_digest) return this.getCreatorProduct(creatorId, productId);
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      if (record.release) return record;
      const now = this.clock().toISOString();
      const releaseId = String(catalogSnapshot.release_id ?? catalogSnapshot.corpus_digest);
      record.release = {
        release_id: releaseId,
        revision: 0,
        corpus_digest: catalogSnapshot.corpus_digest,
        catalog_snapshot: clone(catalogSnapshot),
        deployment_operation_id: `migration:${releaseId}`,
        current: true,
        published_at: catalogSnapshot.published_at ?? now
      };
      record.releases = [clone(record.release)];
      record.active_deployment_id = record.release.deployment_operation_id;
      record.public_url = `/products/${encodeURIComponent(productId)}`;
      record.status = "published";
      record.updated_at = now;
      appendAudit(record, "release.migrated", creatorId, "registry_release_migration", {
        operation_id: record.active_deployment_id,
        release_id: releaseId,
        corpus_digest: record.release.corpus_digest
      }, this.clock());
      return record;
    });
  }

  async approveCandidate(creatorId, productId, candidate, expectedVersion, audit = {}) {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      const commandPayload = {
        candidate_id: candidate.candidate_id,
        candidate_digest: candidate.digest,
        report_digest: candidate.report_digest ?? candidate.digest,
        expected_version: expectedVersion,
        acknowledgements: audit.acknowledgements ?? [],
        reason: audit.reason ?? "creator_approval"
      };
      if (replayProductCommand(record, "candidate.approve", audit.command_key, commandPayload)) return record;
      assertNoDeploymentInProgress(record);
      assertExpectedVersion(record, expectedVersion);
      record.version += 1;
      record.candidate = clone(candidate);
      record.approval = {
        candidate_id: candidate.candidate_id,
        candidate_digest: candidate.digest,
        report_digest: candidate.report_digest ?? candidate.digest,
        status: "approved",
        approved_at: this.clock().toISOString()
      };
      record.status = "ready_to_preview";
      record.updated_at = this.clock().toISOString();
      appendAudit(record, "candidate.approved", creatorId, audit.reason ?? "creator_approval", {
        candidate_id: candidate.candidate_id,
        candidate_digest: candidate.digest,
        report_digest: candidate.report_digest ?? candidate.digest
      }, this.clock());
      rememberProductCommand(record, "candidate.approve", audit.command_key, commandPayload);
      return record;
    });
  }

  async rejectCandidate(creatorId, productId, candidateId, expectedVersion, audit = {}) {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      const commandPayload = {
        candidate_id: candidateId,
        expected_version: expectedVersion,
        reason: audit.reason ?? "creator_rejection"
      };
      if (replayProductCommand(record, "candidate.reject", audit.command_key, commandPayload)) return record;
      assertNoDeploymentInProgress(record);
      assertExpectedVersion(record, expectedVersion);
      record.version += 1;
      record.approval = { candidate_id: candidateId, status: "rejected", rejected_at: this.clock().toISOString() };
      record.status = "candidate_rejected";
      record.updated_at = this.clock().toISOString();
      appendAudit(record, "candidate.rejected", creatorId, audit.reason ?? "creator_rejection", {
        candidate_id: candidateId
      }, this.clock());
      rememberProductCommand(record, "candidate.reject", audit.command_key, commandPayload);
      return record;
    });
  }

  async markCandidateChanged(creatorId, productId, candidate, audit = {}) {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      const approval = record.approval;
      if (approvalMatchesCandidate(approval, candidate)) return record;
      const now = this.clock().toISOString();
      const abandonedOperation = record.publish_operation
        ? clone(record.publish_operation)
        : null;
      record.version += 1;
      record.candidate = clone(candidate);
      record.approval = approval ? {
        ...approval,
        status: "stale",
        invalidated_at: now,
        current_candidate_id: candidate.candidate_id,
        current_candidate_digest: candidate.digest,
        current_report_digest: candidate.report_digest
      } : null;
      delete record.publish_operation;
      record.status = "candidate_ready";
      record.updated_at = now;
      appendAudit(record, "candidate.approval_stale", creatorId, audit.reason ?? "candidate_changed", {
        previous_candidate_id: approval?.candidate_id ?? null,
        previous_candidate_digest: approval?.candidate_digest ?? null,
        current_candidate_id: candidate.candidate_id,
        current_candidate_digest: candidate.digest,
        abandoned_publish_operation_id: abandonedOperation?.operation_id ?? null
      }, this.clock());
      return record;
    });
  }

  validatePublishProduct(creatorId, productId, input = {}) {
    const record = requireRecord(
      this.#state.creator_products[creatorProductKey(creatorId, productId)],
      "product_not_found",
      "Product workflow state was not found."
    );
    assertPublishable(record, input);
    return clone(record);
  }

  validatePublishCommand(creatorId, productId, input = {}) {
    const record = requireRecord(
      this.#state.creator_products[creatorProductKey(creatorId, productId)],
      "product_not_found",
      "Product workflow state was not found."
    );
    validateDeploymentCommand(
      record.publish_operation ?? record.last_publish_operation,
      "release.publish",
      input.command_key,
      publishCommandPayload(input)
    );
    return clone(record);
  }

  async beginPublishProduct(creatorId, productId, input = {}) {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      const existing = record.publish_operation;
      if (existing) {
        validateDeploymentCommand(existing, "release.publish", input.command_key, publishCommandPayload(input));
        const sameIntent = existing.candidate_id === (input.candidate_id ?? existing.candidate_id);
        if (!sameIntent) {
          throw stateError("publish_in_progress", "Another publish is already in progress for this product.", 409);
        }
        return record;
      }
      assertPublishable(record, input);
      const now = this.clock().toISOString();
      record.version += 1;
      record.status = "publishing";
      record.publish_operation = {
        operation_id: this.idFactory("publish"),
        release_id: this.idFactory("release"),
        command_key: input.command_key ?? null,
        payload_digest: input.command_key
          ? portalCommandDigest("release.publish", publishCommandPayload(input))
          : null,
        agent_id: input.agent_id ?? record.candidate?.agent_id ?? null,
        previous_corpus_digest: input.previous_corpus_digest ?? record.release?.corpus_digest ?? null,
        previous_release_id: input.previous_release_id ?? record.release?.release_id ?? null,
        previous_deployment_id: record.active_deployment_id ?? null,
        candidate_id: record.approval.candidate_id,
        candidate_digest: record.approval.candidate_digest,
        report_digest: record.approval.report_digest,
        started_at: now
      };
      appendAudit(record, "release.publish_started", creatorId, input.reason ?? "creator_publish", {
        operation_id: record.publish_operation.operation_id,
        candidate_id: record.publish_operation.candidate_id,
        candidate_digest: record.publish_operation.candidate_digest
      }, this.clock());
      record.updated_at = now;
      return record;
    });
  }

  async markPublishMaterialized(creatorId, productId, operationId, catalogSnapshot) {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      const operation = requireRecord(record.publish_operation, "publish_not_pending", "No publish operation is pending.");
      if (operation.operation_id !== operationId) {
        throw stateError("publish_operation_changed", "The publish operation changed. Refresh and try again.", 409);
      }
      if (operation.catalog_snapshot) {
        if (operation.catalog_snapshot.corpus_digest !== catalogSnapshot?.corpus_digest) {
          throw stateError("publish_operation_changed", "The materialized release changed for this publish operation.", 409);
        }
        return record;
      }
      operation.catalog_snapshot = clone(catalogSnapshot);
      operation.agent_id = catalogSnapshot?.agent_id ?? operation.agent_id;
      operation.materialized_at = this.clock().toISOString();
      record.updated_at = operation.materialized_at;
      return record;
    });
  }

  async abandonUnmaterializedPublish(creatorId, productId, operationId, reason = "candidate_changed") {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      const operation = requireRecord(record.publish_operation, "publish_not_pending", "No publish operation is pending.");
      if (operation.operation_id !== operationId) {
        throw stateError("publish_operation_changed", "The publish operation changed. Refresh and try again.", 409);
      }
      if (operation.materialized_at || operation.registry_activated_at) {
        throw stateError("deployment_in_progress", "A materialized deployment must be resumed rather than abandoned.", 409);
      }
      const now = this.clock().toISOString();
      record.approval = record.approval ? { ...record.approval, status: "stale", invalidated_at: now } : null;
      record.status = "candidate_ready";
      record.updated_at = now;
      delete record.publish_operation;
      appendAudit(record, "release.publish_abandoned", creatorId, reason, {
        operation_id: operation.operation_id,
        candidate_id: operation.candidate_id,
        candidate_digest: operation.candidate_digest
      }, this.clock());
      return record;
    });
  }

  async markPublishRegistryActivated(creatorId, productId, operationId) {
    return this.#markDeploymentPhase(creatorId, productId, "publish_operation", operationId, "registry_activated_at");
  }

  async commitPublishProduct(creatorId, productId, operationId) {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      const operation = requireRecord(record.publish_operation, "publish_not_pending", "No publish operation is pending.");
      if (operation.operation_id !== operationId) {
        throw stateError("publish_operation_changed", "The publish operation changed. Refresh and try again.", 409);
      }
      if (!operation.registry_activated_at) {
        throw stateError("deployment_not_ready", "The release is not fully activated yet.", 409);
      }
      const now = this.clock().toISOString();
      record.release_revision = (record.release_revision ?? 0) + 1;
      record.release = {
        release_id: operation.release_id,
        revision: record.release_revision,
        candidate_id: operation.candidate_id,
        corpus_digest: operation.candidate_digest,
        report_digest: operation.report_digest,
        catalog_snapshot: clone(operation.catalog_snapshot ?? null),
        deployment_operation_id: operation.operation_id,
        current: true,
        published_at: now
      };
      record.releases = (record.releases ?? []).map((release) => ({ ...release, current: false }));
      record.releases.push(clone(record.release));
      record.active_deployment_id = operation.operation_id;
      record.status = "published";
      record.public_url = `/products/${encodeURIComponent(productId)}`;
      record.published_at = now;
      record.updated_at = now;
      record.last_publish_operation = { ...operation, completed_at: now };
      delete record.publish_operation;
      appendAudit(record, "release.published", creatorId, "publish_completed", {
        operation_id: operation.operation_id,
        release_id: record.release.release_id,
        corpus_digest: record.release.corpus_digest
      }, this.clock());
      return record;
    });
  }

  async completePublishProduct(creatorId, productId, operationId) {
    await this.markPublishRegistryActivated(creatorId, productId, operationId);
    return this.commitPublishProduct(creatorId, productId, operationId);
  }

  async beginRollbackProduct(creatorId, productId, releaseId, expectedVersion, input = {}) {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      if (record.release?.release_id === releaseId) return record;
      if (record.rollback_operation) {
        validateDeploymentCommand(
          record.rollback_operation,
          "release.rollback",
          input.command_key,
          rollbackCommandPayload(releaseId, expectedVersion, input)
        );
        if (record.rollback_operation.release_id !== releaseId) {
          throw stateError("rollback_in_progress", "Another rollback is already in progress.", 409);
        }
        return record;
      }
      assertNoDeploymentInProgress(record);
      assertExpectedVersion(record, expectedVersion);
      const release = (record.releases ?? []).find((item) => item.release_id === releaseId);
      if (!release) throw stateError("release_not_found", "Historical release was not found.", 404);
      const reason = String(input.reason ?? "").trim();
      if (!reason) throw stateError("audit_reason_required", "Explain why this release is being activated.", 422);
      record.version += 1;
      record.status = "rolling_back";
      record.rollback_operation = {
        operation_id: this.idFactory("rollback"),
        command_key: input.command_key ?? null,
        payload_digest: input.command_key
          ? portalCommandDigest("release.rollback", rollbackCommandPayload(releaseId, expectedVersion, input))
          : null,
        agent_id: input.agent_id ?? record.release?.catalog_snapshot?.agent_id ?? null,
        previous_corpus_digest: record.release?.corpus_digest ?? null,
        previous_release_id: record.release?.release_id ?? null,
        previous_deployment_id: record.active_deployment_id ?? null,
        release_id: release.release_id,
        corpus_digest: release.corpus_digest,
        reason,
        actor_id: creatorId,
        started_at: this.clock().toISOString()
      };
      appendAudit(record, "release.rollback_started", creatorId, reason, {
        operation_id: record.rollback_operation.operation_id,
        release_id: release.release_id,
        corpus_digest: release.corpus_digest
      }, this.clock());
      record.updated_at = this.clock().toISOString();
      return record;
    });
  }

  validateRollbackCommand(creatorId, productId, releaseId, expectedVersion, input = {}) {
    const record = requireRecord(
      this.#state.creator_products[creatorProductKey(creatorId, productId)],
      "product_not_found",
      "Product workflow state was not found."
    );
    validateDeploymentCommand(
      record.rollback_operation ?? record.last_rollback_operation,
      "release.rollback",
      input.command_key,
      rollbackCommandPayload(releaseId, expectedVersion, input)
    );
    return clone(record);
  }

  async markRollbackRegistryActivated(creatorId, productId, operationId) {
    return this.#markDeploymentPhase(creatorId, productId, "rollback_operation", operationId, "registry_activated_at");
  }

  async noteDeploymentFailure(creatorId, productId, operationId, error) {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      const operation = [record.publish_operation, record.rollback_operation]
        .find((candidate) => candidate?.operation_id === operationId);
      if (!operation) return record;
      operation.attempts = Number(operation.attempts ?? 0) + 1;
      operation.last_error = {
        category: String(error?.code ?? "deployment_failed"),
        occurred_at: this.clock().toISOString()
      };
      record.updated_at = operation.last_error.occurred_at;
      return record;
    });
  }

  async commitRollbackProduct(creatorId, productId, operationId) {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      const operation = requireRecord(record.rollback_operation, "rollback_not_pending", "No rollback operation is pending.");
      if (operation.operation_id !== operationId) {
        throw stateError("rollback_operation_changed", "The rollback operation changed.", 409);
      }
      if (!operation.registry_activated_at) {
        throw stateError("deployment_not_ready", "The rollback is not fully activated yet.", 409);
      }
      const release = (record.releases ?? []).find((item) => item.release_id === operation.release_id);
      if (!release) throw stateError("release_not_found", "Historical release was not found.", 404);
      const now = this.clock().toISOString();
      record.releases = record.releases.map((item) => ({ ...item, current: item.release_id === release.release_id }));
      record.release = {
        ...release,
        current: true,
        deployment_operation_id: operation.operation_id,
        rolled_back_at: now
      };
      record.active_deployment_id = operation.operation_id;
      record.status = "published";
      record.updated_at = now;
      record.last_rollback_operation = { ...operation, completed_at: now };
      delete record.rollback_operation;
      appendAudit(record, "release.rolled_back", operation.actor_id ?? creatorId, operation.reason, {
        operation_id: operation.operation_id,
        release_id: record.release.release_id,
        corpus_digest: record.release.corpus_digest
      }, this.clock());
      return record;
    });
  }

  async completeRollbackProduct(creatorId, productId, operationId) {
    await this.markRollbackRegistryActivated(creatorId, productId, operationId);
    return this.commitRollbackProduct(creatorId, productId, operationId);
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

  async publishProduct(creatorId, productId, input = {}) {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      assertPublishable(record, input);
      record.version += 1;
      record.release_revision = (record.release_revision ?? 0) + 1;
      record.release = {
        release_id: this.idFactory("release"),
        revision: record.release_revision,
        candidate_id: record.approval.candidate_id,
        corpus_digest: record.approval.candidate_digest,
        report_digest: record.approval.report_digest,
        current: true,
        published_at: this.clock().toISOString()
      };
      record.releases = (record.releases ?? []).map((release) => ({ ...release, current: false }));
      record.releases.push(clone(record.release));
      record.status = "published";
      record.public_url = `/products/${encodeURIComponent(productId)}`;
      record.published_at = record.release.published_at;
      record.updated_at = this.clock().toISOString();
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

  async #markDeploymentPhase(creatorId, productId, operationKey, operationId, phaseKey) {
    return this.#mutate((state) => {
      const record = creatorProductRecord(state, creatorId, productId);
      const operation = requireRecord(record[operationKey], "deployment_not_pending", "No deployment operation is pending.");
      if (operation.operation_id !== operationId) {
        throw stateError("deployment_operation_changed", "The deployment operation changed.", 409);
      }
      operation[phaseKey] ??= this.clock().toISOString();
      operation.last_error = null;
      record.updated_at = operation[phaseKey];
      return record;
    });
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
    factory_drafts: objectValue(value?.factory_drafts),
    web_sessions: objectValue(value?.web_sessions)
  };
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

function factoryDraftDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    task_name: String(value?.task_name ?? ""),
    task_brief: String(value?.task_brief ?? ""),
    sources: Array.isArray(value?.sources) ? value.sources : []
  })).digest("hex")}`;
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

function factoryDraftKey(creatorId, draftId) {
  return `${creatorId}:${draftId}`;
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

function validateDeploymentCommand(operation, action, commandKey, payload) {
  if (!operation || !commandKey || operation.command_key !== commandKey) return;
  // Deployment intents persisted before the V2 command digest migration must
  // remain resumable; every newly-created intent below stores the digest.
  if (!operation.payload_digest) return;
  if (operation.payload_digest !== portalCommandDigest(action, payload)) {
    throw stateError("idempotency_conflict", "This deployment command key was already used with a different payload.", 409);
  }
}

function publishCommandPayload(input) {
  return {
    candidate_id: input.candidate_id ?? null,
    expected_version: Number(input.expected_version),
    reason: String(input.reason ?? "creator_publish")
  };
}

function rollbackCommandPayload(releaseId, expectedVersion, input) {
  return {
    release_id: releaseId,
    expected_version: Number(expectedVersion),
    reason: String(input.reason ?? "")
  };
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

function assertPublishable(record, input) {
  assertExpectedVersion(record, input.expected_version);
  if (record.approval?.status !== "approved") {
    throw stateError("candidate_not_approved", "Approve the current candidate before publishing.", 409);
  }
  if (input.candidate_id && input.candidate_id !== record.approval.candidate_id) {
    throw stateError("candidate_changed", "The approved candidate changed. Review it again.", 409);
  }
}

function approvalMatchesCandidate(approval, candidate) {
  return Boolean(
    approval?.status === "approved"
    && candidate
    && approval.candidate_id === candidate.candidate_id
    && approval.candidate_digest === candidate.digest
    && approval.report_digest === candidate.report_digest
  );
}

async function atomicWriteJson(destination, value) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}
