import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { InMemoryModelRoleResolver, PostgresModelRoleResolver } from "../modelRoles.js";
import { roleTitleModel } from "./titleModel.js";

const stream = (text: string) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
const env = { DEEPSEEK_API_KEY: "deepseek-test", GEMINI_API_KEY: "gemini-test", LLM_API_KEY: "kimi-test" };

test("the title model is one completion on the profile the title role names, with the prompt as system and the input as the user's message", async t => {
  const bodies: Array<{ url: string; body: { model: string; messages: Array<{ role: string; content: string }> } }> = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    bodies.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(stream("Tokyo trip, 5 days"), { headers: { "content-type": "text/event-stream" } });
  });
  const roles = new InMemoryModelRoleResolver({ roles: { title: "deepseek-v4-flash" } });
  const title = await roleTitleModel(roles, env)({ system: "Name it.", user: "Plan a trip", signal: new AbortController().signal });
  assert.equal(title, "Tokyo trip, 5 days");
  assert.match(bodies[0]!.url, /deepseek/);
  assert.equal(bodies[0]!.body.model, "deepseek-v4-flash");
  assert.deepEqual(bodies[0]!.body.messages.map(m => [m.role, m.content]), [["system", "Name it."], ["user", "Plan a trip"]]);
});

test("a provider failure is an error for the caller, not an empty title", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("overloaded", { status: 503 }));
  const model = roleTitleModel(new InMemoryModelRoleResolver({ roles: { title: "deepseek-v4-flash" } }), { ...env });
  await assert.rejects(model({ system: "s", user: "u", signal: AbortSignal.timeout(5_000) }));
});

test("without a database the title role is a seed row on the flash-class Gemini profile", async () => {
  assert.equal((await new InMemoryModelRoleResolver().resolve("title")).name, "gemini-api");
});

const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;
test("postgres: the title role is seeded, and an UPDATE switches it, like every other role", { skip: !databaseUrl, timeout: 30_000 }, async () => {
  const schema = `title_roles_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
    const resolver = new PostgresModelRoleResolver(pool, { cacheMs: 0 });
    assert.equal((await resolver.resolve("title")).name, "gemini-api");
    await pool.query("UPDATE hatch_model_roles SET profile = 'deepseek-v4-flash' WHERE role = 'title'");
    assert.equal((await resolver.resolve("title")).name, "deepseek-v4-flash");
    await pool.query("UPDATE hatch_model_roles SET profile = 'kimi-k3.1-pro-highspeed' WHERE role = 'title'");
    assert.equal((await resolver.resolve("title")).name, "kimi-k3.1-pro-highspeed", "any catalogue profile");
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
