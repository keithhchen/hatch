import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { CommerceLedger } from "../../packages/commerce/src/ledger.js";
import { PostgresCommerceLedger } from "../../packages/commerce/src/postgresLedger.js";
import { objectStoreFromEnvironment } from "../dist/creatorLearning/objectStore.js";
import { prepareProductCreatorTransferRelease } from "../dist/creatorLearning/corpusPublisher.js";

const EXPECTED = {
  productId: "802f2105-e28e-4ddc-996a-0a97a7fa4bb5",
  sourceEmail: "ikeithchen@me.com",
  sourceCreatorId: "235a177f-a237-4823-b178-70a7abbbc6d8",
  targetEmail: "tina@gethatchapp.com",
  targetCreatorId: "58767785-197f-4208-a52f-2590b13b807c",
  factorySessionIds: [
    "61435093-6665-4d33-ab28-ef5749d5e179",
    "c7f24b91-f731-4f00-8958-c969f45c4842"
  ],
  orderIds: [
    "ea99dbe2-bd9a-4218-ad71-84f87614fd14",
    "456b44d0-e147-4658-923b-5ba70ed41814"
  ],
  entitlementIds: [
    "edee3c33-c014-41d4-b1b2-4eb8ce69df2c",
    "6b7c5a19-63d1-4c24-bba5-d69a3241e04e"
  ]
};

const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_for_tool", "compacting"];
const MIGRATION_TABLE = "hatch_creator_product_transfers";

