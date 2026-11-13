import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import type { RunContext } from "./agentRuntime.js";
import { MODEL_ROLES, MODEL_ROLE_NAMES, PostgresModelRoleResolver } from "./modelRoles.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import type { RunStart } from "./protocol.js";
import { createPool } from "./postgresPool.js";

const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;
const skip = !databaseUrl;

async function withPool(work: (pool: Pool) => Promise<void>): Promise<void> {
  const pool = createPool({ connectionString: databaseUrl, max: 6 });
  try {
    await pool.query("DROP TABLE IF EXISTS hatch_model_roles");
    await pool.query("DROP TABLE IF EXISTS hatch_product_models");
    await work(pool);
  } finally {
    await pool.end();
  }
}

const rolesOf = async (pool: Pool) => Object.fromEntries((await pool.query("SELECT role, profile FROM hatch_model_roles ORDER BY role")).rows.map(row => [row.role, row.profile]));

test("first use creates the tables and seeds every role; concurrent boots and later boots change nothing", { skip }, async () => {
  await withPool(async pool => {
    const boots = Array.from({ length: 4 }, () => new PostgresModelRoleResolver(pool));
    await Promise.all(boots.map(resolver => resolver.resolve("chat")));
    assert.deepEqual(await rolesOf(pool), Object.fromEntries(MODEL_ROLE_NAMES.map(role => [role, MODEL_ROLES[role]]).sort()));
    // The database rules once a row exists: a boot never writes a seed over it.
    await pool.query("UPDATE hatch_model_roles SET profile = 'gemini-api' WHERE role = 'chat'");
    await pool.query("DELETE FROM hatch_model_roles WHERE role = 'ingest'");
    await new PostgresModelRoleResolver(pool).resolve("assistant");
    const roles = await rolesOf(pool);
    assert.equal(roles.chat, "gemini-api");
    assert.equal(roles.ingest, MODEL_ROLES.ingest, "a missing row is seeded again");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_model_roles")).rows[0].n, MODEL_ROLE_NAMES.length);
  });
});

test("the roles and a product override are read from the tables, the override for that product's chat only", { skip }, async () => {
  await withPool(async pool => {
    let now = 0;
    const resolver = new PostgresModelRoleResolver(pool, { now: () => now });
    assert.equal((await resolver.resolve("chat")).name, "kimi-k3.1-pro");
    await pool.query("UPDATE hatch_model_roles SET profile = 'gemini-api', updated_at = now() WHERE role = 'chat'");
    await pool.query("INSERT INTO hatch_product_models (product_id, profile) VALUES ('b9e0c5b6-3f6d-4a8e-9b53-9d2a3c6c3a11', 'deepseek-v4-pro')");
    assert.equal((await resolver.resolve("chat")).name, "kimi-k3.1-pro", "cached for 30 s");
    now += 30_000;
    assert.equal((await resolver.resolve("chat")).name, "gemini-api");
    assert.equal((await resolver.resolve("chat", { productId: "b9e0c5b6-3f6d-4a8e-9b53-9d2a3c6c3a11" })).name, "deepseek-v4-pro");
    assert.equal((await resolver.resolve("chat", { productId: "another" })).name, "gemini-api");
    assert.equal((await resolver.resolve("assistant", { productId: "b9e0c5b6-3f6d-4a8e-9b53-9d2a3c6c3a11" })).name, "gemini-api");
  });
});

const completion = (model: string) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

test("changing a row moves the next Run to the new model with no restart; a Run keeps the one it began with", { skip }, async (t) => {
  await withPool(async pool => {
    const requests: Array<{ url: string; model: string }> = [];
    t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model as string;
      requests.push({ url: String(url), model });
      return new Response(completion(model), { headers: { "content-type": "text/event-stream" } });
    });
    // One process lifetime: one runtime, one resolver. Only the database changes.
    const runtime = new PiAgentRuntime({
      models: new PostgresModelRoleResolver(pool, { cacheMs: 0 }),
      toolDefinitions: [],
      env: { LLM_API_KEY: "kimi-test", DEEPSEEK_API_KEY: "deepseek-test", GEMINI_API_KEY: "gemini-test" }
    });
    const run = async (n: number, productId?: string) => {
      const input = { type: "client.message", run_id: `run-${n}`, conversation_id: `conv-${n}`, message: { role: "user", content: "hi" } } as RunStart;
      const events = [];
      for await (const event of runtime.run(input, {
        state: { status: "running" }, ...(productId ? { productId } : {}),
        messages: [{ role: "user", content: "hi" }],
        sessionSkills: { records: [], visibleRecords: [], rendered: { section: "", aliases: {}, report: { total_count: 0, included_count: 0, omitted_count: 0, truncated_description_chars: 0, truncated_description_count: 0 } } },
        clientTools: []
      } as unknown as RunContext)) events.push(event);
      assert.ok(events.some(event => event.type === "turn.completed"), JSON.stringify(events.at(-1)));
    };

    await run(1);
    assert.equal(requests.at(-1)?.model, "kimi-k3.1-pro");
    assert.match(requests.at(-1)!.url, /moonshot/);

    await pool.query("UPDATE hatch_model_roles SET profile = 'deepseek-v4-pro' WHERE role = 'chat'");
    await run(2);
    assert.equal(requests.at(-1)?.model, "deepseek-v4-pro");
    assert.match(requests.at(-1)!.url, /deepseek/);

    await pool.query("INSERT INTO hatch_product_models (product_id, profile) VALUES ('product-a', 'kimi-k3.1-pro')");
    await run(3, "product-a");
    assert.equal(requests.at(-1)?.model, "kimi-k3.1-pro", "the product override wins over the role");
    await run(4, "product-b");
    assert.equal(requests.at(-1)?.model, "deepseek-v4-pro", "another product follows the role");

    // A bad row fails the Run loudly, whatever the other roles say.
    await pool.query("UPDATE hatch_model_roles SET profile = 'not-a-model' WHERE role = 'chat'");
    const before = requests.length;
    const log = console.error;
    console.error = () => undefined;
    try {
      await assert.rejects(run(5), (error: unknown) => (error as { code?: string }).code === "model_profile_invalid");
    } finally { console.error = log; }
    assert.equal(requests.length, before, "no request went to any model");
  });
});
