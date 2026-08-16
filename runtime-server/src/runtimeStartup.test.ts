import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { commerceEventSinkFromEnvironment } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("normal Runtime startup attaches a durable commerce ledger when configured", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-commerce-"));
  temporaryDirectories.push(directory);
  const ledgerFile = path.join(directory, "commerce.jsonl");
  const commerce = await import(new URL("../../packages/commerce/src/index.js", import.meta.url).href);
  const ledger = await commerce.CommerceLedger.open({ filePath: ledgerFile });
  const common = {
    order_id: "order_desktop_jordan",
    buyer_id: "buyer_jordan_lee",
    creator_id: "creator_maya_chen",
    agent_id: "signal-resume-review",
    product_id: "signal-resume-review",
    corpus_digest: `sha256:${"1".repeat(64)}`
  };
  await ledger.append("order.placed", { ...common, gross_minor: 3900, currency: "USD" }, {
    idempotencyKey: "order:order_desktop_jordan"
  });
  await ledger.append("entitlement.granted", {
    ...common,
    entitlement_id: "entitlement_desktop_jordan"
  }, { idempotencyKey: "entitlement:entitlement_desktop_jordan" });

  const sink = await commerceEventSinkFromEnvironment({ HATCH_COMMERCE_LEDGER_FILE: ledgerFile });
  assert.ok(sink);
  await sink.append("product.started", {
    ...common,
    entitlement_id: "entitlement_desktop_jordan",
    product_id: "task_desktop_jordan"
  }, { idempotencyKey: "product:task_desktop_jordan:started" });

  const reopened = await commerce.CommerceLedger.open({ filePath: ledgerFile });
  assert.deepEqual(reopened.listEvents().map((event: Record<string, unknown>) => event.event_type), [
    "order.placed",
    "entitlement.granted",
    "product.started"
  ]);
});

test("normal Runtime startup leaves local development ledger-free when no ledger is configured", async () => {
  assert.equal(await commerceEventSinkFromEnvironment({}), undefined);
});