async function main() {
  const { productId, targetEmail, checkOnly, transferAccountConnections } = parseArguments(process.argv.slice(2));
  if (productId !== EXPECTED.productId || targetEmail !== EXPECTED.targetEmail) {
    throw new Error("This audited transfer command accepts only the reviewed Product and target Creator account.");
  }
  const databaseUrl = process.env.HATCH_REGISTRY_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("HATCH_REGISTRY_DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const objectStore = objectStoreFromEnvironment(process.env);
  if (!objectStore) throw new Error("Production Creator object storage is unavailable");
  const factoryRoot = path.resolve(process.env.HATCH_CREATOR_FACTORY_ROOT ?? "creator-factory-runs");
  const runtimeRoot = path.resolve(process.env.HATCH_RUNTIME_CORPUS_ROOT ?? "runtime-corpora");
  const corpusRoot = path.resolve(process.env.HATCH_AGENT_CORPUS_ROOT ?? runtimeRoot);

  try {
    const operation = await findOperation(pool, productId);
    if (operation?.phase === "complete") {
      await verifyFinalState(pool, objectStore, operation, factoryRoot);
      output({ status: "already_complete", product_id: productId, creator_email: targetEmail });
      return;
    }
    if (operation?.phase === "database_committed") {
      await finishFactoryMove(operation, factoryRoot);
      await refreshCommerceViews(pool);
      await verifyFinalState(pool, objectStore, operation, factoryRoot);
      await pool.query(`UPDATE ${MIGRATION_TABLE} SET phase='complete', updated_at=NOW() WHERE product_id=$1`, [productId]);
      output({ status: "recovered_and_complete", product_id: productId, creator_email: targetEmail });
      return;
    }

    const before = await inspectInitialState(pool, objectStore, factoryRoot);
    const connectionPlan = planConnectionTransfer(before, transferAccountConnections);
    if (checkOnly) {
      output({ status: connectionPlan.blockers.length ? "preflight_blocked" : "preflight_passed", ...publicSummary(before, connectionPlan) });
      return;
    }
    if (connectionPlan.blockers.length) {
      output({ status: "blocked_before_write", blockers: connectionPlan.blockers });
      process.exitCode = 2;
      return;
    }
    const preparedRelease = await prepareProductCreatorTransferRelease({
      creatorId: before.target.id,
      creatorName: before.target.display_name,
      productId,
      productName: before.product.name,
      productPromise: before.product.promise,
      currentRelease: before.currentRelease,
      objectStore,
      corpusRoot,
      runtimeRoot
    });

    const manifest = before.factoryManifest;
    const counts = publicSummary(before, connectionPlan);
    const runtimeMapping = before.conversations.map((row) => ({
      old_id: String(row.id),
      new_id: durableConversationId(before.target.id, row.owner_account_id, productId, row.public_id),
      public_id: row.public_id,
      owner_account_id: row.owner_account_id
    }));
    await commitDatabaseTransfer(pool, {
      productId,
      sourceCreatorId: before.source.id,
      targetCreatorId: before.target.id,
      targetCreatorName: before.target.display_name,
      preparedRelease,
      expectedCurrentReleaseDigest: before.currentRelease.release_digest,
      commerceEventIds: before.commerceEventIds,
      runtimeMapping,
      factoryManifest: manifest,
      corpusTools: before.corpusTools,
      connectionTransferManifest: connectionPlan.connections_to_transfer,
      counts,
      objectStore
    });

    const committedOperation = await findOperation(pool, productId);
    if (!committedOperation) throw new Error("Transfer commit record is missing after commit");
    await finishFactoryMove(committedOperation, factoryRoot);
    await refreshCommerceViews(pool);
    await verifyFinalState(pool, objectStore, committedOperation, factoryRoot);
    await pool.query(`UPDATE ${MIGRATION_TABLE} SET phase='complete', updated_at=NOW() WHERE product_id=$1`, [productId]);
    output({
      status: "complete",
      product_id: productId,
      source_creator_id: before.source.id,
      target_creator_id: before.target.id,
      release_digest: preparedRelease.release_digest,
      ...counts
    });
  } finally {
    await pool.end();
  }
}

function parseArguments(args) {
  if (args.length < 2) throw new Error("Product ID and target email are required");
  const productId = String(args[0]).trim().toLowerCase();
  const targetEmail = String(args[1]).trim().toLowerCase();
  const options = args.slice(2);
  if (options.some((option) => !["--check", "--transfer-account-connections"].includes(option))) {
    throw new Error("Supported options are --check and --transfer-account-connections");
  }
  if (new Set(options).size !== options.length) throw new Error("Transfer options must be unique");
  if (!/^[0-9a-f-]{36}$/.test(productId)) throw new Error("Product ID must be a UUID");
  if (!targetEmail.includes("@")) throw new Error("Target email is invalid");
  return {
    productId,
    targetEmail,
    checkOnly: options.includes("--check"),
    transferAccountConnections: options.includes("--transfer-account-connections")
  };
}

function planConnectionTransfer(state, transferAccountConnections) {
  const candidates = state.corpusTools.connections.filter((connection) => (
    connection.owner_id === state.source.id && connection.status === "active"
  ));
  const dependenciesByConnection = new Map();
  for (const dependency of state.corpusTools.connection_dependents) {
    for (const connectionId of dependency.connection_ids) {
      const products = dependenciesByConnection.get(connectionId) ?? [];
      products.push(dependency);
      dependenciesByConnection.set(connectionId, products);
    }
  }
  const blockers = state.corpusTools.connections.flatMap((connection) => {
    if (connection.owner_id === state.target.id && connection.status === "active") return [];
    if (connection.owner_id === state.source.id && connection.status === "active") {
      if (!transferAccountConnections) {
        return [{ id: connection.id, owner_email: connection.owner_email, reason: "explicit_account_connection_transfer_required" }];
      }
      const dependentProducts = dependenciesByConnection.get(connection.id) ?? [];
      if (dependentProducts.length > 0) {
        return [{ id: connection.id, owner_email: connection.owner_email, reason: "other_live_products_use_connection", product_ids: dependentProducts.map((product) => product.product_id) }];
      }
      return [];
    }
    return [{ id: connection.id, owner_email: connection.owner_email, reason: connection.status === "active" ? "unsupported_connection_owner" : "connection_not_active" }];
  });
  const connectionsToTransfer = transferAccountConnections && blockers.length === 0
    ? candidates.map((connection) => ({
      id: connection.id,
      source_creator_id: state.source.id,
      target_creator_id: state.target.id,
      kind: connection.kind,
      status: connection.status
    }))
    : [];
  return {
    authorized: transferAccountConnections,
    candidates: candidates.map(({ id, owner_email, kind, status }) => ({ id, owner_email, kind, status })),
    connections_to_transfer: connectionsToTransfer,
    blockers
  };
}

async function inspectInitialState(pool, objectStore, factoryRoot) {
  const productResult = await pool.query(
    `SELECT id, creator_id, name, promise, status, idempotency_key, run_id, latest_revision_id
       FROM hatch_creator_products WHERE id=$1`,
    [EXPECTED.productId]
  );
  requireCount(productResult.rows.length, 1, "Product row");
  const product = productResult.rows[0];
  requireEqual(product.creator_id, EXPECTED.sourceCreatorId, "Product current Creator");
  requireEqual(product.status, "active", "Product status");
  const accounts = await pool.query(
    `SELECT id, email, role, display_name FROM accounts WHERE email = ANY($1::text[])`,
    [[EXPECTED.sourceEmail, EXPECTED.targetEmail]]
  );
  const byEmail = new Map(accounts.rows.map((row) => [String(row.email).toLowerCase(), row]));
  const source = byEmail.get(EXPECTED.sourceEmail);
  const target = byEmail.get(EXPECTED.targetEmail);
  require(Boolean(source), "Source Creator account is missing");
  require(Boolean(target), "Target Creator account is missing");
  requireEqual(source.id, EXPECTED.sourceCreatorId, "Source Creator account ID");
  requireEqual(target.id, EXPECTED.targetCreatorId, "Target Creator account ID");
  requireEqual(source.role, "creator", "Source account role");
  requireEqual(target.role, "creator", "Target account role");
  requireEqual(target.display_name, "Tina", "Target Creator display name");

  const conflict = await pool.query(
    `SELECT count(*)::int AS count FROM hatch_creator_products
      WHERE creator_id=$1 AND idempotency_key=$2 AND id<>$3`,
    [target.id, product.idempotency_key, product.id]
  );
  requireCount(Number(conflict.rows[0].count), 0, "Target idempotency-key conflict");

  const releaseRows = await pool.query(
    `SELECT product_id, creator_id, release_digest, corpus_digest, corpus_ref, release_ref,
            runtime_manifest_ref, brief_spec, status, published_at
       FROM hatch_creator_registry_releases WHERE product_id=$1 ORDER BY published_at, release_digest`,
    [product.id]
  );
  requireCount(releaseRows.rows.length, 9, "Historical Registry release rows");
  require(releaseRows.rows.every((row) => row.creator_id === source.id && row.status === "published"), "Historical Registry release ownership or status differs from the reviewed audit");
  const liveResult = await pool.query(
    `SELECT live.product_id, live.creator_id, live.release_digest, release.corpus_digest, release.corpus_ref,
            release.release_ref, release.runtime_manifest_ref, release.brief_spec,
            release.status, release.published_at
       FROM hatch_creator_registry_live AS live
       JOIN hatch_creator_registry_releases AS release
         ON release.product_id=live.product_id AND release.release_digest=live.release_digest
      WHERE live.product_id=$1`,
    [product.id]
  );
  requireCount(liveResult.rows.length, 1, "Current Registry release pointer");
  requireEqual(liveResult.rows[0].creator_id, source.id, "Current Registry Creator");
  requireEqual(liveResult.rows[0].status, "published", "Current Registry release status");
  const currentRelease = { product_id: product.id, creator_id: source.id, ...releaseRows.rows.find((row) => row.release_digest === liveResult.rows[0].release_digest) };
  require(Boolean(currentRelease.corpus_ref), "Current immutable Registry release row is missing");
  const corpusTools = await inspectCorpusToolReferences(pool, objectStore, currentRelease, source.id, target.id);

  const commerce = await pool.query(
    `SELECT sequence, event_id, event_type, occurred_at, idempotency_key, payload_digest, payload
       FROM commerce_events WHERE payload->>'product_id'=$1 ORDER BY sequence`,
    [product.id]
  );
  requireCount(commerce.rows.length, 4, "Product Commerce events");
  requireEqual(sorted(commerce.rows.map((row) => row.event_type)), sorted(["order.placed", "order.placed", "entitlement.granted", "entitlement.granted"]), "Commerce event types");
  const commerceEventIds = commerce.rows.map((row) => row.event_id);
  require(commerce.rows.every((row) => row.payload.creator_id === source.id && row.payload.tenant_id === source.id), "Commerce Creator identity differs from the source account");
  const orderIds = commerce.rows.filter((row) => row.event_type === "order.placed").map((row) => row.payload.order_id);
  const entitlementIds = commerce.rows.filter((row) => row.event_type === "entitlement.granted").map((row) => row.payload.entitlement_id);
  requireEqual(sorted(orderIds), sorted(EXPECTED.orderIds), "Product order IDs");
  requireEqual(sorted(entitlementIds), sorted(EXPECTED.entitlementIds), "Product entitlement IDs");
  const outbox = await pool.query(
    `SELECT event_id, attempts, dispatched_at, locked_at, last_error
       FROM commerce_outbox WHERE event_id = ANY($1::text[]) ORDER BY event_id`,
    [commerceEventIds]
  );
  requireCount(outbox.rows.length, 4, "Commerce outbox rows");
  require(outbox.rows.every((row) => row.dispatched_at && !row.locked_at && !row.last_error), "Commerce outbox has an undispatched or errored row");
  const financial = await pool.query(
    `SELECT count(*)::int AS count FROM commerce_events
      WHERE payload->>'product_id'=$1 AND (event_type LIKE 'payment.%' OR event_type LIKE 'revenue.%' OR event_type LIKE 'payout.%')`,
    [product.id]
  );
  requireCount(Number(financial.rows[0].count), 0, "Product financial events");
  const inbox = await pool.query(
    `SELECT count(*)::int AS count FROM commerce_inbox WHERE payload->>'product_id'=$1`,
    [product.id]
  );
  requireCount(Number(inbox.rows[0].count), 0, "Product Commerce inbox records");

  const portalRow = await pool.query("SELECT state FROM portal_workflow_state WHERE singleton=TRUE");
  requireCount(portalRow.rows.length, 1, "Portal workflow state row");
  const portalState = portalRow.rows[0].state;
  const portal = inspectCheckoutSessions(portalState, product.id, source.id);
  const portalCreatorProduct = inspectPortalCreatorProduct(portalState, product.id, source.id, target.id);
  requireEqual(portal.count, 3, "Product checkout sessions");
  requireEqual(portal.statuses, { completed: 2, open: 1 }, "Checkout statuses");
  requireEqual(sorted(portal.ids), sorted([
    "checkout_183e2b1f909e4b719bf36c4e801824ff",
    "checkout_ba3393a493eb49b99a319d02a8464287",
    "checkout_ef05c20f950b49088f6c6005d7406ee4"
  ]), "Checkout session IDs");

  const conversations = await pool.query(
    `SELECT id, public_id, owner_account_id, creator_id, agent_id, product_id, corpus_digest,
            product_id_at_creation, client_request_id
       FROM hatch_conversations WHERE creator_id=$1 AND product_id=$2 ORDER BY id`,
    [source.id, product.id]
  );
  requireCount(conversations.rows.length, 45, "Runtime conversations");
  require(conversations.rows.every((row) => row.agent_id === product.id && row.product_id_at_creation === product.id), "A Runtime conversation has a different Product binding");
  const oldIds = conversations.rows.map((row) => String(row.id));
  const newIds = conversations.rows.map((row) => durableConversationId(target.id, row.owner_account_id, product.id, row.public_id));
  requireEqual(new Set(newIds).size, 45, "Recomputed Runtime conversation IDs");
  const collisions = await pool.query("SELECT count(*)::int AS count FROM hatch_conversations WHERE id = ANY($1::text[])", [newIds]);
  requireCount(Number(collisions.rows[0].count), 0, "Runtime conversation ID collisions");
  const clientRequestCollisions = await pool.query(
    `SELECT count(*)::int AS count FROM hatch_conversations old
      JOIN hatch_conversations existing
        ON existing.owner_account_id=old.owner_account_id AND existing.creator_id=$1
       AND existing.agent_id=old.agent_id AND existing.client_request_id=old.client_request_id
     WHERE old.id=ANY($2::text[]) AND old.client_request_id IS NOT NULL`,
    [target.id, oldIds]
  );
  requireCount(Number(clientRequestCollisions.rows[0].count), 0, "Runtime conversation idempotency collisions");
  const [runSummary, journalCount, eventCount, usageCount, activeRuns] = await Promise.all([
    pool.query(`SELECT COALESCE(sum(status_count),0)::int AS count, jsonb_object_agg(status, status_count) AS statuses
      FROM (SELECT status, count(*)::int AS status_count FROM hatch_conversation_runs WHERE conversation_id=ANY($1::text[]) GROUP BY status) runs`, [oldIds]),
    pool.query("SELECT count(*)::int AS count FROM hatch_conversation_journal WHERE conversation_id=ANY($1::text[])", [oldIds]),
    pool.query("SELECT count(*)::int AS count FROM hatch_conversation_events WHERE conversation_id=ANY($1::text[])", [oldIds]),
    pool.query("SELECT count(*)::int AS count FROM hatch_conversation_usage WHERE scope_key=ANY($1::text[])", [oldIds.map((id) => `conversation:${id}`)]),
    pool.query(`SELECT count(*)::int AS count FROM hatch_conversation_runs
      WHERE conversation_id=ANY($1::text[]) AND status=ANY($2::text[])`, [oldIds, ACTIVE_RUN_STATUSES])
  ]);
  requireCount(Number(runSummary.rows[0].count), 106, "Runtime runs");
  requireEqual(Number(journalCount.rows[0].count), 744, "Runtime journal rows");
  requireEqual(Number(eventCount.rows[0].count), 6773, "Runtime conversation event rows");
  requireEqual(Number(usageCount.rows[0].count), 39, "Runtime conversation usage rows");
  requireCount(Number(activeRuns.rows[0].count), 0, "Active Runtime runs");

  const distillation = await pool.query("SELECT id, creator_id FROM hatch_creator_distillation_runs WHERE product_id=$1", [product.id]);
  requireCount(distillation.rows.length, 1, "Product Distillation run");
  requireEqual(distillation.rows[0].creator_id, source.id, "Distillation Creator");
  const distillationEvents = await pool.query("SELECT id, type FROM hatch_creator_distillation_events WHERE product_id=$1 ORDER BY sequence", [product.id]);
  requireEqual(distillationEvents.rows.length, 1, "Product Distillation events");
  requireEqual(distillationEvents.rows[0].type, "product_created", "Historical Distillation event");
  const graphCounts = await countProductRows(pool, [
    "hatch_creator_distillation_artifacts", "hatch_creator_distillation_revisions",
    "hatch_creator_distillation_node_executions", "hatch_creator_quality_gate_assessments",
    "hatch_creator_distillation_releases"
  ], product.id);
  require(Object.values(graphCounts).every((count) => count === 0), "Product Distillation graph has additional records that require review");

  const factoryRuns = await pool.query(
    "SELECT count(*)::int AS count FROM hatch_creator_factory_runs WHERE input_jsonb::text LIKE $1",
    [`%${product.id}%`]
  );
  requireCount(Number(factoryRuns.rows[0].count), 0, "Product Factory run rows");
  const legacyCounts = await countLegacyProductRows(pool, product.id);
  require(Object.values(legacyCounts).every((count) => count === 0), "Legacy Product authority rows exist");

  const productFilesPrefix = `${process.env.HATCH_CREATOR_PRODUCT_FILES_PREFIX?.trim() || "creator-products"}/${source.id}/${product.id}`;
  const targetProductFilesPrefix = `${process.env.HATCH_CREATOR_PRODUCT_FILES_PREFIX?.trim() || "creator-products"}/${target.id}/${product.id}`;
  const [sourceProductFiles, targetProductFiles] = await Promise.all([
    objectStore.list(productFilesPrefix), objectStore.list(targetProductFilesPrefix)
  ]);
  requireCount(sourceProductFiles.length, 0, "Source Product File objects");
  requireCount(targetProductFiles.length, 0, "Target Product File objects");

  const factoryManifest = await readFactoryManifest(factoryRoot, source.id, product.id, EXPECTED.factorySessionIds);
  const targetFactoryPath = path.join(factoryRoot, "agent-chats", target.id, product.id);
  require(!(await pathExists(targetFactoryPath)), "Target Factory Product directory already exists");
  requireEqual(factoryManifest.sessions.length, 2, "Product Factory chat sessions");
  require(factoryManifest.sessions.every((session) => session.status !== "running"), "A Product Factory chat session is running");

  const foreignBindings = await countProductRows(pool, ["agent_access", "agent_corpora", "agent_corpus_release_briefs", "agent_tool_bindings", "products"], product.id);
  require(Object.values(foreignBindings).every((count) => count === 0), "A legacy product authority row exists");
  return { product, source, target, currentRelease: currentReleaseFields(liveResult.rows[0], product.id), releaseCount: releaseRows.rows.length,
    commerce: commerce.rows, commerceEventIds, outbox: outbox.rows,
    corpusTools,
    portal: { checkout_sessions: portal.public, creator_product: portalCreatorProduct.public },
    portalCreatorProduct,
    conversations: conversations.rows,
    runtime: { runs: Number(runSummary.rows[0].count), journal: Number(journalCount.rows[0].count), events: Number(eventCount.rows[0].count), usage: Number(usageCount.rows[0].count) },
    distillationRunId: distillation.rows[0].id, factoryManifest, legacyCounts, foreignBindings,
    productFileCount: sourceProductFiles.length + targetProductFiles.length };
}

async function inspectCorpusToolReferences(pool, objectStore, currentRelease, sourceCreatorId, targetCreatorId) {
  const bytes = await objectStore.get(currentRelease.corpus_ref);
  requireEqual(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, currentRelease.corpus_digest, "Current Corpus object digest");
  const corpus = JSON.parse(bytes.toString("utf8"));
  require(Array.isArray(corpus.tools), "Published Corpus tool declaration list is invalid");
  const connectionIds = [...new Set(corpus.tools.map((tool) => tool.connection_ref).filter((value) => typeof value === "string" && value.length > 0))];
  const [connectionsResult, accountsResult] = await Promise.all([
    connectionIds.length
      ? pool.query("SELECT id, tenant_id, kind, status FROM tool_connections WHERE id=ANY($1::text[])", [connectionIds])
      : Promise.resolve({ rows: [] }),
    pool.query("SELECT id, email FROM accounts WHERE id=ANY($1::uuid[])", [[sourceCreatorId, targetCreatorId]])
  ]);
  const connections = new Map(connectionsResult.rows.map((row) => [row.id, row]));
  const emails = new Map(accountsResult.rows.map((row) => [row.id, row.email]));
  const dependentProducts = await pool.query(
    `SELECT live.product_id, product.name AS product_name, live.creator_id, account.email AS creator_email, release.corpus_ref
       FROM hatch_creator_registry_live live
       JOIN hatch_creator_registry_releases release
         ON release.product_id::text=live.product_id::text AND release.release_digest=live.release_digest
       JOIN hatch_creator_products product ON product.id::text=live.product_id::text
       JOIN accounts account ON account.id::text=live.creator_id::text
      WHERE live.creator_id::text=$1::text AND live.product_id::text<>$2::text ORDER BY live.product_id`,
    [sourceCreatorId, currentRelease.product_id]
  );
  const connectionDependents = [];
  for (const row of dependentProducts.rows) {
    const dependentBytes = await objectStore.get(row.corpus_ref);
    const dependentCorpus = JSON.parse(dependentBytes.toString("utf8"));
    require(Array.isArray(dependentCorpus.tools), `Published Corpus tool declarations are invalid for Product ${row.product_id}`);
    const toolIds = dependentCorpus.tools
      .filter((tool) => connectionIds.includes(tool.connection_ref))
      .map((tool) => tool.id);
    if (toolIds.length > 0) {
      connectionDependents.push({
        product_id: row.product_id,
        product_name: row.product_name,
        creator_id: row.creator_id,
        creator_email: row.creator_email,
        connection_ids: [...new Set(dependentCorpus.tools
          .filter((tool) => connectionIds.includes(tool.connection_ref))
          .map((tool) => tool.connection_ref))],
        tool_ids: toolIds
      });
    }
  }
  const referencedConnections = connectionIds.map((id) => {
    const connection = connections.get(id);
    return {
      id,
      owner_id: connection?.tenant_id ?? null,
      owner_email: connection ? emails.get(connection.tenant_id) ?? "another account" : null,
      kind: connection?.kind ?? null,
      status: connection?.status ?? "missing",
      target_owned: connection?.tenant_id === targetCreatorId
    };
  });
  const blockers = referencedConnections.filter((connection) => !connection.target_owned || connection.status !== "active");
  return {
    declarations: corpus.tools.map((tool) => ({ id: tool.id, kind: tool.kind, connection_ref: tool.connection_ref ?? null })),
    connections: referencedConnections,
    connection_dependents: connectionDependents,
    blockers
  };
}

function currentReleaseFields(row, productId) {
  return {
    product_id: productId,
    creator_id: String(row.creator_id),
    release_digest: String(row.release_digest),
    corpus_digest: String(row.corpus_digest),
    corpus_ref: String(row.corpus_ref),
    release_ref: String(row.release_ref),
    runtime_manifest_ref: String(row.runtime_manifest_ref),
    brief_spec: row.brief_spec ?? null,
    status: String(row.status),
    published_at: new Date(row.published_at).toISOString()
  };
}

function inspectCheckoutSessions(state, productId, sourceCreatorId) {
  const sessions = state?.checkout_sessions;
  require(sessions && typeof sessions === "object" && !Array.isArray(sessions), "Portal checkout session state is invalid");
  const matches = Object.entries(sessions).filter(([, session]) => session?.product?.product_id === productId);
  require(matches.every(([, session]) => session.creator?.id === sourceCreatorId), "A Product checkout Creator binding differs from the source account");
  const statuses = {};
  for (const [, session] of matches) statuses[session.status] = (statuses[session.status] ?? 0) + 1;
  return { count: matches.length, statuses, ids: matches.map(([id]) => id), public: { count: matches.length, statuses, ids: matches.map(([id]) => id) } };
}

function inspectPortalCreatorProduct(state, productId, sourceCreatorId, targetCreatorId) {
  const records = state?.creator_products;
  require(records && typeof records === "object" && !Array.isArray(records), "Portal Creator Product state is invalid");
  const matching = Object.entries(records).filter(([key, record]) => record?.product_id === productId || key.endsWith(`:${productId}`));
  const source = matching.filter(([, record]) => record?.creator_id === sourceCreatorId);
  const target = matching.filter(([, record]) => record?.creator_id === targetCreatorId);
  requireEqual(source.length + target.length, matching.length, "Portal Creator Product ownership");
  require(source.length <= 1, "Multiple source Portal Creator Product records match the Product");
  requireCount(target.length, 0, "Target Portal Creator Product record");
  if (source.length === 0) {
    return {
      key: null,
      status: null,
      version: null,
      release_count: 0,
      current_release_id: null,
      current_corpus_digest: null,
      public: { count: 0, status: null, version: null, release_count: 0, current_release_id: null, current_corpus_digest: null }
    };
  }
  const [key, record] = source[0];
  requireEqual(key, `${sourceCreatorId}:${productId}`, "Portal Creator Product key");
  const openOperations = [record.publish_operation, record.rollback_operation].filter((operation) => operation && !operation.completed_at && !operation.reconciled_at);
  requireCount(openOperations.length, 0, "Pending Portal deployment operations");
  return {
    key,
    status: record.status,
    version: record.version,
    release_count: Array.isArray(record.releases) ? record.releases.length : record.release ? 1 : 0,
    current_release_id: record.release?.release_id ?? null,
    current_corpus_digest: record.release?.corpus_digest ?? null,
    public: {
      count: matching.length,
      status: record.status,
      version: record.version,
      release_count: Array.isArray(record.releases) ? record.releases.length : record.release ? 1 : 0,
      current_release_id: record.release?.release_id ?? null,
      current_corpus_digest: record.release?.corpus_digest ?? null
    }
  };
}

async function readFactoryManifest(factoryRoot, creatorId, productId, expectedIds) {
  const productRoot = path.join(factoryRoot, "agent-chats", creatorId, productId);
  const entries = await readdir(productRoot, { withFileTypes: true });
  require(entries.every((entry) => entry.isDirectory()), "Factory Product directory contains a non-directory entry");
  const ids = entries.map((entry) => entry.name);
  requireEqual(sorted(ids), sorted([...expectedIds, "manual"]), "Factory Product directory IDs");
  const sessions = [];
  for (const sessionId of expectedIds) {
    const directory = path.join(productRoot, sessionId);
    const raw = await readFile(path.join(directory, "session.json"), "utf8");
    const session = JSON.parse(raw);
    requireEqual(session.id, sessionId, "Factory session metadata ID");
    require(["research", "generation"].includes(session.role), "Factory session role differs from the reviewed audit");
    require(session.status !== "running", "A Factory session is running");
    sessions.push({
      id: sessionId,
      status: session.status,
      revision: session.revision,
      role: session.role,
      recordFileCount: Array.isArray(session.files) ? session.files.length : 0,
      files: await hashDirectory(directory)
    });
  }
  requireEqual(sessions.find((item) => item.id === EXPECTED.factorySessionIds[0])?.status, "interrupted", "Factory research session status");
  requireEqual(sessions.find((item) => item.id === EXPECTED.factorySessionIds[1])?.status, "completed", "Factory generation session status");
  requireEqual(sessions.find((item) => item.id === EXPECTED.factorySessionIds[0])?.recordFileCount, 1, "Factory research file records");
  requireEqual(sessions.find((item) => item.id === EXPECTED.factorySessionIds[1])?.recordFileCount, 2, "Factory generation file records");
  const manualFiles = await hashDirectory(path.join(productRoot, "manual"));
  require(manualFiles.length > 0, "Factory Product manual directory is empty");
  return { sessions, manual: { files: manualFiles } };
}

async function hashDirectory(directory) {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const child of await hashDirectory(fullPath)) rows.push({ path: `${entry.name}/${child.path}`, bytes: child.bytes, sha256: child.sha256 });
    } else if (entry.isFile()) {
      const bytes = await readFile(fullPath);
      rows.push({ path: entry.name, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    } else {
      throw new Error("Factory Product directory contains a non-file entry");
    }
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

async function directoryNames(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function pathExists(value) {
  try { await access(value); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function countProductRows(pool, tables, productId) {
  const result = {};
  for (const table of tables) {
    const tableName = await pool.query("SELECT to_regclass($1) AS name", [table]);
    if (!tableName.rows[0].name) { result[table] = 0; continue; }
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1", [table]);
    const available = new Set(columns.rows.map((row) => row.column_name));
    const keys = ["product_id", "agent_id"].filter((column) => available.has(column));
    if (keys.length === 0) { result[table] = 0; continue; }
    const predicate = keys.map((column) => `"${column}"::text=$1`).join(" OR ");
    const count = await pool.query(`SELECT count(*)::int AS count FROM "${table}" WHERE ${predicate}`, [productId]);
    result[table] = Number(count.rows[0].count);
  }
  return result;
}

async function countLegacyProductRows(pool, productId) {
  return countProductRows(pool, ["products", "agent_corpora", "agent_access", "agent_corpus_release_briefs", "agent_tool_bindings"], productId);
}

function publicSummary(state, connectionPlan) {
  return {
    product_name: state.product.name,
    product_status: state.product.status,
    source_creator: { id: state.source.id, email: state.source.email, display_name: state.source.display_name },
    target_creator: { id: state.target.id, email: state.target.email, display_name: state.target.display_name },
    published_release_count: state.releaseCount,
    creator_tool_declarations: state.corpusTools.declarations,
    creator_tool_connections: state.corpusTools.connections,
    creator_tool_connection_dependents: state.corpusTools.connection_dependents,
    account_connection_transfer: {
      authorized: connectionPlan.authorized,
      candidates: connectionPlan.candidates,
      connections_to_transfer: connectionPlan.connections_to_transfer
    },
    commerce_event_count: state.commerce.length,
    commerce_event_ids: state.commerceEventIds,
    order_ids: state.commerce.filter((row) => row.event_type === "order.placed").map((row) => row.payload.order_id).sort(),
    entitlement_ids: state.commerce.filter((row) => row.event_type === "entitlement.granted").map((row) => row.payload.entitlement_id).sort(),
    checkout_sessions: state.portal,
    portal_creator_product: state.portalCreatorProduct.public,
    runtime: { conversation_count: state.conversations.length, ...state.runtime },
    distillation_run_id: state.distillationRunId,
    factory_sessions: state.factoryManifest.sessions.map(({ id, role, status, revision, recordFileCount }) => ({ id, role, status, revision, file_records: recordFileCount })),
    factory_manual_files: state.factoryManifest.manual.files.map(({ path: filePath, bytes }) => ({ path: filePath, bytes })),
    product_file_object_count: state.productFileCount,
    legacy_product_rows: state.legacyCounts
  };
}

async function commitDatabaseTransfer(pool, input) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(1849721043)");
    await client.query("SELECT pg_advisory_xact_lock(1849721044)");
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      product_id TEXT PRIMARY KEY,
      source_creator_id TEXT NOT NULL,
      target_creator_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('database_committed','complete')),
      old_release_digest TEXT NOT NULL,
      new_release_digest TEXT NOT NULL,
      factory_manifest JSONB NOT NULL,
      connection_manifest JSONB NOT NULL,
      runtime_mapping JSONB NOT NULL,
      audit_counts JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const already = await client.query(`SELECT phase FROM ${MIGRATION_TABLE} WHERE product_id=$1 FOR UPDATE`, [input.productId]);
    requireCount(already.rows.length, 0, "Existing transfer operation");
    await client.query(`LOCK TABLE hatch_creator_products, hatch_creator_registry_releases, hatch_creator_registry_live,
      commerce_events, commerce_outbox, commerce_read_model_state, portal_workflow_state,
      hatch_conversations, hatch_conversation_runs, hatch_conversation_journal,
      hatch_conversation_events, hatch_conversation_usage, hatch_creator_distillation_runs
      IN ACCESS EXCLUSIVE MODE`);
    const reread = await client.query("SELECT creator_id FROM hatch_creator_products WHERE id=$1", [input.productId]);
    requireCount(reread.rows.length, 1, "Locked Product row");
    requireEqual(reread.rows[0].creator_id, input.sourceCreatorId, "Locked Product Creator");
    const live = await client.query("SELECT creator_id, release_digest FROM hatch_creator_registry_live WHERE product_id=$1", [input.productId]);
    requireCount(live.rows.length, 1, "Locked Registry live pointer");
    requireEqual(live.rows[0].creator_id, input.sourceCreatorId, "Locked Registry Creator");
    requireEqual(live.rows[0].release_digest, input.expectedCurrentReleaseDigest, "Locked Registry current release");
    const currentRelease = await client.query(
      `SELECT product_id, corpus_ref, corpus_digest FROM hatch_creator_registry_releases
        WHERE product_id=$1 AND release_digest=$2`,
      [input.productId, input.expectedCurrentReleaseDigest]
    );
    requireCount(currentRelease.rows.length, 1, "Locked Registry immutable release");
    const corpusTools = await inspectCorpusToolReferences(
      client,
      input.objectStore,
      currentRelease.rows[0],
      input.sourceCreatorId,
      input.targetCreatorId
    );
    requireEqual(corpusTools, input.corpusTools, "Locked Creator tool connection dependency state");
    const accounts = await client.query("SELECT id, role FROM accounts WHERE id=ANY($1::uuid[]) FOR SHARE", [[input.sourceCreatorId, input.targetCreatorId]]);
    requireCount(accounts.rows.length, 2, "Locked source and target Creator accounts");
    require(accounts.rows.every((row) => row.role === "creator"), "Locked Creator account role changed");

    const currentCommerce = await client.query(
      `SELECT sequence, event_id, event_type, occurred_at, idempotency_key, payload_digest, payload
         FROM commerce_events WHERE payload->>'product_id'=$1 ORDER BY sequence`, [input.productId]
    );
    requireEqual(currentCommerce.rows.length, 4, "Locked Commerce event count");
    requireEqual(sorted(currentCommerce.rows.map((row) => row.event_id)), sorted(input.commerceEventIds), "Locked Commerce event IDs");
    const connectionIdsToTransfer = input.connectionTransferManifest.map((connection) => connection.id);
    const transferIds = new Set(connectionIdsToTransfer);
    const unresolvedConnections = corpusTools.connections.filter((connection) => (
      connection.owner_id !== input.targetCreatorId || connection.status !== "active"
    ) && !transferIds.has(connection.id));
    requireCount(unresolvedConnections.length, 0, "Unresolved current Product tool connections");
    const externalDependents = corpusTools.connection_dependents.filter((product) => (
      product.connection_ids.some((connectionId) => transferIds.has(connectionId))
    ));
    requireCount(externalDependents.length, 0, "Other current Products depend on transferred account connections");
    if (connectionIdsToTransfer.length > 0) {
      const connections = await client.query(
        "SELECT id, tenant_id, kind, status FROM tool_connections WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",
        [connectionIdsToTransfer]
      );
      const expectedConnections = input.connectionTransferManifest.map((connection) => ({
        id: connection.id,
        tenant_id: connection.source_creator_id,
        kind: connection.kind,
        status: connection.status
      })).sort((left, right) => left.id.localeCompare(right.id));
      requireEqual(connections.rows, expectedConnections, "Locked account connections selected for transfer");
    }
    const factoryManifest = await readFactoryManifest(path.resolve(process.env.HATCH_CREATOR_FACTORY_ROOT ?? "creator-factory-runs"), input.sourceCreatorId, input.productId, EXPECTED.factorySessionIds);
    requireEqual(factoryManifest, input.factoryManifest, "Factory files changed after preflight");
    const productFilesPrefix = process.env.HATCH_CREATOR_PRODUCT_FILES_PREFIX?.trim() || "creator-products";
    const [sourceFiles, targetFiles] = await Promise.all([
      input.objectStore.list(`${productFilesPrefix}/${input.sourceCreatorId}/${input.productId}`),
      input.objectStore.list(`${productFilesPrefix}/${input.targetCreatorId}/${input.productId}`)
    ]);
    requireCount(sourceFiles.length + targetFiles.length, 0, "Locked Product File object count");

    const currentPayloads = await rebuildCommerceEventPayloads(client, currentCommerce.rows, input.sourceCreatorId, input.targetCreatorId, input.targetCreatorName);
    for (const connection of input.connectionTransferManifest) {
      const moved = await client.query(
        `UPDATE tool_connections SET tenant_id=$2
          WHERE id=$1 AND tenant_id=$3 AND kind=$4 AND status='active'
          RETURNING id, tenant_id, kind, status`,
        [connection.id, input.targetCreatorId, input.sourceCreatorId, connection.kind]
      );
      requireCount(moved.rowCount, 1, `Transferred account connection ${connection.id}`);
      requireEqual(moved.rows[0], {
        id: connection.id,
        tenant_id: input.targetCreatorId,
        kind: connection.kind,
        status: "active"
      }, `Transferred account connection ${connection.id} ownership`);
    }
    await client.query("UPDATE hatch_creator_products SET creator_id=$2, updated_at=NOW() WHERE id=$1", [input.productId, input.targetCreatorId]);
    await insertReleaseAndActivate(client, input.preparedRelease);
    for (const [eventId, updated] of currentPayloads) {
      const eventUpdate = await client.query(
        "UPDATE commerce_events SET payload=$2::jsonb, payload_digest=$3 WHERE event_id=$1",
        [eventId, JSON.stringify(updated.payload), updated.payload_digest]
      );
      requireCount(eventUpdate.rowCount, 1, `Updated Commerce event ${eventId}`);
      const outboxUpdate = await client.query(
        "UPDATE commerce_outbox SET payload=$2::jsonb WHERE event_id=$1 AND dispatched_at IS NOT NULL AND locked_at IS NULL",
        [eventId, JSON.stringify(updated.event)]
      );
      requireCount(outboxUpdate.rowCount, 1, `Updated Commerce outbox ${eventId}`);
    }
    await client.query("UPDATE commerce_read_model_state SET projection_version=0 WHERE projection_name='commerce-v2'");
    await rebindPortalCheckoutSessions(client, input.productId, input.sourceCreatorId, input.targetCreatorId, input.targetCreatorName);
    await rebindPortalCreatorProduct(client, input.productId, input.sourceCreatorId, input.targetCreatorId, input.targetCreatorName);
    const conversationMap = await rebindRuntimeConversations(client, input.productId, input.sourceCreatorId, input.targetCreatorId);
    requireEqual(conversationMap, input.runtimeMapping, "Locked Runtime conversation identity map");
    const distillation = await client.query(
      "UPDATE hatch_creator_distillation_runs SET creator_id=$2 WHERE product_id=$1 AND creator_id=$3",
      [input.productId, input.targetCreatorId, input.sourceCreatorId]
    );
    requireCount(distillation.rowCount, 1, "Updated Product Distillation run");
    await client.query(
      `INSERT INTO ${MIGRATION_TABLE}
        (product_id, source_creator_id, target_creator_id, phase, old_release_digest, new_release_digest, factory_manifest, connection_manifest, runtime_mapping, audit_counts)
       VALUES ($1,$2,$3,'database_committed',$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb)`,
      [input.productId, input.sourceCreatorId, input.targetCreatorId, input.expectedCurrentReleaseDigest,
        input.preparedRelease.release_digest, JSON.stringify(input.factoryManifest), JSON.stringify(input.connectionTransferManifest),
        JSON.stringify(input.runtimeMapping), JSON.stringify(input.counts)]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function rebuildCommerceEventPayloads(client, rows, sourceCreatorId, targetCreatorId, targetCreatorName) {
  const allEvents = await client.query(
    "SELECT event_id, event_type, occurred_at, idempotency_key, payload_digest, payload FROM commerce_events ORDER BY sequence"
  );
  const targetRows = new Map(rows.map((row) => [row.event_id, row]));
  const validator = new CommerceLedger();
  const updated = new Map();
  for (const row of allEvents.rows) {
    const oldEvent = {
      ...row.payload,
      event_id: row.event_id,
      event_type: row.event_type,
      occurred_at: new Date(row.occurred_at).toISOString(),
      idempotency_key: row.idempotency_key,
      payload_digest: row.payload_digest
    };
    validator.clock = () => new Date(oldEvent.occurred_at);
    const target = targetRows.get(row.event_id);
    if (!target) {
      await validator.replayPersistedEvent(oldEvent);
      continue;
    }
    const payload = rebindCommercePayload(row.payload, sourceCreatorId, targetCreatorId, targetCreatorName);
    require(payload.creator_id === targetCreatorId && payload.tenant_id === targetCreatorId, `Commerce event ${row.event_id} did not rebind both Creator authority fields`);
    validator.clock = () => new Date(oldEvent.occurred_at);
    const event = await validator.append(row.event_type, payload, {
      eventId: row.event_id,
      idempotencyKey: row.idempotency_key
    });
    requireEqual(event.occurred_at, oldEvent.occurred_at, `Commerce event time ${row.event_id}`);
    const eventPayload = structuredClone(event);
    for (const field of ["event_id", "event_type", "occurred_at", "idempotency_key", "payload_digest"]) delete eventPayload[field];
    updated.set(row.event_id, { event, payload: eventPayload, payload_digest: event.payload_digest });
  }
  requireEqual(updated.size, 4, "Revalidated and rebound Commerce event count");
  return updated;
}

function rebindCommercePayload(source, sourceCreatorId, targetCreatorId, targetCreatorName) {
  const payload = structuredClone(source);
  for (const field of ["creator_id", "tenant_id"]) {
    if (payload[field] === sourceCreatorId) payload[field] = targetCreatorId;
  }
  for (const field of ["creator_name", "creator_display_name"]) {
    if (Object.hasOwn(payload, field)) payload[field] = targetCreatorName;
  }
  for (const field of ["creator", "creator_snapshot"]) rebindCreatorObject(payload[field], sourceCreatorId, targetCreatorId, targetCreatorName);
  for (const field of ["product_snapshot", "release_snapshot", "offer_snapshot"]) {
    const snapshot = payload[field];
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) continue;
    if (snapshot.creator_id === sourceCreatorId) snapshot.creator_id = targetCreatorId;
    if (snapshot.tenant_id === sourceCreatorId) snapshot.tenant_id = targetCreatorId;
    if (Object.hasOwn(snapshot, "creator_name")) snapshot.creator_name = targetCreatorName;
    for (const creatorField of ["creator", "creator_snapshot"]) rebindCreatorObject(snapshot[creatorField], sourceCreatorId, targetCreatorId, targetCreatorName);
  }
  return payload;
}

function rebindCreatorObject(value, sourceCreatorId, targetCreatorId, targetCreatorName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const field of ["id", "creator_id", "tenant_id"]) {
    if (value[field] === sourceCreatorId) value[field] = targetCreatorId;
  }
  for (const field of ["name", "display_name"]) {
    if (Object.hasOwn(value, field)) value[field] = targetCreatorName;
  }
}

async function insertReleaseAndActivate(client, release) {
  await client.query(
    `INSERT INTO hatch_creator_registry_releases
      (product_id, creator_id, release_digest, corpus_digest, corpus_ref, release_ref,
       runtime_manifest_ref, brief_spec, status, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'published',$9)`,
    [release.product_id, release.creator_id, release.release_digest, release.corpus_digest,
      release.corpus_ref, release.release_ref, release.runtime_manifest_ref,
      JSON.stringify(release.brief_spec), release.published_at]
  );
  const activated = await client.query(
    `UPDATE hatch_creator_registry_live SET creator_id=$2, release_digest=$3, updated_at=$4 WHERE product_id=$1`,
    [release.product_id, release.creator_id, release.release_digest, release.published_at]
  );
  requireCount(activated.rowCount, 1, "Activated Tina Registry release");
}

async function rebindPortalCheckoutSessions(client, productId, sourceCreatorId, targetCreatorId, targetCreatorName) {
  const result = await client.query("SELECT state FROM portal_workflow_state WHERE singleton=TRUE FOR UPDATE");
  requireCount(result.rows.length, 1, "Locked Portal state");
  const state = result.rows[0].state;
  const sessions = state?.checkout_sessions;
  require(sessions && typeof sessions === "object" && !Array.isArray(sessions), "Portal checkout state is invalid");
  const matches = Object.values(sessions).filter((session) => session?.product?.product_id === productId);
  requireCount(matches.length, 3, "Locked Product checkout sessions");
  for (const session of matches) {
    requireEqual(session.creator?.id, sourceCreatorId, "Checkout Creator binding");
    if (session.creator && typeof session.creator === "object") rebindCreatorObject(session.creator, sourceCreatorId, targetCreatorId, targetCreatorName);
    if (session.creator_snapshot) rebindCreatorObject(session.creator_snapshot, sourceCreatorId, targetCreatorId, targetCreatorName);
    if (session.creator_id === sourceCreatorId) session.creator_id = targetCreatorId;
    if (Object.hasOwn(session, "creator_name")) session.creator_name = targetCreatorName;
    if (Object.hasOwn(session, "creator_display_name")) session.creator_display_name = targetCreatorName;
    const product = session.product;
    if (product.creator_id === sourceCreatorId) product.creator_id = targetCreatorId;
    if (product.tenant_id === sourceCreatorId) product.tenant_id = targetCreatorId;
    if (Object.hasOwn(product, "creator_name")) product.creator_name = targetCreatorName;
    if (Object.hasOwn(product, "creator_display_name")) product.creator_display_name = targetCreatorName;
    if (product.creator) rebindCreatorObject(product.creator, sourceCreatorId, targetCreatorId, targetCreatorName);
    if (product.creator_snapshot) rebindCreatorObject(product.creator_snapshot, sourceCreatorId, targetCreatorId, targetCreatorName);
  }
  await client.query("UPDATE portal_workflow_state SET state=$1::jsonb, updated_at=NOW() WHERE singleton=TRUE", [JSON.stringify(state)]);
}

async function rebindPortalCreatorProduct(client, productId, sourceCreatorId, targetCreatorId, targetCreatorName) {
  const result = await client.query("SELECT state FROM portal_workflow_state WHERE singleton=TRUE FOR UPDATE");
  requireCount(result.rows.length, 1, "Locked Portal Creator Product state");
  const state = result.rows[0].state;
  const sourceKey = `${sourceCreatorId}:${productId}`;
  const targetKey = `${targetCreatorId}:${productId}`;
  const records = state?.creator_products;
  require(records && typeof records === "object" && !Array.isArray(records), "Portal Creator Product records are invalid");
  const record = records[sourceKey];
  require(!records[targetKey], "Portal target Creator Product record already exists");
  if (!record) return;
  require(record.product_id === productId && record.creator_id === sourceCreatorId, "Portal source Creator Product record changed");
  record.creator_id = targetCreatorId;
  record.version = Number(record.version) + 1;
  record.updated_at = new Date().toISOString();
  rebindPortalReleaseSnapshot(record.release, sourceCreatorId, targetCreatorId, targetCreatorName);
  for (const release of record.releases ?? []) rebindPortalReleaseSnapshot(release, sourceCreatorId, targetCreatorId, targetCreatorName);
  for (const field of ["publish_operation", "last_publish_operation", "rollback_operation", "last_rollback_operation"]) {
    rebindPortalReleaseSnapshot(record[field], sourceCreatorId, targetCreatorId, targetCreatorName);
  }
  delete records[sourceKey];
  records[targetKey] = record;
  await client.query("UPDATE portal_workflow_state SET state=$1::jsonb, updated_at=NOW() WHERE singleton=TRUE", [JSON.stringify(state)]);
}

function rebindPortalReleaseSnapshot(value, sourceCreatorId, targetCreatorId, targetCreatorName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const snapshot = value.catalog_snapshot;
  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    for (const field of ["creator_id", "tenant_id"]) {
      if (snapshot[field] === sourceCreatorId) snapshot[field] = targetCreatorId;
    }
    for (const field of ["creator_name", "creator_display_name"]) {
      if (Object.hasOwn(snapshot, field)) snapshot[field] = targetCreatorName;
    }
    rebindCreatorObject(snapshot.creator, sourceCreatorId, targetCreatorId, targetCreatorName);
  }
}

async function rebindRuntimeConversations(client, productId, sourceCreatorId, targetCreatorId) {
  const conversations = await client.query(
    `SELECT id, public_id, owner_account_id, creator_id, agent_id, product_id, client_request_id
       FROM hatch_conversations WHERE creator_id=$1 AND product_id=$2 ORDER BY id FOR UPDATE`,
    [sourceCreatorId, productId]
  );
  requireCount(conversations.rows.length, 45, "Locked Runtime conversations");
  const mapping = conversations.rows.map((row) => ({
    old_id: String(row.id),
    new_id: durableConversationId(targetCreatorId, row.owner_account_id, productId, row.public_id),
    public_id: row.public_id,
    owner_account_id: row.owner_account_id
  }));
  requireEqual(new Set(mapping.map((row) => row.new_id)).size, mapping.length, "Recomputed Runtime conversation IDs");
  const oldIds = mapping.map((row) => row.old_id);
  const newIds = mapping.map((row) => row.new_id);
  const collisions = await client.query("SELECT count(*)::int AS count FROM hatch_conversations WHERE id=ANY($1::text[])", [newIds]);
  requireCount(Number(collisions.rows[0].count), 0, "Locked Runtime conversation ID collisions");
  const usageCollisions = await client.query(
    "SELECT count(*)::int AS count FROM hatch_conversation_usage WHERE scope_key=ANY($1::text[])",
    [newIds.map((id) => `conversation:${id}`)]
  );
  requireCount(Number(usageCollisions.rows[0].count), 0, "Locked Runtime conversation usage-key collisions");

  const foreignKeys = await client.query(
    `SELECT conname, conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS definition,
            condeferrable, condeferred
       FROM pg_constraint WHERE contype='f' AND confrelid='hatch_conversations'::regclass ORDER BY conrelid::regclass::text, conname`
  );
  const constraints = foreignKeys.rows.map((row) => `${row.table_name}.${row.conname}`).sort();
  requireEqual(constraints, ["hatch_conversation_journal.hatch_conversation_journal_conversation_id_fkey", "hatch_conversation_runs.hatch_conversation_runs_conversation_id_fkey"].sort(), "Conversation ID foreign-key scope");
  for (const row of foreignKeys.rows) {
    requireEqual(row.definition, "FOREIGN KEY (conversation_id) REFERENCES hatch_conversations(id) ON DELETE CASCADE", `Conversation foreign key ${row.conname}`);
    requireEqual(row.condeferrable, false, `Conversation foreign-key deferrable flag ${row.conname}`);
  }
  await client.query("ALTER TABLE hatch_conversation_runs DROP CONSTRAINT hatch_conversation_runs_conversation_id_fkey");
  await client.query("ALTER TABLE hatch_conversation_journal DROP CONSTRAINT hatch_conversation_journal_conversation_id_fkey");
  const oldArray = oldIds;
  const newArray = newIds;
  const mappingSql = "SELECT * FROM unnest($1::text[], $2::text[]) AS mapping(old_id,new_id)";
  await client.query(
    `UPDATE hatch_conversation_runs AS row SET conversation_id=mapping.new_id
       FROM (${mappingSql}) AS mapping WHERE row.conversation_id=mapping.old_id`, [oldArray, newArray]
  );
  await client.query(
    `UPDATE hatch_conversation_journal AS row SET conversation_id=mapping.new_id,
      payload=CASE WHEN row.payload->>'creator_id'=$3 THEN jsonb_set(row.payload,'{creator_id}',to_jsonb($4::text),false) ELSE row.payload END
       FROM (${mappingSql}) AS mapping WHERE row.conversation_id=mapping.old_id`, [oldArray, newArray, sourceCreatorId, targetCreatorId]
  );
  await client.query(
    `UPDATE hatch_conversation_events AS row SET conversation_id=mapping.new_id,
      payload=CASE WHEN row.payload->>'creator_id'=$3 THEN jsonb_set(row.payload,'{creator_id}',to_jsonb($4::text),false) ELSE row.payload END
       FROM (${mappingSql}) AS mapping WHERE row.conversation_id=mapping.old_id`, [oldArray, newArray, sourceCreatorId, targetCreatorId]
  );
  await client.query(
    `UPDATE hatch_conversation_usage AS usage SET scope_key='conversation:' || mapping.new_id
       FROM (${mappingSql}) AS mapping WHERE usage.scope_key='conversation:' || mapping.old_id`, [oldArray, newArray]
  );
  await client.query(
    `UPDATE hatch_conversations AS conversation SET id=mapping.new_id, creator_id=$3
       FROM (${mappingSql}) AS mapping WHERE conversation.id=mapping.old_id`, [oldArray, newArray, targetCreatorId]
  );
  await client.query(`ALTER TABLE hatch_conversation_runs
    ADD CONSTRAINT hatch_conversation_runs_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES hatch_conversations(id) ON DELETE CASCADE`);
  await client.query(`ALTER TABLE hatch_conversation_journal
    ADD CONSTRAINT hatch_conversation_journal_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES hatch_conversations(id) ON DELETE CASCADE`);
  const remaining = await client.query("SELECT count(*)::int AS count FROM hatch_conversations WHERE creator_id=$1 AND product_id=$2", [sourceCreatorId, productId]);
  requireCount(Number(remaining.rows[0].count), 0, "Remaining source Runtime conversations");
  return mapping;
}

function durableConversationId(creatorId, userId, productId, publicId) {
  const bindingHash = createHash("sha256").update([creatorId, userId, productId, productId].join("\0")).digest("hex").slice(0, 24);
  return `conversation:${bindingHash}:${publicId}`;
}

async function findOperation(pool, productId) {
  const exists = await pool.query("SELECT to_regclass($1) AS name", [MIGRATION_TABLE]);
  if (!exists.rows[0].name) return undefined;
  const result = await pool.query(`SELECT * FROM ${MIGRATION_TABLE} WHERE product_id=$1`, [productId]);
  return result.rows[0];
}

async function finishFactoryMove(operation, factoryRoot) {
  const sourceRoot = path.join(factoryRoot, "agent-chats", operation.source_creator_id, operation.product_id);
  const targetRoot = path.join(factoryRoot, "agent-chats", operation.target_creator_id, operation.product_id);
  await mkdir(path.dirname(targetRoot), { recursive: true });
  const expectedManifest = operation.factory_manifest;
  require(expectedManifest && Array.isArray(expectedManifest.sessions) && expectedManifest.sessions.length === 2, "Transfer operation Factory manifest is invalid");
  require(expectedManifest.manual && Array.isArray(expectedManifest.manual.files) && expectedManifest.manual.files.length > 0, "Transfer operation Factory manual manifest is invalid");
  const sourceIds = await directoryNames(sourceRoot);
  const targetIds = await directoryNames(targetRoot);
  const expectedDirectories = [...expectedManifest.sessions.map((session) => session.id), "manual"];
  requireEqual(sorted([...sourceIds, ...targetIds]), sorted(expectedDirectories), "Factory source and target Product directory inventory");
  for (const session of expectedManifest.sessions) {
    const sourceDirectory = path.join(sourceRoot, session.id);
    const targetDirectory = path.join(targetRoot, session.id);
    const atSource = await pathExists(sourceDirectory);
    const atTarget = await pathExists(targetDirectory);
    require(atSource !== atTarget, `Factory session ${session.id} must exist under exactly one Creator`);
    const existingPath = atSource ? sourceDirectory : targetDirectory;
    const metadata = JSON.parse(await readFile(path.join(existingPath, "session.json"), "utf8"));
    requireEqual(metadata.id, session.id, `Factory session ${session.id} metadata ID`);
    require(metadata.status !== "running", `Factory session ${session.id} became active during transfer`);
    requireEqual(await hashDirectory(existingPath), session.files, `Factory session ${session.id} content digest`);
    if (atSource) await rename(sourceDirectory, targetDirectory);
  }
  const sourceManual = path.join(sourceRoot, "manual");
  const targetManual = path.join(targetRoot, "manual");
  const manualAtSource = await pathExists(sourceManual);
  const manualAtTarget = await pathExists(targetManual);
  require(manualAtSource !== manualAtTarget, "Factory manual directory must exist under exactly one Creator");
  const existingManualPath = manualAtSource ? sourceManual : targetManual;
  requireEqual(await hashDirectory(existingManualPath), expectedManifest.manual.files, "Factory Product manual content digest");
  if (manualAtSource) await rename(sourceManual, targetManual);
  const remaining = await directoryNames(sourceRoot);
  requireCount(remaining.length, 0, "Source Factory Product directories after move");
  await rmdir(sourceRoot).catch((error) => { if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error; });
  const moved = await directoryNames(targetRoot);
  requireEqual(sorted(moved), sorted(expectedDirectories), "Target Factory Product directories after move");
  const movedManifest = await readFactoryManifest(factoryRoot, operation.target_creator_id, operation.product_id, EXPECTED.factorySessionIds);
  requireEqual(movedManifest, expectedManifest, "Moved Factory Product manifest");
}

async function refreshCommerceViews(pool) {
  const ledger = await PostgresCommerceLedger.open({ pool });
  try {
    await ledger.refresh();
    const orders = ledger.readCreatorOrders(EXPECTED.targetCreatorId).filter((row) => row.product_id === EXPECTED.productId);
    const entitlements = EXPECTED.entitlementIds.map((id) => ledger.readEntitlement(id)).filter(Boolean);
    requireEqual(sorted(orders.map((row) => row.order_id)), sorted(EXPECTED.orderIds), "Tina Commerce order projections");
    requireEqual(sorted(entitlements.map((row) => row.entitlement_id)), sorted(EXPECTED.entitlementIds), "Tina Commerce entitlement projections");
    require(orders.every((row) => row.creator_id === EXPECTED.targetCreatorId && row.creator_display_name === "Tina"), "Tina Commerce order Creator projection differs");
    require(entitlements.every((row) => row.creator_id === EXPECTED.targetCreatorId && row.status === "active"), "Tina buyer entitlement projection differs");
  } finally {
    await ledger.close();
  }
  const product = await pool.query("SELECT name, promise FROM hatch_creator_products WHERE id=$1", [EXPECTED.productId]);
  const publicResponse = await fetch(`http://127.0.0.1:${Number(process.env.REGISTRY_PORT ?? 8100)}/v1/public/products/${EXPECTED.productId}`, { headers: { accept: "application/json" } });
  if (!publicResponse.ok) throw new Error(`Registry public Product lookup returned HTTP ${publicResponse.status}`);
  const publicProduct = await publicResponse.json();
  requireEqual(publicProduct?.creator?.id, EXPECTED.targetCreatorId, "Public Registry Product Creator ID");
  requireEqual(publicProduct?.creator?.name, "Tina", "Public Registry Product Creator name");
  requireEqual(publicProduct?.product?.id, EXPECTED.productId, "Public Registry Product ID");
  requireEqual(publicProduct?.product?.name, product.rows[0]?.name, "Public Registry Product name");
  requireEqual(publicProduct?.promise, product.rows[0]?.promise, "Public Registry Product promise");
}

async function verifyFinalState(pool, objectStore, operation, factoryRoot) {
  requireEqual(operation.source_creator_id, EXPECTED.sourceCreatorId, "Transfer operation source Creator");
  requireEqual(operation.target_creator_id, EXPECTED.targetCreatorId, "Transfer operation target Creator");
  const product = await pool.query("SELECT creator_id FROM hatch_creator_products WHERE id=$1", [EXPECTED.productId]);
  requireCount(product.rows.length, 1, "Transferred Product row");
  requireEqual(product.rows[0].creator_id, EXPECTED.targetCreatorId, "Transferred Product Creator");
  const live = await pool.query(
    `SELECT live.product_id, live.creator_id, live.release_digest, release.corpus_digest, release.corpus_ref,
            release.release_ref, release.runtime_manifest_ref, release.status
       FROM hatch_creator_registry_live live JOIN hatch_creator_registry_releases release
         ON release.product_id=live.product_id AND release.release_digest=live.release_digest
      WHERE live.product_id=$1`, [EXPECTED.productId]
  );
  requireCount(live.rows.length, 1, "Transferred Registry pointer");
  requireEqual(live.rows[0].creator_id, EXPECTED.targetCreatorId, "Transferred Registry Creator");
  requireEqual(live.rows[0].release_digest, operation.new_release_digest, "Transferred Registry release digest");
  requireEqual(live.rows[0].status, "published", "Transferred Registry release status");
  requireEqual(live.rows[0].release_ref, `registry/${EXPECTED.productId}/releases/${operation.new_release_digest.slice("sha256:".length)}`, "Transferred Registry release reference");
  const connectionManifest = operation.connection_manifest;
  require(Array.isArray(connectionManifest), "Transfer account connection manifest is invalid");
  for (const connection of connectionManifest) {
    requireEqual(connection.source_creator_id, EXPECTED.sourceCreatorId, `Account connection ${connection.id} source owner`);
    requireEqual(connection.target_creator_id, EXPECTED.targetCreatorId, `Account connection ${connection.id} target owner`);
  }
  const currentCorpusTools = await inspectCorpusToolReferences(
    pool,
    objectStore,
    live.rows[0],
    EXPECTED.sourceCreatorId,
    EXPECTED.targetCreatorId
  );
  requireEqual(currentCorpusTools.blockers, [], "Transferred Product tool connection bindings");
  const connectionIds = currentCorpusTools.connections.map((connection) => connection.id);
  if (connectionIds.length > 0) {
    const connections = await pool.query(
      "SELECT id, tenant_id, kind, status FROM tool_connections WHERE id=ANY($1::text[]) ORDER BY id",
      [connectionIds]
    );
    const expectedConnections = currentCorpusTools.connections.map((connection) => ({
      id: connection.id,
      tenant_id: connection.owner_id,
      kind: connection.kind,
      status: connection.status
    })).sort((left, right) => left.id.localeCompare(right.id));
    requireEqual(connections.rows, expectedConnections, "Transferred Product tool connection database bindings");
  }
  const transferredConnectionIds = new Set(connectionManifest.map((connection) => connection.id));
  const remainingSourceDependents = currentCorpusTools.connection_dependents.filter((productRow) => (
    productRow.connection_ids.some((connectionId) => transferredConnectionIds.has(connectionId))
  ));
  requireCount(remainingSourceDependents.length, 0, "Other source Products using transferred account connections");
  const releaseCount = await pool.query("SELECT count(*)::int AS count FROM hatch_creator_registry_releases WHERE product_id=$1", [EXPECTED.productId]);
  requireEqual(Number(releaseCount.rows[0].count), 10, "Registry historical plus current release count");

  const commerce = await pool.query(
    "SELECT event_id, event_type, payload_digest, payload FROM commerce_events WHERE payload->>'product_id'=$1 ORDER BY sequence",
    [EXPECTED.productId]
  );
  requireEqual(commerce.rows.length, 4, "Transferred Commerce event count");
  require(commerce.rows.every((row) => row.payload.creator_id === EXPECTED.targetCreatorId && row.payload.tenant_id === EXPECTED.targetCreatorId), "Transferred Commerce event identity differs");
  const outbox = await pool.query("SELECT count(*)::int AS count FROM commerce_outbox WHERE event_id=ANY($1::text[]) AND dispatched_at IS NOT NULL", [commerce.rows.map((row) => row.event_id)]);
  requireEqual(Number(outbox.rows[0].count), 4, "Transferred Commerce outbox count");
  const conversations = await pool.query(
    "SELECT id, public_id, owner_account_id FROM hatch_conversations WHERE creator_id=$1 AND product_id=$2",
    [EXPECTED.targetCreatorId, EXPECTED.productId]
  );
  requireEqual(conversations.rows.length, 45, "Transferred Runtime conversation count");
  const expectedRuntimeMapping = operation.runtime_mapping;
  require(Array.isArray(expectedRuntimeMapping) && expectedRuntimeMapping.length === 45, "Transfer Runtime identity map is invalid");
  const expectedById = new Map(expectedRuntimeMapping.map((row) => [row.new_id, row]));
  for (const row of conversations.rows) {
    requireEqual(row.id, durableConversationId(EXPECTED.targetCreatorId, row.owner_account_id, EXPECTED.productId, row.public_id), "Transferred Runtime conversation identity");
    const expected = expectedById.get(row.id);
    require(Boolean(expected), `Transferred Runtime conversation ${row.id} is absent from the transfer map`);
    requireEqual(row.public_id, expected.public_id, `Runtime public conversation ID ${row.id}`);
    requireEqual(row.owner_account_id, expected.owner_account_id, `Runtime conversation owner ${row.id}`);
  }
  const [runs, journal, events, usage, oldConversations, distillation, portalState] = await Promise.all([
    pool.query("SELECT count(*)::int AS count FROM hatch_conversation_runs WHERE conversation_id=ANY($1::text[])", [conversations.rows.map((row) => row.id)]),
    pool.query("SELECT count(*)::int AS count FROM hatch_conversation_journal WHERE conversation_id=ANY($1::text[])", [conversations.rows.map((row) => row.id)]),
    pool.query("SELECT count(*)::int AS count FROM hatch_conversation_events WHERE conversation_id=ANY($1::text[])", [conversations.rows.map((row) => row.id)]),
    pool.query("SELECT count(*)::int AS count FROM hatch_conversation_usage WHERE scope_key=ANY($1::text[])", [conversations.rows.map((row) => `conversation:${row.id}`)]),
    pool.query("SELECT count(*)::int AS count FROM hatch_conversations WHERE creator_id=$1 AND product_id=$2", [EXPECTED.sourceCreatorId, EXPECTED.productId]),
    pool.query("SELECT creator_id FROM hatch_creator_distillation_runs WHERE product_id=$1", [EXPECTED.productId]),
    pool.query("SELECT state FROM portal_workflow_state WHERE singleton=TRUE")
  ]);
  requireEqual(Number(runs.rows[0].count), 106, "Transferred Runtime run count");
  requireEqual(Number(journal.rows[0].count), 744, "Transferred Runtime journal count");
  requireEqual(Number(events.rows[0].count), 6773, "Transferred Runtime event count");
  requireEqual(Number(usage.rows[0].count), 39, "Transferred Runtime usage count");
  const residualIdentity = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM hatch_conversation_journal WHERE conversation_id=ANY($1::text[]) AND payload->>'creator_id'=$2) AS journal_source_creator_rows,
       (SELECT count(*)::int FROM hatch_conversation_events WHERE conversation_id=ANY($1::text[]) AND payload->>'creator_id'=$2) AS event_source_creator_rows`,
    [conversations.rows.map((row) => row.id), EXPECTED.sourceCreatorId]
  );
  requireCount(Number(residualIdentity.rows[0].journal_source_creator_rows), 0, "Runtime journal source Creator identity");
  requireCount(Number(residualIdentity.rows[0].event_source_creator_rows), 0, "Runtime event source Creator identity");
  requireCount(Number(oldConversations.rows[0].count), 0, "Remaining source Runtime conversations");
  requireEqual(distillation.rows[0]?.creator_id, EXPECTED.targetCreatorId, "Transferred Distillation run Creator");
  const checkout = inspectCheckoutSessions(portalState.rows[0].state, EXPECTED.productId, EXPECTED.targetCreatorId);
  requireEqual(checkout.count, 3, "Transferred checkout sessions");
  const portalCreatorProduct = inspectFinalPortalCreatorProduct(portalState.rows[0].state, operation);
  requireEqual(portalCreatorProduct.release_count, operation.audit_counts.portal_creator_product.release_count, "Portal historical release count");
  requireEqual(portalCreatorProduct.current_release_id, operation.audit_counts.portal_creator_product.current_release_id, "Portal current release ID");
  requireEqual(portalCreatorProduct.current_corpus_digest, operation.audit_counts.portal_creator_product.current_corpus_digest, "Portal current Corpus digest");
  const factoryManifest = await readFactoryManifest(factoryRoot, EXPECTED.targetCreatorId, EXPECTED.productId, EXPECTED.factorySessionIds);
  const saved = operation.factory_manifest;
  for (const session of factoryManifest.sessions) {
    const original = saved.sessions.find((row) => row.id === session.id);
    require(Boolean(original), `Factory session ${session.id} is absent from transfer manifest`);
    requireEqual(session.files, original.files, `Transferred Factory session ${session.id} bytes`);
  }
  requireEqual(factoryManifest.manual.files, saved.manual.files, "Transferred Factory manual bytes");
  const prefix = process.env.HATCH_CREATOR_PRODUCT_FILES_PREFIX?.trim() || "creator-products";
  const [sourceFiles, targetFiles] = await Promise.all([
    objectStore.list(`${prefix}/${EXPECTED.sourceCreatorId}/${EXPECTED.productId}`),
    objectStore.list(`${prefix}/${EXPECTED.targetCreatorId}/${EXPECTED.productId}`)
  ]);
  requireCount(sourceFiles.length + targetFiles.length, 0, "Product File objects after transfer");
}

function inspectFinalPortalCreatorProduct(state, operation) {
  const records = state?.creator_products;
  require(records && typeof records === "object" && !Array.isArray(records), "Transferred Portal Creator Product state is invalid");
  const targetKey = `${EXPECTED.targetCreatorId}:${EXPECTED.productId}`;
  const sourceKey = `${EXPECTED.sourceCreatorId}:${EXPECTED.productId}`;
  const record = records[targetKey];
  if (operation.audit_counts.portal_creator_product.count === 0) {
    require(!record && !records[sourceKey], "Unexpected Portal Creator Product record appeared during transfer");
    return { release_count: 0, current_release_id: null, current_corpus_digest: null };
  }
  require(record && record.product_id === EXPECTED.productId && record.creator_id === EXPECTED.targetCreatorId, "Transferred Portal Creator Product record is missing");
  require(!records[sourceKey], "Source Portal Creator Product record remains after transfer");
  requireEqual(record.version, operation.audit_counts.portal_creator_product.version + 1, "Portal Creator Product version");
  return {
    release_count: Array.isArray(record.releases) ? record.releases.length : record.release ? 1 : 0,
    current_release_id: record.release?.release_id ?? null,
    current_corpus_digest: record.release?.corpus_digest ?? null
  };
}

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function requireEqual(actual, expected, label) {
  if (JSON.stringify(canonicalValue(actual)) !== JSON.stringify(canonicalValue(expected))) {
    throw new Error(`${label} does not match the audited state`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function requireCount(actual, expected, label) {
  require(actual === expected, `${label}: expected ${expected}, observed ${actual}`);
}

function sorted(values) {
  return [...values].sort();
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
