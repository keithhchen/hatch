import assert from "node:assert/strict";
import test from "node:test";
import { emptyLog, foldLog, foldLogEvents, mergeOlderLog, projectLog } from "../src/domain/chat-log.js";

let position = 0;
/** Events as the server writes them: positions rise by one. */
const log = (...specs) => specs.map(([type, fields]) => ({ position: ++position, type, at: "2026-01-01T00:00:00Z", ...fields }));
const reset = () => { position = 0; };
const user = (id, run, content = id) => ["user.message", { id, run_id: run, content }];
const state = (run, status, fields = {}) => ["run.state", { run_id: run, status, ...fields }];
const text = (run, content) => ["assistant.text", { run_id: run, content }];
const tool = (run, id, status, fields = {}) => ["tool.call", { run_id: run, tool_call_id: id, name: "read", status, ...fields }];
const thinking = (run, index, phase, fields = {}) => ["assistant.thinking", { run_id: run, index, phase, ...fields }];
const shape = messages => messages.map(message => message.role === "user" ? `user:${message.id}${message.state ? `(${message.state})` : ""}`
  : `reply:${message.timeline.map(entry => entry.kind === "text" ? JSON.stringify(entry.content) : entry.kind).join(",")}${message.transient ? "*" : ""}`);

test("a Run is the user message and one reply; the reply in progress is transient and the finished one is not", () => {
  reset();
  const events = log(user("m1", "r1", "hi"), state("r1", "running"), text("r1", "Hel"), text("r1", "lo"));
  const running = projectLog(foldLogEvents(emptyLog(), events));
  assert.deepEqual(shape(running.messages), ["user:m1", 'reply:"Hello"*']);
  assert.equal(running.activeRun, "r1");
  assert.equal(running.runState, "running");
  const done = projectLog(foldLogEvents(emptyLog(), [...events, ...log(state("r1", "completed"))]));
  assert.deepEqual(shape(done.messages), ["user:m1", 'reply:"Hello"']);
  assert.equal(done.activeRun, null);
  assert.equal(done.messages[1].content, "Hello");
});

test("a Run that has shown nothing yet has an empty reply coming", () => {
  reset();
  const projected = projectLog(foldLogEvents(emptyLog(), log(user("m1", "r1"), state("r1", "queued"))));
  assert.deepEqual(shape(projected.messages), ["user:m1", "reply:*"]);
});

test("text, steps, text: separate entries, the later text set off by a paragraph break", () => {
  reset();
  const projected = projectLog(foldLogEvents(emptyLog(), log(user("m1", "r1"), state("r1", "running"), text("r1", "A"), tool("r1", "t1", "requested"), tool("r1", "t1", "completed"), text("r1", "B"), text("r1", "C"))));
  const reply = projected.messages[1];
  assert.deepEqual(shape(projected.messages), ["user:m1", 'reply:"A",tool,"\\n\\nBC"*']);
  assert.equal(reply.content, "A\n\nBC");
  assert.equal(reply.timeline[1].status, "completed");
  assert.equal(reply.timeline[1].id, "tool-t1");
});

test("a steered message is where its Run took it up: [A, steps, M, B], and last and queued until then", () => {
  reset();
  const head = log(user("m1", "r1"), state("r1", "running"), text("r1", "A"), tool("r1", "t1", "completed"));
  const queued = log(["message.queued", { id: "m2", run_id: "r1", content: "m2" }]);
  assert.deepEqual(shape(projectLog(foldLogEvents(emptyLog(), [...head, ...queued])).messages), ["user:m1", 'reply:"A",tool*', "user:m2(queued)"]);
  const claimed = log(user("m2", "r1"), text("r1", "B"));
  const after = projectLog(foldLogEvents(emptyLog(), [...head, ...queued, ...claimed]));
  assert.deepEqual(shape(after.messages), ["user:m1", 'reply:"A",tool', "user:m2", 'reply:"B"*']);
  assert.deepEqual(after.messages.map(message => message.renderKey).filter((key, index, keys) => keys.indexOf(key) === index).length, 4, "every row has its own key");
  // Claimed and nothing said yet: the reply that is coming sits after the message.
  const waiting = projectLog(foldLogEvents(emptyLog(), [...head, ...queued, ...log(user("m2", "r1"))]));
  assert.deepEqual(shape(waiting.messages), ["user:m1", 'reply:"A",tool', "user:m2", "reply:*"]);
});

