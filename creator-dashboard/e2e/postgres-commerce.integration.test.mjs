import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  CommerceInvariantError,
  CommerceService,
  PostgresCommerceLedger
} from "../../packages/commerce/src/index.js";

const commerceDatabaseUrl = process.env.HATCH_TEST_COMMERCE_DATABASE_URL;
const runtimeDatabaseUrl = process.env.HATCH_TEST_RUNTIME_DATABASE_URL;

test("real Postgres harness refuses destructive resets outside an explicit test database", () => {
  assert.throws(
    () => assertSafeTestDatabaseUrl("postgresql://commerce@example.test/hatch_commerce"),
    /Refusing to reset non-test PostgreSQL database/
  );
});

test("real Postgres serializes writers and persists atomic outbox/inbox contracts", {
  skip: commerceDatabaseUrl ? false : "HATCH_TEST_COMMERCE_DATABASE_URL is required for the real Postgres integration test",
  timeout: 60_000
}, async () => {
  assertSafeTestDatabaseUrl(commerceDatabaseUrl);
  const admin = new pg.Pool({ connectionString: commerceDatabaseUrl, max: 2 });
  await resetCommerceSchema(admin);

  const firstLedger = await PostgresCommerceLedger.open({
    Pool: pg.Pool,
    connectionString: commerceDatabaseUrl,
    poolOptions: { max: 4 }
  });
  const secondLedger = await PostgresCommerceLedger.open({
    Pool: pg.Pool,
    connectionString: commerceDatabaseUrl,
    poolOptions: { max: 4 }
  });
  const first = new CommerceService(firstLedger);
  const second = new CommerceService(secondLedger);

  try {
    const [alpha, beta] = await Promise.all([
      first.confirmCheckout(checkout("alpha"), { idempotencyKey: "postgres:checkout:alpha" }),
      second.confirmCheckout(checkout("beta"), { idempotencyKey: "postgres:checkout:beta" })
    ]);
    assert.notEqual(alpha.order.order_id, beta.order.order_id);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM commerce_events")).rows[0].count, 4);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM commerce_outbox")).rows[0].count, 4);

    const replay = await second.confirmCheckout(checkout("alpha"), { idempotencyKey: "postgres:checkout:alpha" });
    assert.equal(replay.order.order_id, alpha.order.order_id);
    await assert.rejects(
      second.confirmCheckout({ ...checkout("alpha"), included_units: 2 }, { idempotencyKey: "postgres:checkout:alpha" }),
      (error) => error instanceof CommerceInvariantError && error.code === "idempotency_conflict"
    );

    await installFailingOutboxTrigger(admin);
    await assert.rejects(
      firstLedger.append("order.placed", {
        ...identity("rollback"),
        order_id: "order_rollback",
        gross_minor: 0,
        currency: "USD"
      }, { idempotencyKey: "postgres:rollback:order" }),
      /intentional Commerce outbox failure/
    );
    assert.equal((await admin.query(
      "SELECT count(*)::int AS count FROM commerce_events WHERE idempotency_key = 'postgres:rollback:order'"
    )).rows[0].count, 0);
    await removeFailingOutboxTrigger(admin);

    const delivered = [];
    const dispatch = (label) => async (_event, context) => {
      delivered.push(`${label}:${context.event_id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const reports = await Promise.all([
      firstLedger.dispatchOutbox(dispatch("first"), { limit: 2, leaseMs: 5_000 }),
      secondLedger.dispatchOutbox(dispatch("second"), { limit: 2, leaseMs: 5_000 })
    ]);
    assert.equal(reports.reduce((sum, report) => sum + report.dispatched, 0), 4);
    assert.equal(new Set(delivered.map((entry) => entry.split(":").slice(1).join(":"))).size, 4);
    assert.equal((await firstLedger.listPendingOutbox()).length, 0);

    const providerPayload = { provider_event_id: "evt_atomic_real_postgres", status: "succeeded" };
    const providerMutations = [{
      type: "order.placed",
      payload: {
        ...identity("provider-inbox"),
        order_id: "order_provider_inbox",
        gross_minor: 0,
        currency: "USD"
      },
      idempotencyKey: "postgres:provider-inbox:order"
    }];
    const atomicInbox = await firstLedger.appendManyFromInbox(
      "provider-webhook",
      "evt_atomic_real_postgres",
      providerPayload,
      providerMutations
    );
    assert.equal(atomicInbox.inserted, true);
    assert.equal(atomicInbox.events.length, 1);
    const atomicReplay = await secondLedger.appendManyFromInbox(
      "provider-webhook",
      "evt_atomic_real_postgres",
      providerPayload,
      providerMutations
    );
    assert.equal(atomicReplay.replay, true);
    assert.equal((await admin.query(
      "SELECT count(*)::int AS count FROM commerce_events WHERE idempotency_key = 'postgres:provider-inbox:order'"
    )).rows[0].count, 1);
    assert.equal((await admin.query(
      "SELECT count(*)::int AS count FROM commerce_outbox WHERE event_id = $1",
      [atomicInbox.events[0].event_id]
    )).rows[0].count, 1);
    assert.equal((await admin.query(
      "SELECT count(*)::int AS count FROM commerce_inbox WHERE consumer_name = 'provider-webhook' AND idempotency_key = 'evt_atomic_real_postgres'"
    )).rows[0].count, 1);

    const inboxPayload = { provider_event_id: "evt_real_postgres", status: "succeeded" };
    const [inboxA, inboxB] = await Promise.all([
      firstLedger.markInbox("provider-webhook", "evt_real_postgres", inboxPayload, { result: { accepted: true } }),
      secondLedger.markInbox("provider-webhook", "evt_real_postgres", inboxPayload, { result: { accepted: true } })
    ]);
    assert.equal([inboxA, inboxB].filter((entry) => entry.inserted).length, 1);
    assert.equal([inboxA, inboxB].filter((entry) => entry.replay).length, 1);
    await assert.rejects(
      firstLedger.markInbox("provider-webhook", "evt_real_postgres", { ...inboxPayload, status: "failed" }),
      (error) => error instanceof CommerceInvariantError && error.code === "inbox_idempotency_conflict"
    );

    if (runtimeDatabaseUrl) {
      const runtime = new pg.Pool({ connectionString: runtimeDatabaseUrl, max: 1 });
      try {
        await assert.rejects(
          runtime.query("SELECT count(*) FROM commerce_events"),
          (error) => error?.code === "42501"
        );
      } finally {
        await runtime.end();
      }
    }
  } finally {
    await removeFailingOutboxTrigger(admin).catch(() => undefined);
    await Promise.all([firstLedger.close(), secondLedger.close(), admin.end()]);
  }
});

function assertSafeTestDatabaseUrl(value) {
  const databaseName = decodeURIComponent(new URL(value).pathname.replace(/^\//, ""));
  assert.match(
    databaseName,
    /(?:^|[_-])test(?:$|[_-])/i,
    `Refusing to reset non-test PostgreSQL database ${databaseName || "<missing>"}`
  );
}

function checkout(suffix) {
  return {
    ...identity(suffix),
    release_id: `release_${suffix}`,
    offer_id: `offer_${suffix}`,
    offer_revision: 1,
    gross_minor: 0,
    currency: "USD",
    included_units: 1,
    version_policy: "pinned"
  };
}

function identity(suffix) {
  return {
    buyer_id: `buyer_${suffix}`,
    creator_id: "creator_postgres",
    agent_id: "agent_postgres",
    product_id: `product_${suffix}`,
    corpus_digest: `sha256:${suffix === "beta" ? "b".repeat(64) : "a".repeat(64)}`
  };
}

async function resetCommerceSchema(pool) {
  await pool.query("DROP TABLE IF EXISTS commerce_outbox, commerce_inbox, commerce_events CASCADE");
  await pool.query("DROP FUNCTION IF EXISTS hatch_test_fail_outbox() CASCADE");
}

async function installFailingOutboxTrigger(pool) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION hatch_test_fail_outbox() RETURNS trigger AS $$
    BEGIN
      IF NEW.payload->>'order_id' = 'order_rollback' THEN
        RAISE EXCEPTION 'intentional Commerce outbox failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER hatch_test_fail_outbox_trigger
      BEFORE INSERT ON commerce_outbox
      FOR EACH ROW EXECUTE FUNCTION hatch_test_fail_outbox();
  `);
}

async function removeFailingOutboxTrigger(pool) {
  await pool.query("DROP TRIGGER IF EXISTS hatch_test_fail_outbox_trigger ON commerce_outbox");
  await pool.query("DROP FUNCTION IF EXISTS hatch_test_fail_outbox()");
}
