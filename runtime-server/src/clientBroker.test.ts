import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientToolBroker } from "./clientBroker.js";
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
      "fs.read",
      { path: "pending.txt" },
      undefined,
      "skill-tool-call",
      { scope: "skill_run", skillRunId: "skill-run" }
    );
    await requestSeen;

    let cancelSettled = false;
    const cancelPromise = broker.cancelRun("parent-run", "user cancelled protected task").then((count) => {
      cancelSettled = true;
      return count;
    });
    await assert.rejects(executePromise, (error: Error) => error.message === "user cancelled protected task");
    assert.equal(cancelSettled, false);
    assert.equal(await broker.cancelRun("parent-run", "duplicate cancellation"), 0);
    assert.equal(stored.filter((event) => event.type === "tool.call" && event.status === "cancelled").length, 1);
    const cancelledEvent = stored.find((event) => event.type === "tool.call" && event.status === "cancelled");
    assert.ok(cancelledEvent && cancelledEvent.type === "tool.call");
    assert.equal(cancelledEvent.scope, "skill_run");
    assert.equal(cancelledEvent.skill_run_id, "skill-run");
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
      "fs.read",
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
