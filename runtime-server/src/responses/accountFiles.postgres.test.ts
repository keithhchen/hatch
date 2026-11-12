import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresAccountFiles } from "./accountFiles.js";

// Opt-in integration test. It owns a random schema, never a database.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;

test("account files: stored per account, listed newest first, deleted, never shown to another account", { skip: !connectionString, timeout: 60_000 }, async () => {
  const schema = `account_files_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const files = new PostgresAccountFiles(pool);
    await files.initialize();
    await files.initialize();
    const first = await files.put("a", { filename: "one.txt", purpose: "user_data", content: Buffer.from("one") });
    const second = await files.put("a", { filename: "two.bin", purpose: "user_data", content: Buffer.from([0, 1, 2, 255]) });
    assert.match(first.id, /^file_[0-9a-f]{24}$/);
    assert.deepEqual((await files.list("a")).map((file) => file.filename), ["two.bin", "one.txt"]);
    assert.equal((await files.get("a", first.id))?.bytes, 3);
    assert.deepEqual(await files.content("a", second.id), Buffer.from([0, 1, 2, 255]));
    assert.equal(await files.get("b", first.id), undefined);
    assert.equal(await files.content("b", first.id), undefined);
    assert.equal(await files.delete("b", first.id), false);
    assert.deepEqual(await files.list("b"), []);
    assert.equal(await files.delete("a", first.id), true);
    assert.equal(await files.get("a", first.id), undefined);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
