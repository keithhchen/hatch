import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { InMemoryConversationRepository, PostgresConversationRepository, type ConversationRepository } from "./conversationRepository.js";
import { FilePrompts, PostgresPrompts, PROMPT_FILES } from "./prompts.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

async function withBackend(name: "memory" | "postgres", body: (repository: ConversationRepository, pool?: Pool) => Promise<void>): Promise<void> {
  if (name === "memory") {
    const repository = new InMemoryConversationRepository();
    try { await body(repository); } finally { await repository.close(); }
    return;
  }
  const schema = `title_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, statement_timeout: 10_000 });
    await body(new PostgresConversationRepository(pool), pool);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

for (const backend of ["memory", "postgres"] as const) {
  const options = backend === "postgres" ? { skip: !databaseUrl, timeout: 30_000 } : {};

  test(`${backend}: setTitleIfUnset names a conversation once, and returns it only for the call that wrote`, options, async () => withBackend(backend, async repository => {
    const { conversation } = await repository.createConversation({ ...binding, id: "c1", publicId: "pub1" });
    assert.equal(conversation.title, undefined);
    const first = await repository.setTitleIfUnset("c1", "First");
    assert.equal(first?.title, "First");
    assert.equal(first?.publicId, "pub1");
    assert.equal(await repository.setTitleIfUnset("c1", "Second"), undefined);
    assert.equal((await repository.getConversation("c1"))?.title, "First");
    assert.equal(await repository.setTitleIfUnset("missing", "x"), undefined);
  }));

  test(`${backend}: two writers at once write once`, options, async () => withBackend(backend, async repository => {
    await repository.createConversation({ ...binding, id: "c1", publicId: "pub1" });
    const written = await Promise.all(Array.from({ length: 8 }, (_, i) => repository.setTitleIfUnset("c1", `Title ${i}`)));
    const winners = written.filter(Boolean);
    assert.equal(winners.length, 1, "exactly one write");
    assert.equal((await repository.getConversation("c1"))?.title, winners[0]!.title);
  }));

  test(`${backend}: a title that exists, however it was set, is never overwritten; a rename still replaces a generated one`, options, async () => withBackend(backend, async repository => {
    await repository.createConversation({ ...binding, id: "named", publicId: "pub-named", title: "Chosen at creation" });
    assert.equal(await repository.setTitleIfUnset("named", "Generated"), undefined);
    await repository.createConversation({ ...binding, id: "renamed", publicId: "pub-renamed", clientRequestId: "r2" });
    await repository.updateConversation("renamed", { title: "By the user" });
    assert.equal(await repository.setTitleIfUnset("renamed", "Generated"), undefined);
    assert.equal((await repository.getConversation("renamed"))?.title, "By the user");
    // A rename that read the conversation before the title was generated applies over it: the version is not bumped by a generated title.
    await repository.createConversation({ ...binding, id: "late", publicId: "pub-late", clientRequestId: "r3" });
    const seen = (await repository.getConversation("late"))!;
    await repository.setTitleIfUnset("late", "Generated");
    const renamed = await repository.updateConversation("late", { title: "By the user", expectedVersion: seen.version });
    assert.equal(renamed.title, "By the user");
    // A cleared title (null) makes the conversation eligible again.
    await repository.updateConversation("late", { title: null });
    assert.equal((await repository.setTitleIfUnset("late", "Generated again"))?.title, "Generated again");
  }));
}

test("postgres: the title is written by one conditional UPDATE, not a read and a write", { skip: !databaseUrl, timeout: 30_000 }, async () => withBackend("postgres", async (repository, pool) => {
  await repository.createConversation({ ...binding, id: "c1", publicId: "pub1" });
  const statements: string[] = [];
  const spy = Object.assign(Object.create(pool!), { query: (text: string, values?: unknown[]) => { statements.push(String(text)); return pool!.query(text, values); } }) as Pool;
  const spied = new PostgresConversationRepository(spy);
  await spied.setTitleIfUnset("c1", "Once");
  assert.ok(statements.some(text => /UPDATE hatch_conversations SET title = \$2 WHERE id = \$1 AND title IS NULL/.test(text)), statements.join("\n"));
  assert.equal(statements.filter(text => /^\s*SELECT/i.test(text)).length, 0);
}));

// ── the prompt the title model is given ────────────────────────────────

test("the title prompt file is the default instruction", async () => {
  const body = await new FilePrompts().get("conversation-title");
  assert.match(body, /Answer with the title only/);
  assert.equal(PROMPT_FILES["conversation-title"], "conversation-title/TITLE.md");
});

test("postgres: the prompt is seeded from its file once, read from the table, and an edited row is never overwritten", { skip: !databaseUrl, timeout: 30_000 }, async () => withBackend("postgres", async (_repository, pool) => {
  const prompts = new PostgresPrompts(pool!);
  assert.equal(await prompts.get("conversation-title"), await new FilePrompts().get("conversation-title"));
  await pool!.query("UPDATE hatch_prompts SET body = $1 WHERE name = 'conversation-title'", ["Edited in the database"]);
  assert.equal(await prompts.get("conversation-title"), "Edited in the database", "read at each use");
  assert.equal(await new PostgresPrompts(pool!).get("conversation-title"), "Edited in the database", "a later boot keeps the edit");
  await pool!.query("UPDATE hatch_prompts SET body = '  ' WHERE name = 'conversation-title'");
  await assert.rejects(prompts.get("conversation-title"), /no prompt named conversation-title/);
}));