test("thinking by index: start, delta, end; an end without a start; a start heard again leaves none streaming", () => {
  reset();
  const base = [...log(user("m1", "r1"), state("r1", "running"))];
  const entries = events => projectLog(foldLogEvents(emptyLog(), [...base, ...events])).messages[1].timeline.filter(entry => entry.kind === "thinking").map(entry => [entry.content, entry.streaming]);
  assert.deepEqual(entries(log(thinking("r1", 0, "start"), thinking("r1", 0, "delta", { delta: "so " }), thinking("r1", 0, "delta", { delta: "far" }))), [["so far", true]]);
  assert.deepEqual(entries(log(thinking("r1", 0, "start"), thinking("r1", 0, "delta", { delta: "so" }), thinking("r1", 0, "end", { content: "so far, done" }))), [["so far, done", false]]);
  assert.deepEqual(entries(log(thinking("r1", 1, "delta", { delta: "mid" }), thinking("r1", 1, "end", { content: "mid, done" }), thinking("r1", 0, "end", { content: "whole" }))), [["mid, done", false], ["whole", false]]);
  assert.deepEqual(entries(log(thinking("r1", 0, "start"), thinking("r1", 0, "start"))), [["", false], ["", true]]);
  assert.deepEqual(entries(log(thinking("r1", 0, "end", { content: "one" }), thinking("r1", 0, "start"), thinking("r1", 0, "end", { content: "two" }))), [["one", false], ["two", false]], "a new block at an index that finished before still draws");
});

test("a thinking block cut mid-stream stops streaming when its Run ends", () => {
  reset();
  const events = log(user("m1", "r1"), state("r1", "running"), thinking("r1", 0, "start"), thinking("r1", 0, "delta", { delta: "half" }));
  assert.equal(projectLog(foldLogEvents(emptyLog(), events)).messages[1].timeline[0].streaming, true);
  const ended = projectLog(foldLogEvents(emptyLog(), [...events, ...log(state("r1", "interrupted"))]));
  assert.deepEqual(ended.messages[1].timeline.map(entry => [entry.content, entry.streaming]), [["half", false]]);
});

test("a tool never goes backwards, and a later reply's update reaches the earlier step", () => {
  reset();
  const events = log(user("m1", "r1"), state("r1", "running"), tool("r1", "t1", "requested"), user("m2", "r1"), text("r1", "B"), tool("r1", "t1", "completed", { result: "ok" }), tool("r1", "t1", "running"));
  const projected = projectLog(foldLogEvents(emptyLog(), events));
  assert.deepEqual(shape(projected.messages), ["user:m1", "reply:tool", "user:m2", 'reply:"B"*']);
  assert.deepEqual([projected.messages[1].timeline[0].status, projected.messages[1].timeline[0].content.result], ["completed", "ok"]);
});

test("skills and skill runs are steps placed once by their ids", () => {
  reset();
  const skill = { run_id: "r1", name: "plan", path: "p", reason: "why" };
  const projected = projectLog(foldLogEvents(emptyLog(), log(user("m1", "r1"), state("r1", "running"), ["skill.activated", skill], ["skill.activated", skill], ["skill.run", { run_id: "r1", skill_run_id: "s", name: "plan", status: "running" }], ["skill.run", { run_id: "r1", skill_run_id: "s", name: "plan", status: "completed" }])));
  assert.deepEqual(projected.messages[1].timeline.map(entry => [entry.kind, entry.status]), [["skill", "activated"], ["skill_run", "completed"]]);
});

test("a replayed event or an overlapping page changes nothing", () => {
  reset();
  const events = log(user("m1", "r1"), state("r1", "running"), text("r1", "Hi"), text("r1", " there"));
  const whole = foldLogEvents(emptyLog(), events);
  assert.equal(foldLog(whole, events[2]), whole, "the same object: nothing changed");
  const overlapped = foldLogEvents(foldLogEvents(emptyLog(), events.slice(0, 3)), events);
  assert.deepEqual(overlapped, whole);
  assert.equal(projectLog(overlapped).messages[1].content, "Hi there");
});

test("reload equals live: folding the whole log equals folding it in any chunks", () => {
  reset();
  const events = log(
    user("m1", "r1"), state("r1", "running"), thinking("r1", 0, "start"), thinking("r1", 0, "delta", { delta: "a" }), thinking("r1", 0, "end", { content: "ab" }),
    text("r1", "A"), tool("r1", "t1", "requested"), ["message.queued", { id: "m2", run_id: "r1", content: "m2" }], tool("r1", "t1", "completed"),
    user("m2", "r1"), text("r1", "B"), ["compaction.started", { compaction_id: "c1", run_id: "r1" }], ["compaction.ended", { compaction_id: "c1", run_id: "r1" }],
    text("r1", " more"), state("r1", "completed"), user("m3", "r2"), state("r2", "failed", { failure: { code: "x", message: "boom" } }));
  const whole = projectLog(foldLogEvents(emptyLog(), events));
  for (let seed = 1; seed <= 40; seed += 1) {
    let chunked = emptyLog();
    let cursor = 0;
    let roll = seed;
    while (cursor < events.length) {
      roll = (roll * 1103515245 + 12345) % 2147483648;
      const size = 1 + (roll % 5);
      // A chunk may overlap what is already folded: a resume from an older position.
      const from = Math.max(0, cursor - (roll % 3));
      chunked = foldLogEvents(chunked, events.slice(from, cursor + size));
      cursor += size;
    }
    assert.deepEqual(projectLog(chunked), whole, `seed ${seed}`);
  }
  assert.deepEqual(shape(whole.messages), ["user:m1", 'reply:thinking,"A",tool', "user:m2", 'reply:"B more"', "user:m3"]);
  assert.deepEqual(whole.failed, { runId: "r2", failure: { code: "x", message: "boom" } });
  assert.deepEqual(whole.compactions, [{ id: "compaction-c1", runId: "r1" }]);
});

