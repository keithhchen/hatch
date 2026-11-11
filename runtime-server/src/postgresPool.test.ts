import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { SCHEMA_LOCK_KEY, createPool } from "./postgresPool.js";

const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

test("a pool whose idle client the server cuts off reports it and keeps serving", { skip: !databaseUrl }, async () => {
  const pool = createPool({ connectionString: databaseUrl, max: 1 });
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => { logged.push(String(line)); };
  try {
    const pid = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(logged.some((line) => line.includes("postgres_idle_client_error")));
    assert.equal((await pool.query("SELECT 1 AS one")).rows[0].one, 1);
  } finally {
    console.error = original;
    await pool.end();
    await admin.end();
  }
});

test("schema changes wait for the schema lock another process holds; ordinary queries do not", { skip: !databaseUrl }, async () => {
  const pool = createPool({ connectionString: databaseUrl, max: 4 });
  const other = new Pool({ connectionString: databaseUrl, max: 1 });
  const table = `hatch_schema_lock_${process.pid}`;
  const holder = await other.connect();
  try {
    await holder.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK_KEY]);
    let created = false;
    const pending = pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id INT)`).then(() => { created = true; });
    assert.equal((await pool.query("SELECT 1 AS one")).rows[0].one, 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(created, false);
    await holder.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK_KEY]);
    await pending;
    assert.equal(created, true);
    assert.equal((await pool.query("SELECT to_regclass($1) AS t", [table])).rows[0].t, table);
  } finally {
    holder.release();
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.end();
    await other.end();
  }
});
