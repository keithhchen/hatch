import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientToolBroker } from "./clientBroker.js";
import type { RuntimeStore } from "./store.js";

type StoreEventInput = Parameters<RuntimeStore["append"]>[0];

test("cancel owns an unreturned tool promise and ignores late results", async () => {
  const stored: StoreEventInput[] = [];
  const outbound: Array<Record<string, unknown>> = [];
  let requestEmitted!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    requestEmitted = resolve;
  });
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const store = {
    append: async (event: StoreEventInput) => {
      stored.push(event);
    }
  } as unknown as RuntimeStore;
  const broker = new ClientToolBroker(
    async (message) => {
      outbound.push(message as unknown as Record<string, unknown>);
      if (message.type !== "tool_call.request") return;
      requestEmitted();
      await requestGate;
    },
    store,
    10_000
  );

  let unhandledRejections = 0;
  const onUnhandledRejection = () => {
    unhandledRejections += 1;
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const executePromise = broker.execute(
      "parent-run",
      "fs.read",
      { path: "pending.txt" },
      undefined,
      "skill-tool-call",
      { scope: "skill_run", skillRunId: "skill-run" }
    );
    await requestSeen;

    assert.equal(await broker.cancelRun("parent-run", "user cancelled protected task"), 1);
    assert.equal(await broker.cancelRun("parent-run", "duplicate cancellation"), 0);
    assert.equal(stored.filter((event) => event.type === "tool.call" && event.status === "cancelled").length, 1);
    const cancelledEvent = stored.find((event) => event.type === "tool.call" && event.status === "cancelled");
    assert.ok(cancelledEvent && cancelledEvent.type === "tool.call");
    assert.equal(cancelledEvent.scope, "skill_run");
    assert.equal(cancelledEvent.skill_run_id, "skill-run");
    assert.equal(outbound.filter((message) => message.type === "tool_call.delta" && message.status === "cancelled").length, 1);

    releaseRequest();
    await assert.rejects(executePromise, (error: Error) => error.message === "user cancelled protected task");
    assert.equal(await broker.handleResult({
      type: "tool_call.result",
      run_id: "parent-run",
      tool_call_id: "skill-tool-call",
      status: "ok",
      result: { content: "late result" }
    }), false);

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(unhandledRejections, 0);
  } finally {
    releaseRequest();
    process.off("unhandledRejection", onUnhandledRejection);
  }
});