test("a superseded interrupted reply is hidden; an interrupted one the server is answering again is working until the time lapses", () => {
  reset();
  const base = log(user("m1", "r1"), state("r1", "running"), text("r1", "partial"), state("r1", "interrupted"));
  const retrying = foldLogEvents(emptyLog(), [...base, ...log(["run.retrying", { run_id: "r1", until: "2026-01-01T00:01:00Z" }])]);
  const within = projectLog(retrying, { now: Date.parse("2026-01-01T00:00:30Z") });
  assert.equal(within.activeRun, "r1");
  assert.equal(within.failed, null);
  assert.deepEqual(shape(within.messages), ["user:m1", 'reply:"partial"*']);
  const lapsed = projectLog(retrying, { now: Date.parse("2026-01-01T00:02:00Z") });
  assert.equal(lapsed.activeRun, null);
  assert.deepEqual(shape(lapsed.messages), ["user:m1", 'reply:"partial"'], "the partial reply stays, quietly");
  const started = projectLog(foldLogEvents(retrying, log(["run.superseded", { run_id: "r1", by: "r2" }], state("r2", "running"), text("r2", "Again"))), { now: Date.parse("2026-01-01T00:00:30Z") });
  assert.deepEqual(shape(started.messages), ["user:m1", 'reply:"Again"*']);
  assert.equal(started.activeRun, "r2");
});

test("a failed latest Run is the failure to offer; an answer again, a cancel or an interruption is none", () => {
  reset();
  const failed = foldLogEvents(emptyLog(), log(user("m1", "r1"), state("r1", "failed", { failure: { code: "x" } })));
  assert.equal(projectLog(failed).failed.runId, "r1");
  assert.equal(projectLog(foldLogEvents(failed, log(state("r2", "running")))).failed, null);
  assert.equal(projectLog(foldLogEvents(emptyLog(), log(user("m1", "r1"), state("r1", "cancelled")))).failed, null);
  assert.equal(projectLog(foldLogEvents(emptyLog(), log(user("m1", "r1"), state("r1", "interrupted")))).failed, null);
});

test("compaction: open from its start to its end, or while a Run says compacting; an aborted one leaves no chip", () => {
  reset();
  const open = foldLogEvents(emptyLog(), log(["compaction.started", { compaction_id: "c1" }]));
  assert.equal(projectLog(open).compacting, true);
  const aborted = foldLogEvents(open, log(["compaction.ended", { compaction_id: "c1", aborted: true }]));
  assert.deepEqual([projectLog(aborted).compacting, projectLog(aborted).compactions], [false, []]);
  const running = projectLog(foldLogEvents(emptyLog(), log(user("m1", "r1"), state("r1", "compacting"))));
  assert.deepEqual([running.compacting, running.runState], [true, "compacting"]);
});

test("a reply written before the log carried parts is one whole reply, in the order of its parts", () => {
  reset();
  const events = log(user("m1", "r1"), ["assistant.reply", { run_id: "r1", id: "a1", entries: [{ kind: "text", content: "A" }, { kind: "tool", tool: { tool_call_id: "t1", name: "read", status: "completed" } }, { kind: "text", content: "B" }, { kind: "thinking", content: "hm" }] }], state("r1", "completed"));
  const projected = projectLog(foldLogEvents(emptyLog(), events));
  assert.deepEqual(shape(projected.messages), ["user:m1", 'reply:"A",tool,"\\n\\nB",thinking']);
  assert.equal(projected.messages[1].id, "a1");
  assert.equal(projected.activeRun, null);
});

test("a reply the output guard blocked shows none of its words", () => {
  reset();
  const projected = projectLog(foldLogEvents(emptyLog(), log(user("m1", "r1"), state("r1", "running"), text("r1", "secret"), tool("r1", "t1", "completed"), ["reply.blocked", { run_id: "r1" }], state("r1", "completed"))));
  assert.deepEqual(shape(projected.messages), ["user:m1", "reply:tool"]);
});

test("events of positions the page never saw (internal rows) are tolerated, and earlier turns join in front", () => {
  reset();
  const older = foldLogEvents(emptyLog(), log(user("m0", "r0"), state("r0", "interrupted"), text("r0", "old"), state("r0", "interrupted")));
  position += 7;
  const later = foldLogEvents(emptyLog(), log(["run.superseded", { run_id: "r0", by: "r9" }], user("m1", "r1"), state("r1", "completed"), text("r1", "new")));
  const merged = projectLog(mergeOlderLog(later, older));
  assert.deepEqual(shape(merged.messages), ["user:m0", "user:m1", 'reply:"new"']);
  assert.equal(foldLog(later, { position: later.position + 3, type: "something.new" }).position, later.position + 3);
});
