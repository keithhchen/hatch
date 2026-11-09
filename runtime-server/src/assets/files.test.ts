import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTool, orderTools } from "../surfaces/contract.js";
import type { AssetScope } from "./domain.js";
import { AttachmentFiles, FILE_LIMITS } from "./files.js";
import { contact, harness, png, scopeA, scopeB } from "./kit.test.js";
import { attachmentTools } from "./tools.js";

async function setup() {
  const kit = await harness();
  const files = new AttachmentFiles(kit.repository, kit.blobs);
  const put = async (scope: AssetScope, message: string, name: string, bytes: Buffer) => {
    const asset = await kit.pipeline.accept(scope, { name, bytes });
    await kit.pipeline.attach(scope, asset.id, message);
    return asset;
  };
  return { ...kit, files, put, tools: new Map(attachmentTools(files).map(t => [t.name, t])) };
}

const lines = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i)).join("\n");

test("ls shows messages, then files, and marks what has no text", async () => {
  const { files, put } = await setup();
  await put(scopeA, "m1", "notes.md", Buffer.from("alpha\nbeta"));
  await put(scopeA, "m1", "pic.png", await png());
  await put(scopeA, "m2", "b.txt", Buffer.from("x"));
  assert.match(await files.ls(scopeA), /m1\/ {2}\(2 files\)\nm2\/ {2}\(1 files\)/);
  const listing = await files.ls(scopeA, "/attachments/m1");
  assert.match(listing, /\/attachments\/m1\/notes\.md {2}text\/markdown {2}10 bytes\n/);
  assert.match(listing, /pic\.png {2}image\/png {2}\d+ bytes {2}\(not text\)/);
  assert.match(await files.ls(scopeA, "/attachments/m1/notes.md"), /notes\.md/);
});

test("scopes are isolated by account, conversation, connection and contact", async () => {
  const { files, put } = await setup();
  await put(scopeA, "m1", "secret.txt", Buffer.from("account one secret"));
  const c1 = contact("conn-1", "alice");
  await put(c1, "m1", "alice.txt", Buffer.from("alice private"));
  const others: AssetScope[] = [scopeB, { ...scopeA, conversationId: "conv-2" }, contact("conn-1", "bob"), contact("conn-2", "alice"), contact("conn-1", "alice", "conv-2")];
  for (const scope of others) {
    assert.equal(await files.ls(scope), "(empty)");
    await assert.rejects(files.read(scope, "/attachments/m1/secret.txt"), /No such file/);
    await assert.rejects(files.read(scope, "/attachments/m1/alice.txt"), /No such file/);
    assert.equal(await files.grep(scope, { pattern: "secret", fixed: true }), "No matches");
  }
  assert.match(await files.grep(c1, { pattern: "private", fixed: true }), /alice\.txt:1: alice private/);
  assert.equal(await files.grep(c1, { pattern: "secret", fixed: true }), "No matches");
});

test("paths outside the scope or the attachments root fail", async () => {
  const { files, put } = await setup();
  await put(scopeA, "m1", "a.txt", Buffer.from("hello"));
  for (const bad of ["/etc/passwd", "/", "attachments/m1/a.txt", "/attachments/../etc/passwd", "/attachments/m1/../m1/a.txt", "/attachments//m1/a.txt", "/attachments/m1/a.txt/x", "/attachments/m1\\a.txt", "/attachments/m1/a\0.txt", "/attachments/m1/./a.txt"]) {
    await assert.rejects(files.read(scopeA, bad), /Invalid path|inside \/attachments|No such file/, bad);
    await assert.rejects(files.ls(scopeA, bad), /Invalid path|inside \/attachments|No such file/, bad);
    await assert.rejects(files.grep(scopeA, { pattern: "h", path: bad }), /Invalid path|inside \/attachments|No such file/, bad);
  }
  await assert.rejects(files.read(scopeA, "/attachments/m1"), /read needs a file path/);
});

test("read pages by offset with a limit and a next-offset pointer", async () => {
  const { files, put } = await setup();
  const text = lines(100, i => `line ${i}`);
  await put(scopeA, "m1", "big.txt", Buffer.from(text));
  let offset = 0;
  let rebuilt = "";
  for (let guard = 0; guard < 100; guard++) {
    const page = await files.read(scopeA, "/attachments/m1/big.txt", offset, 120);
    assert.ok(page.content.length <= 120);
    rebuilt += page.content;
    if (page.next_offset === null) break;
    offset = page.next_offset;
  }
  assert.equal(rebuilt, text);
  const capped = await files.read(scopeA, "/attachments/m1/big.txt", 0, 10_000_000);
  assert.ok(capped.content.length <= FILE_LIMITS.readCharsMax);
  const past = await files.read(scopeA, "/attachments/m1/big.txt", 99999);
  assert.deepEqual([past.content, past.next_offset], ["", null]);
  await assert.rejects(files.read(scopeA, "/attachments/m1/big.txt", -1), /non-negative/);
});

