import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { Pool } from "pg";
import { FailureBoundary, type FailureRecord } from "../errors/failures.js";
import { timedQueries } from "../postgresPool.js";
import { bindContext, runInContext } from "./context.js";
import { observed, propagatingFetch } from "./http.js";
import { Logger, StdoutJsonSink, type LogEntry } from "./log.js";

const capture = () => {
  const entries: LogEntry[] = [];
  return { entries, log: new Logger(() => [{ write: (entry) => { entries.push(entry); } }], {}, () => "registry") };
};
const quiet = <T>(work: () => T): T => { const original = console.error; console.error = () => undefined; try { return work(); } finally { console.error = original; } };

test("a request id sent by the dashboard is the id in the access line, the failure scope, and the outbound call", async () => {
  const { entries, log } = capture();
  const records: FailureRecord[] = [];
  const boundary = new FailureBoundary();
  boundary.attach({ record: async (record) => { records.push(record); } });
  const forwarded: Array<string | null> = [];
  const outbound = propagatingFetch((async (_url: unknown, init?: RequestInit) => { forwarded.push(new Headers(init?.headers).get("x-request-id")); return new Response(""); }) as typeof fetch);
  const server = http.createServer(observed((_request, response) => {
    bindContext({ account_id: "acct_1" });
    void outbound("http://runtime.local/x").then(() => {
      quiet(() => boundary.translate(new Error("boom"), { run: "run_1" }));
      response.statusCode = 502;
      response.end("{}");
    });
  }, log));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/things?token=secret`, { headers: { "x-request-id": "req_dashboard_1" } });
    await response.text();
    assert.equal(response.headers.get("x-request-id"), "req_dashboard_1");
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally { await new Promise((resolve) => server.close(resolve)); }
  assert.deepEqual(forwarded, ["req_dashboard_1"]);
  assert.equal(records[0]!.scope.request_id, "req_dashboard_1");
  assert.equal(records[0]!.scope.account, "acct_1");
  assert.equal(records[0]!.scope.run, "run_1");
  assert.equal(entries.length, 1);
  const { fields, event, level, service } = entries[0]!;
  assert.deepEqual({ event, level, service }, { event: "access", level: "info", service: "registry" });
  assert.deepEqual({ ...fields, duration_ms: typeof fields.duration_ms }, {
    request_id: "req_dashboard_1", account_id: "acct_1", method: "GET", path: "/v1/things", status: 502, duration_ms: "number"
  });
});

test("a request without an id is given one", async () => {
  const server = http.createServer(observed((_request, response) => response.end("x"), capture().log));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    assert.match(response.headers.get("x-request-id")!, /^req_[0-9a-f]{16}$/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("a slow query and a failed query are logged with the request id and the statement, never its parameters", async () => {
  const { entries, log } = capture();
  const pool = { query: async (text: string, values?: unknown[]) => { if (text.startsWith("BAD")) throw new Error("syntax error"); await new Promise((resolve) => setTimeout(resolve, 30)); return { rows: values }; } } as unknown as Pool;
  timedQueries(pool, log, 10);
  await runInContext({ request_id: "req_db" }, async () => {
    await pool.query("SELECT   *\n FROM accounts WHERE token = $1", ["hunter2"]);
    await assert.rejects(pool.query("BAD " + "x".repeat(300), ["hunter2"]));
  });
  assert.deepEqual(entries.map((entry) => [entry.level, entry.event, entry.fields.request_id]), [["warn", "db_slow_query", "req_db"], ["error", "db_query_error", "req_db"]]);
  assert.equal(entries[0]!.fields.statement, "SELECT * FROM accounts WHERE token = $1");
  assert.equal((entries[1]!.fields.statement as string).length, 200);
  assert.doesNotMatch(JSON.stringify(entries), /hunter2/);
});

test("a fast query is not logged", async () => {
  const { entries, log } = capture();
  const pool = timedQueries({ query: async () => ({ rows: [] }) } as unknown as Pool, log, 500);
  await pool.query("SELECT 1");
  assert.equal(entries.length, 0);
});

test("a stdout log line inside an active span carries its trace_id and span_id, and none outside", () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    const entry: LogEntry = { ts: "2026-01-01T00:00:00.000Z", level: "info", event: "x", fields: {} };
    const sink = new StdoutJsonSink();
    sink.write(entry);
    const span = trace.wrapSpanContext({ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: 1 });
    context.with(trace.setSpan(context.active(), span), () => sink.write(entry));
  } finally { console.log = original; context.disable(); }
  assert.equal(JSON.parse(lines[0]).trace_id, undefined);
  assert.equal(JSON.parse(lines[1]).trace_id, "0af7651916cd43dd8448eb211c80319c");
  assert.equal(JSON.parse(lines[1]).span_id, "b7ad6b7169203331");
});
