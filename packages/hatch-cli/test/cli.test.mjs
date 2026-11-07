import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { FileCredentialStore } from "../src/credentialStore.js";
import { CommandRegistry } from "../src/registry.js";
import { COMMANDS } from "../src/commands.js";
import { McpServer, PROTOCOL_VERSION } from "../src/mcp.js";
import { fakeFetch, makeContext, ME, sink } from "./helpers.mjs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

async function runCli(argv, { routes = {}, env = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), "hatch-cli-"));
  const deps = { env, fetch: fakeFetch(routes), home, cwd: home, store: FileCredentialStore.atHome(home), browser: { open() {} },
    stdin: new PassThrough(), stdout: sink(), stderr: sink() };
  const code = await main(argv, deps);
  return { code, out: deps.stdout.text(), err: deps.stderr.text(), home };
}

test("--help lists commands; unknown command exits 2", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /products list/);
  assert.equal((await runCli(["bogus"])).code, 2);
});

test("whoami without credentials says to run hatch login", async () => {
  const r = await runCli(["whoami"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /hatch login/);
  const j = await runCli(["whoami", "--json"]);
  assert.equal(JSON.parse(j.err).error.code, "not_signed_in");
});

test("products list --json and human output via HATCH_API_KEY", async () => {
  const routes = { "GET /v1/creator/products": { products: [{ product_id: "p1", name: "Alpha", status: "draft" }] } };
  const j = await runCli(["products", "list", "--json"], { routes, env: { HATCH_API_KEY: "k" } });
  assert.equal(JSON.parse(j.out)[0].product_id, "p1");
  const h = await runCli(["products", "list"], { routes, env: { HATCH_API_KEY: "k" } });
  assert.match(h.out, /p1 .*Alpha/);
});

test("401 from server surfaces 'run hatch login'", async () => {
  const r = await runCli(["products", "list"], { routes: { "GET /v1/creator/products": () => new Response("{}", { status: 401 }) }, env: { HATCH_API_KEY: "k" } });
  assert.equal(r.code, 1);
  assert.match(r.err, /hatch login/);
});

test("install-skill copies SKILL.md into the target dir", async () => {
  const r = await runCli(["install-skill", "-g"]);
  assert.equal(r.code, 0);
  assert.match(await readFile(join(r.home, ".agents", "skills", "hatch", "SKILL.md"), "utf8"), /name: hatch/);
});

async function rpc(messages, routes = {}) {
  const { ctx } = await makeContext({ routes, env: { HATCH_API_KEY: "k" } });
  const server = new McpServer(ctx, new CommandRegistry(COMMANDS));
  const input = new PassThrough(), output = sink();
  const done = server.serve(input, output);
  for (const m of messages) input.write(`${JSON.stringify(m)}\n`);
  input.end();
  await done;
  return output.text().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("MCP: initialize, tools/list, tools/call over in-memory streams", async () => {
  const replies = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "products_show", arguments: { product_id: "zz" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "login", arguments: {} } },
    { jsonrpc: "2.0", id: 6, method: "nope" }
  ], { "GET /v1/auth/me": ME });
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.equal(replies.length, 6); // the notification gets no reply
  assert.equal(byId[1].result.protocolVersion, "2025-06-18");
  assert.deepEqual(byId[2].result.tools.map((t) => t.name).sort(), [
    "ingest_list", "ingest_status", "ingest_submit", "products_create", "products_list", "products_show", "products_unlist", "products_update", "whoami"
  ]);
  assert.equal(JSON.parse(byId[3].result.content[0].text).account.email, "k@example.com");
  assert.equal(byId[4].result.isError, true); // 404 from fake server
  assert.equal(byId[5].error.code, -32602);
  assert.equal(byId[6].error.code, -32601);
});
