import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { TaskRefused, type TaskRepository } from "./tasks.js";

const ACCOUNT = randomUUID();

/** The contract every TaskRepository keeps for the Expert's decision on a task, run against each store. */
export function decisionConformance(name: string, make: () => Promise<{ tasks: TaskRepository; close?: () => Promise<void> }>, options: { skip?: boolean; timeout?: number } = {}): void {
  const it = (title: string, body: () => Promise<void>) => test(title, options, body);
  const run = async (body: (tasks: TaskRepository, waiting: () => ReturnType<TaskRepository["create"]>) => Promise<void>) => {
    const { tasks, close } = await make();
    try { await body(tasks, () => tasks.create({ accountId: ACCOUNT, kind: "change", origin: { source: "web" }, status: "needs_you", needs: "review", payload: {}, summary: "发布" })); } finally { await close?.(); }
  };
  const counted = () => { const effects: string[] = []; return { effects, effect: async (task: { id: string }) => { effects.push(task.id); } }; };

  it(`${name}: deciding records the decision with its key in the step that finishes the task`, () => run(async (tasks, waiting) => {
    const task = await waiting();
    const { effects, effect } = counted();
    const decided = await tasks.decide(task.id, { action: "approve", key: "k1" }, effect);
    assert.equal(decided.replayed, false);
    assert.deepEqual([decided.task.status, decided.task.needs, decided.task.summary, decided.task.decision?.action, decided.task.decision?.key], ["done", undefined, "发布（已确认）", "approve", "k1"]);
    assert.deepEqual(await tasks.get(task.id), decided.task, "what was returned is what is stored");
    assert.deepEqual(effects, [task.id]);
  }));

  it(`${name}: the same key deciding again returns the recorded outcome and runs nothing`, () => run(async (tasks, waiting) => {
    const task = await waiting();
    const { effects, effect } = counted();
    const first = await tasks.decide(task.id, { action: "approve", key: "k1" }, effect);
    const again = await tasks.decide(task.id, { action: "approve", key: "k1" }, effect);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.task, first.task);
    assert.equal(effects.length, 1);
    const other = await tasks.decide(task.id, { action: "approve", key: "k2" }, effect);
    assert.equal(other.replayed, true, "another decider saying the same thing is not a second decision");
    assert.equal(other.task.decision?.key, "k1", "the first decision stays the record");
    assert.equal(effects.length, 1);
  }));

  it(`${name}: the other decision on a decided task is refused, and the task and the world stay as they were`, () => run(async (tasks, waiting) => {
    const task = await waiting();
    const { effects, effect } = counted();
    const decided = await tasks.decide(task.id, { action: "approve", key: "k1" }, effect);
    await assert.rejects(tasks.decide(task.id, { action: "decline", key: "k2" }, effect), (error: unknown) => error instanceof TaskRefused && error.status === 409 && /已确认.*不能再取消/.test(error.message));
    assert.deepEqual(await tasks.get(task.id), decided.task);
    assert.equal(effects.length, 1);
    const declined = await waiting();
    await tasks.decide(declined.id, { action: "decline", key: "k3" }, effect);
    await assert.rejects(tasks.decide(declined.id, { action: "approve", key: "k4" }, effect), /已取消.*不能再确认/);
    assert.equal(effects.length, 2, "the decline took its one turn, and approving afterwards took none");
  }));

  it(`${name}: an effect that fails records nothing, and the task still waits for a decision that works`, () => run(async (tasks, waiting) => {
    const task = await waiting();
    await assert.rejects(tasks.decide(task.id, { action: "approve", key: "k1" }, async () => { throw new Error("storefront unavailable"); }), /storefront unavailable/);
    const waitingStill = (await tasks.get(task.id))!;
    assert.deepEqual([waitingStill.status, waitingStill.needs, waitingStill.decision], ["needs_you", "review", undefined]);
    const { effects, effect } = counted();
    assert.equal((await tasks.decide(task.id, { action: "approve", key: "k1" }, effect)).replayed, false);
    assert.equal(effects.length, 1);
  }));

  it(`${name}: any number of deciders at once decide once`, () => run(async (tasks, waiting) => {
    const task = await waiting();
    const { effects, effect } = counted();
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => tasks.decide(task.id, { action: "approve", key: `k${index % 2}` }, effect)));
    assert.equal(effects.length, 1);
    assert.equal(results.filter(result => !result.replayed).length, 1);
    const against = await waiting();
    const race = await Promise.allSettled([tasks.decide(against.id, { action: "approve", key: "a" }, effect), tasks.decide(against.id, { action: "decline", key: "b" }, effect)]);
    assert.deepEqual(race.map(result => result.status).sort(), ["fulfilled", "rejected"], "of an approval and a decline at once, one wins");
    assert.ok(race.some(result => result.status === "rejected" && result.reason instanceof TaskRefused), "the loser is told why");
  }));

  it(`${name}: only a task waiting for review is approved; a task waiting for anything is declined; a missing task is not found`, () => run(async (tasks) => {
    const asking = await tasks.create({ accountId: ACCOUNT, kind: "poke", origin: { source: "web" }, status: "needs_you", needs: "answer", payload: {} });
    const { effects, effect } = counted();
    await assert.rejects(tasks.decide(asking.id, { action: "approve", key: "k" }, effect), (error: unknown) => error instanceof TaskRefused && /不需要确认/.test(error.message));
    assert.equal((await tasks.decide(asking.id, { action: "decline", key: "k" }, effect)).task.status, "done");
    const working = await tasks.create({ accountId: ACCOUNT, kind: "build", origin: { source: "web" }, payload: {} });
    await assert.rejects(tasks.decide(working.id, { action: "decline", key: "k" }, effect), (error: unknown) => error instanceof TaskRefused && /已经结束/.test(error.message));
    await assert.rejects(tasks.decide(randomUUID(), { action: "approve", key: "k" }, effect), (error: unknown) => (error as { status?: number }).status === 404);
  }));
}
