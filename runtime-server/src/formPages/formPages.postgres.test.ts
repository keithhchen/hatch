import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { PostgresFormRepository } from "./repository.js";
import { formConformance } from "./formKit.js";

// Opt-in integration tests. Every test owns a random schema, never a database.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;

async function isolated() {
  const schema = `forms_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, statement_timeout: 10_000, max: 8 });
  return { repository: await PostgresFormRepository.open(pool), close: async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); } };
}

if (connectionString) formConformance("Postgres forms", isolated);
else test("Postgres forms need HATCH_TEST_DATABASE_URL", { skip: true }, () => undefined);
