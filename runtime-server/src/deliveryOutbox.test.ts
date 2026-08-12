import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  DeliveryAccountingOutbox,
  DeliveryAccountingOutboxError,
  type DeliveryAccountingCommand
} from "./deliveryOutbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("initialize validates the envelope and proves the durable directory is writable", async () => {
  const filePath = await outboxPath();
  await new DeliveryAccountingOutbox(filePath).initialize();

  await writeFile(filePath, "{not-json", "utf8");
  await assert.rejects(
    new DeliveryAccountingOutbox(filePath).initialize(),
    (error) => error instanceof DeliveryAccountingOutboxError && error.code === "corrupt_outbox"
  );

  const blockedParent = path.join(path.dirname(filePath), "not-a-directory");
  await writeFile(blockedParent, "file", "utf8");
  await assert.rejects(new DeliveryAccountingOutbox(path.join(blockedParent, "outbox.json")).initialize());
});

test("enqueue is idempotent, rejects conflicting or unsafe commands, and persists no content or path", async () => {
  const filePath = await outboxPath();
  const outbox = new DeliveryAccountingOutbox(filePath, { clock: tickingClock() });
  const command = accountingCommand("one");

  const first = await outbox.enqueue(command);
  const replay = await outbox.enqueue(structuredClone(command));
  assert.deepEqual(replay, first);
  assert.equal((await outbox.list()).length, 1);

  await assert.rejects(
    outbox.enqueue({ ...command, artifact: { ...command.artifact, digest: digest("different") } }),
    (error) => error instanceof DeliveryAccountingOutboxError && error.code === "idempotency_conflict"
  );
  await assert.rejects(
    outbox.enqueue({
      ...accountingCommand("unsafe"),
      artifact: { ...accountingCommand("unsafe").artifact, path: "/Users/buyer/private.txt", content: "secret" }
    } as unknown as DeliveryAccountingCommand),
    (error) => error instanceof DeliveryAccountingOutboxError && error.code === "invalid_command"
  );

  const serialized = await readFile(filePath, "utf8");
  assert.doesNotMatch(serialized, /private\.txt|secret/);
  assert.doesNotMatch(serialized, /"(?:artifact_)?(?:path|content)"/);
});

test("reconcile removes successes, preserves failures, and recovers after restart", async () => {
  const filePath = await outboxPath();
  const firstProcess = new DeliveryAccountingOutbox(filePath, { clock: tickingClock() });
  await firstProcess.enqueue(accountingCommand("success"));
  await firstProcess.enqueue(accountingCommand("retry"));

  const firstResult = await firstProcess.reconcile(async (command) => {
    if (command.commandId === "account-delivery-retry") throw new Error("Commerce unavailable");
  });
  assert.equal(firstResult.attempted, 2);
  assert.deepEqual(firstResult.delivered, ["account-delivery-success"]);
  assert.deepEqual(firstResult.failed.map((failure) => failure.commandId), ["account-delivery-retry"]);

  const pending = await firstProcess.list();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.attemptCount, 1);
  assert.ok(pending[0]?.lastAttemptAt);

  const restartedProcess = new DeliveryAccountingOutbox(filePath, { clock: tickingClock() });
  assert.equal((await restartedProcess.list())[0]?.command.commandId, "account-delivery-retry");
  const delivered: string[] = [];
  const replayResult = await restartedProcess.reconcile(async (command) => {
    delivered.push(command.commandId);
  });
  assert.deepEqual(replayResult.delivered, ["account-delivery-retry"]);
  assert.deepEqual(delivered, ["account-delivery-retry"]);
  assert.deepEqual(await restartedProcess.list(), []);
  assert.equal(await restartedProcess.markDelivered("account-delivery-retry"), false);
});

test("independent writers do not lose concurrent enqueues", async () => {
  const filePath = await outboxPath();
  const first = new DeliveryAccountingOutbox(filePath);
  const second = new DeliveryAccountingOutbox(filePath);
  const commands = Array.from({ length: 16 }, (_, index) => accountingCommand(`concurrent-${index}`));

  await Promise.all(commands.map((command, index) => (index % 2 === 0 ? first : second).enqueue(command)));

  const entries = await new DeliveryAccountingOutbox(filePath).list();
  assert.equal(entries.length, commands.length);
  assert.deepEqual(
    new Set(entries.map((entry) => entry.command.commandId)),
    new Set(commands.map((command) => command.commandId))
  );
});

test("reconcile calls on one instance are serialized and deliver each pending command once", async () => {
  const filePath = await outboxPath();
  const outbox = new DeliveryAccountingOutbox(filePath);
  await Promise.all(["a", "b", "c"].map((suffix) => outbox.enqueue(accountingCommand(suffix))));
  let active = 0;
  let maximumActive = 0;
  const deliveries: string[] = [];
  const deliver = async (command: DeliveryAccountingCommand) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    deliveries.push(command.commandId);
    active -= 1;
  };

  const [first, second] = await Promise.all([outbox.reconcile(deliver), outbox.reconcile(deliver)]);
  assert.equal(first.attempted + second.attempted, 3);
  assert.equal(maximumActive, 1);
  assert.deepEqual(deliveries, ["account-delivery-a", "account-delivery-b", "account-delivery-c"]);
  assert.deepEqual(await outbox.list(), []);
});

async function outboxPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-delivery-outbox-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "pending.json");
}

function accountingCommand(suffix: string): DeliveryAccountingCommand {
  return {
    version: 1,
    commandId: `account-delivery-${suffix}`,
    binding: {
      entitlementId: `entitlement-${suffix}`,
      orderId: `order-${suffix}`,
      userId: "buyer-safe",
      creatorId: "creator-safe",
      agentId: "agent-safe",
      productId: "product-safe",
      corpusDigest: digest("corpus")
    },
    conversationId: `conversation-${suffix}`,
    runId: `run-${suffix}`,
    artifact: { type: "file", digest: digest(`artifact-${suffix}`) },
    reservation: {
      reservationId: `reservation-${suffix}`,
      taskId: `task-${suffix}`,
      deliveryId: `delivery-${suffix}`
    }
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function tickingClock(): () => Date {
  let tick = Date.parse("2026-08-12T00:00:00.000Z");
  return () => new Date(tick++);
}