test("read never splits a surrogate pair", async () => {
  const { files, put } = await setup();
  await put(scopeA, "m1", "emoji.txt", Buffer.from("a😀b"));
  const first = await files.read(scopeA, "/attachments/m1/emoji.txt", 0, 2);
  assert.equal(first.content, "a");
  assert.equal(first.next_offset, 1);
});

test("an image has no text form", async () => {
  const { files, put } = await setup();
  await put(scopeA, "m1", "pic.png", await png());
  await assert.rejects(files.read(scopeA, "/attachments/m1/pic.png"), /no text form/);
  assert.equal(await files.grep(scopeA, { pattern: "x" }), "No matches");
});

test("grep finds fixed strings and regular expressions with context", async () => {
  const { files, put } = await setup();
  await put(scopeA, "m1", "log.txt", Buffer.from(lines(20, i => i === 5 ? "ERROR a.b" : i === 15 ? "error aXb" : `ok ${i}`)));
  assert.equal(await files.grep(scopeA, { pattern: "a.b", fixed: true }), "/attachments/m1/log.txt:6: ERROR a.b");
  const regex = await files.grep(scopeA, { pattern: "^error a.b$", ignoreCase: true, context: 1 });
  assert.equal(regex, ["/attachments/m1/log.txt-5- ok 4", "/attachments/m1/log.txt:6: ERROR a.b", "/attachments/m1/log.txt-7- ok 6", "--", "/attachments/m1/log.txt-15- ok 14", "/attachments/m1/log.txt:16: error aXb", "/attachments/m1/log.txt-17- ok 16"].join("\n"));
  assert.equal(await files.grep(scopeA, { pattern: "ERROR", path: "/attachments/m2" }).catch(e => e.message), "No such file or directory");
});

test("grep output is bounded", async () => {
  const { files, put } = await setup();
  await put(scopeA, "m1", "many.txt", Buffer.from(lines(5000, i => `match ${i} ${"x".repeat(400)}`)));
  const out = await files.grep(scopeA, { pattern: "match", fixed: true, maxMatches: 100000, context: 99 });
  assert.ok(out.length <= FILE_LIMITS.grepOutputChars + 40);
  assert.match(out, /\[output truncated\]$/);
  assert.ok(out.split("\n").every(line => line.length < 400));
  assert.equal((await files.grep(scopeA, { pattern: "match", fixed: true, maxMatches: 3 })).split("\n").length, 3);
});

test("a catastrophic regular expression fails fast instead of hanging", async () => {
  const { files, put } = await setup();
  await put(scopeA, "m1", "evil.txt", Buffer.from(`${"a".repeat(40)}!\nsecond line`));
  const started = Date.now();
  await assert.rejects(files.grep(scopeA, { pattern: "(a+)+$" }), /took too long/);
  assert.ok(Date.now() - started < 3000);
  await assert.rejects(files.grep(scopeA, { pattern: "(" }), /Invalid regular expression/);
  await assert.rejects(files.grep(scopeA, { pattern: "a".repeat(FILE_LIMITS.patternChars + 1) }), /Pattern must be/);
  assert.match(await files.grep(scopeA, { pattern: "(a+)+$", fixed: true }), /No matches/);
  // the process is still healthy and a normal search works afterwards
  assert.match(await files.grep(scopeA, { pattern: "^second" }), /:2: second line/);
});

test("grep refuses an unbounded scan", async () => {
  const { files, put } = await setup();
  for (let i = 0; i < FILE_LIMITS.grepFiles + 1; i++) await put(scopeA, "m1", `f${i}.txt`, Buffer.from(`text ${i}`));
  await assert.rejects(files.grep(scopeA, { pattern: "text", fixed: true }), /Too many files/);
});

test("tools declare SurfaceTool metadata, validate arguments and take scope from the caller", async () => {
  const { tools, put } = await setup();
  await put(scopeA, "m1", "a.txt", Buffer.from("needle here"));
  assert.deepEqual(orderTools([...tools.values()]).map(t => t.name), ["grep", "ls", "read"]);
  for (const tool of tools.values()) {
    assert.equal(tool.supportedClients, "*");
    assert.equal(describeTool(tool), tool.description);
    assert.equal((tool.parameters as { type: string }).type, "object");
  }
  assert.match(await tools.get("grep")!.run(scopeA, { pattern: "needle", fixed: true }), /a\.txt:1: needle here/);
  assert.equal(JSON.parse(await tools.get("read")!.run(scopeA, { path: "/attachments/m1/a.txt" })).next_offset, null);
  assert.match(await tools.get("read")!.run(scopeA, { offset: 1 }), /^Error: path/);
  assert.match(await tools.get("read")!.run(scopeB, { path: "/attachments/m1/a.txt" }), /^Error: No such file/);
  assert.match(await tools.get("grep")!.run(scopeA, { pattern: "(a+)+$" }), /^(Error: .*took too long|No matches)/);
});
