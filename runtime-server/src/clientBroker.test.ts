import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientToolBroker } from "./clientBroker.js";
import { MAX_TOOL_RESULT_BYTES } from "./protocol.js";
import type { RunStateMachine } from "./runState.js";
import type { RuntimeStore } from "./store.js";

type StoreEventInput = Parameters<RuntimeStore["append"]>[0];

test("cancel owns an unreturned tool promise and ignores late results", async () => {
  const stored: StoreEventInput[] = [];
  const outbound: Array<Record<string, unknown>> = [];
  let requestEmitted!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    requestEmitted = resolve;
  });
  let releaseCancellation!: () => void;
  const cancellationGate = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  const store = {
    append: async (event: StoreEventInput) => {
      stored.push(event);
    }
  } as unknown as RuntimeStore;
  const broker = new ClientToolBroker(
    async (message) => {
      outbound.push(message as unknown as Record<string, unknown>);
      if (message.type === "tool_call.request") {
        requestEmitted();
      }
      if (message.type === "tool_call.delta" && message.status === "cancelled") {
        await cancellationGate;
      }
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
      "file_read",
      { path: "pending.txt" },
      undefined,
      "skill-tool-call"
    );
    await requestSeen;

    let cancelSettled = false;
    const cancelPromise = broker.cancelRun("parent-run", "user cancelled protected product").then((count) => {
      cancelSettled = true;
      return count;
    });
    await assert.rejects(executePromise, (error: Error) => error.message === "user cancelled protected product");
    assert.equal(cancelSettled, false);
    assert.equal(await broker.cancelRun("parent-run", "duplicate cancellation"), 0);
    assert.equal(stored.filter((event) => event.type === "tool.call" && event.status === "cancelled").length, 1);
    const cancelledEvent = stored.find((event) => event.type === "tool.call" && event.status === "cancelled");
    assert.ok(cancelledEvent && cancelledEvent.type === "tool.call");
    assert.equal(outbound.filter((message) => message.type === "tool_call.delta" && message.status === "cancelled").length, 1);

    releaseCancellation();
    assert.equal(await cancelPromise, 1);
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
    releaseCancellation();
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("cancellation owns the caller promise while dispatch is blocked at each await", async () => {
  type Gate = {
    entered: Promise<void>;
    release: () => void;
  };

  const makeGate = (): Gate => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      entered: entered.then(() => gate),
      release: () => {
        enter();
        release();
      }
    };
  };

  const assertImmediateRejection = async (promise: Promise<Record<string, unknown>>): Promise<void> => {
    const observed = promise.then(
      () => false,
      (error: Error) => error.message === "cancel during dispatch"
    );
    assert.equal(await Promise.race([
      observed,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ]), true);
  };

  for (const phase of ["waitForTool", "requested store append", "request emit"] as const) {
    const stored: StoreEventInput[] = [];
    const outbound: Array<Record<string, unknown>> = [];
    const gate = makeGate();
    let phaseReached!: () => void;
    const phaseReady = new Promise<void>((resolve) => {
      phaseReached = resolve;
    });
    const store = {
      append: async (event: StoreEventInput) => {
        if (phase === "requested store append" && event.type === "tool.call" && event.status === "requested") {
          phaseReached();
          await gate.entered;
        }
        stored.push(event);
      }
    } as unknown as RuntimeStore;
    const state = phase === "waitForTool"
      ? ({
          conversationId: "dispatch-conversation",
          waitForTool: async () => {
            phaseReached();
            await gate.entered;
          }
        } as unknown as RunStateMachine)
      : undefined;
    const broker = new ClientToolBroker(
      async (message) => {
        if (phase === "request emit" && message.type === "tool_call.request") {
          phaseReached();
          await gate.entered;
        }
        outbound.push(message as unknown as Record<string, unknown>);
      },
      store,
      10_000
    );
    const runId = `dispatch-${phase}`;
    const executePromise = broker.execute(
      runId,
      "file_read",
      { path: "dispatch-window.txt" },
      state,
      `dispatch-tool-${phase.replaceAll(" ", "-")}`
    );
    await phaseReady;

    const cancelPromise = broker.cancelRun(runId, "cancel during dispatch");
    await assertImmediateRejection(executePromise);
    assert.equal(await broker.cancelRun(runId, "duplicate cancellation"), 0);

    gate.release();
    await cancelPromise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const requestMessages = outbound.filter((message) => message.type === "tool_call.request");
    if (phase === "request emit") {
      assert.ok(requestMessages.length <= 1, `${phase} emitted duplicate requests`);
    } else {
      assert.equal(requestMessages.length, 0, `${phase} emitted a stale request after cancellation`);
    }
    assert.equal(stored.filter((event) => event.type === "tool.call" && event.status === "cancelled").length, 1);
  }
});

