/**
 * The advisory lock every schema change takes. Two processes booting side by side (a deploy starts the new container before
 * the old one stops) would otherwise race `CREATE ... IF NOT EXISTS` into a catalog error; the second waits, then finds the
 * schema already there. runtime-server's `serializedSchema` takes the same key.
 */
export const SCHEMA_LOCK_KEY = 718263411;

/** Runs the schema statements in one transaction under the schema lock. */
export async function withSchemaLock(pool, statements) {
  if (typeof pool.connect !== "function") {
    for (const statement of statements) await pool.query(statement);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_KEY]);
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release?.();
  }
}
