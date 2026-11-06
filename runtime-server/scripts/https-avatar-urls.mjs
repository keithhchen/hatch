#!/usr/bin/env node
// One-off: rewrite accounts.avatar_url from http://<bucket host>/ to
// https://<bucket host>/ for the avatar bucket only. Dry run by default.
//
//   HATCH_REGISTRY_DATABASE_URL=… HATCH_CREATOR_OBJECT_STORE_BUCKET=… \
//   HATCH_CREATOR_OBJECT_STORE_REGION=oss-cn-shanghai \
//   node scripts/https-avatar-urls.mjs [--apply]
import pg from "pg";

const apply = process.argv.includes("--apply");
const databaseUrl = process.env.HATCH_REGISTRY_DATABASE_URL?.trim();
const bucket = process.env.HATCH_CREATOR_OBJECT_STORE_BUCKET?.trim();
const region = process.env.HATCH_CREATOR_OBJECT_STORE_REGION?.trim() || "oss-cn-shanghai";
if (!databaseUrl || !bucket) {
  console.error("HATCH_REGISTRY_DATABASE_URL and HATCH_CREATOR_OBJECT_STORE_BUCKET are required");
  process.exit(2);
}

const host = `${bucket}.${region}.aliyuncs.com`;
const from = `http://${host}/`;
const to = `https://${host}/`;
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const matching = `avatar_url LIKE $1 || '%'`;
  const { rows: [counts] } = await pool.query(
    `SELECT count(*) FILTER (WHERE ${matching})::int AS http, count(*) FILTER (WHERE avatar_url LIKE $2 || '%')::int AS https FROM accounts`,
    [from, to]
  );
  console.log(`${host}: ${counts.http} http, ${counts.https} https avatar URLs`);
  if (!apply) {
    console.log("Dry run. Re-run with --apply to rewrite.");
  } else {
    const { rowCount } = await pool.query(
      `UPDATE accounts SET avatar_url = $2 || substr(avatar_url, length($1) + 1) WHERE ${matching}`,
      [from, to]
    );
    console.log(`Rewrote ${rowCount} avatar URLs to ${to}`);
  }
} finally {
  await pool.end();
}