test("tool results settle the worker even when terminal observability fails", async () => {
  for (const outcome of ["success", "error", "oversize"] as const) {
    let requestSeen!: () => void;
    const requested = new Promise<void>((resolve) => { requestSeen = resolve; });
    const store = {
      append: async (event: StoreEventInput) => {
        if (event.type === "tool.call" && event.status !== "requested") {
          throw new Error(`terminal store unavailable: ${outcome}`);
        }
      }
    } as unknown as RuntimeStore;
    const broker = new ClientToolBroker(
      async (message) => {
        if (message.type === "tool_call.request") requestSeen();
        if (message.type === "approval.result") throw new Error("approval event unavailable");
      },
      store,
      10_000
    );
    const runId = `result-${outcome}`;
    const toolCallId = `tool-${outcome}`;
    const execution = broker.execute(
      runId,
      "file_write",
      { path: "result.txt", content: "content" },
      undefined,
      toolCallId,
      { approvalOverride: "ask" }
    );
    await requested;

    if (outcome === "success") {
      assert.equal(await broker.handleResult({
        type: "tool_call.result",
        run_id: runId,
        tool_call_id: toolCallId,
        status: "ok",
        result: { saved: true }
      }), true);
      assert.deepEqual(await execution, { saved: true });
    } else if (outcome === "error") {
      assert.equal(await broker.handleResult({
        type: "tool_call.result",
        run_id: runId,
        tool_call_id: toolCallId,
        status: "error",
        error: { code: "write_failed", message: "client write failed" }
      }), true);
      await assert.rejects(execution, /client write failed/);
    } else {
      assert.equal(await broker.handleResult({
        type: "tool_call.result",
        run_id: runId,
        tool_call_id: toolCallId,
        status: "ok",
        result: { content: "x".repeat(MAX_TOOL_RESULT_BYTES) }
      }), true);
      await assert.rejects(execution, /transport envelope/);
    }
  }
});

test("cancelAll claims every pending call before failing store and emit fan-out", async () => {
  let requestCount = 0;
  let markRequestsSeen!: () => void;
  const requestsSeen = new Promise<void>((resolve) => { markRequestsSeen = resolve; });
  const store = {
    append: async (event: StoreEventInput) => {
      if (event.type === "tool.call" && event.status === "cancelled") {
        throw new Error("cancel audit unavailable");
      }
    }
  } as unknown as RuntimeStore;
  const broker = new ClientToolBroker(async (message) => {
    if (message.type === "tool_call.request") {
      requestCount += 1;
      if (requestCount === 2) markRequestsSeen();
    }
    if (message.type === "tool_call.delta" && message.status === "cancelled") {
      throw new Error("cancel emit unavailable");
    }
  }, store, 10_000);
  const first = broker.execute("cancel-all-one", "file_read", { path: "one" }, undefined, "tool-one");
  const second = broker.execute("cancel-all-two", "file_read", { path: "two" }, undefined, "tool-two");
  await requestsSeen;

  await broker.cancelAll("disconnect despite observability outage");
  await assert.rejects(first, /disconnect despite observability outage/);
  await assert.rejects(second, /disconnect despite observability outage/);
  assert.equal(await broker.cancelRun("cancel-all-one"), 0);
  assert.equal(await broker.cancelRun("cancel-all-two"), 0);
});

test("timeout store failure is handled and does not emit unhandledRejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const store = {
    append: async (event: StoreEventInput) => {
      if (event.type === "tool.call" && event.status === "failed") {
        throw new Error("timeout audit unavailable");
      }
    }
  } as unknown as RuntimeStore;
  const broker = new ClientToolBroker(async () => undefined, store, 10);
  try {
    await assert.rejects(
      broker.execute("timeout-run", "file_read", { path: "timeout" }, undefined, "timeout-tool"),
      /Timed out waiting/
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a stale timeout cannot delete a new call that reuses the same IDs", async () => {
  const store = { append: async () => undefined } as unknown as RuntimeStore;
  const broker = new ClientToolBroker(async () => undefined, store, 100);
  const first = broker.execute("reused-run", "file_read", { path: "first" }, undefined, "reused-tool");

  // Make the first timer due without yielding to the timers phase. The old
  // result is then claimed and the same key is reused before that callback runs.
  const deadline = Date.now() + 125;
  while (Date.now() < deadline) {
    // Intentional short event-loop block for deterministic stale-timer ordering.
  }
  const firstHandled = broker.handleResult({
    type: "tool_call.result",
    run_id: "reused-run",
    tool_call_id: "reused-tool",
    status: "ok",
    result: { content: "first result" }
  });
  const second = broker.execute("reused-run", "file_read", { path: "second" }, undefined, "reused-tool");
  await firstHandled;
  assert.deepEqual(await first, { content: "first result" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(await broker.handleResult({
    type: "tool_call.result",
    run_id: "reused-run",
    tool_call_id: "reused-tool",
    status: "ok",
    result: { content: "second result" }
  }), true);
  assert.deepEqual(await second, { content: "second result" });
});

test("broker keys are collision-free and duplicate tool_call_id cannot overwrite pending work", async () => {
  let requestCount = 0;
  let markCollisionRequests!: () => void;
  const collisionRequests = new Promise<void>((resolve) => { markCollisionRequests = resolve; });
  const store = { append: async () => undefined } as unknown as RuntimeStore;
  const broker = new ClientToolBroker(async (message) => {
    if (message.type === "tool_call.request") {
      requestCount += 1;
      if (requestCount === 2) markCollisionRequests();
    }
  }, store, 10_000);

  const colonLeft = broker.execute("a:b", "file_read", { path: "left" }, undefined, "c");
  const colonRight = broker.execute("a", "file_read", { path: "right" }, undefined, "b:c");
  await collisionRequests;
  await broker.cancelAll("collision test complete");
  await assert.rejects(colonLeft, /collision test complete/);
  await assert.rejects(colonRight, /collision test complete/);

  const original = broker.execute("same-run", "file_read", { path: "original" }, undefined, "same-tool");
  await assert.rejects(
    broker.execute("same-run", "file_read", { path: "replacement" }, undefined, "same-tool"),
    /Duplicate client tool call ID/
  );
  assert.equal(await broker.handleResult({
    type: "tool_call.result",
    run_id: "same-run",
    tool_call_id: "same-tool",
    status: "ok",
    result: { content: "original result" }
  }), true);
  assert.deepEqual(await original, { content: "original result" });
});
