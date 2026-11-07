import { cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HatchError } from "./errors.js";
import { buildIngestItems, isFinished, waitForJob } from "./ingest.js";
import { createPkce, randomState } from "./pkce.js";

// A command: { name, describe, usage, options, run(ctx, args), format?(result), mcp? }
// args = { _: positional[], flags: {} }. run returns data; format renders human text.

const need = (command, args, min) => {
  if (args._.length < min) throw new HatchError(`Usage: hatch ${command.usage}`, { code: "usage" });
  return args._;
};
const listOf = (r, ...keys) => Array.isArray(r) ? r : keys.map((k) => r?.[k]).find(Array.isArray) ?? [];
const pid = (p) => p?.product_id ?? p?.id;
const unwrapProduct = (r) => r?.product ?? r;
const productPath = (id, tail = "") => `/v1/creator/products/${encodeURIComponent(id)}${tail}`;
const productLine = (p) => `${pid(p)}  ${(p.status ?? "").padEnd(10)}  ${p.name}`;
const readAll = async (stream) => { let s = ""; for await (const c of stream) s += c; return s; };
const readAccount = (me) => { const a = me?.account ?? me ?? {}; return { id: a.id, email: a.email, display_name: a.display_name }; };

const inputLabel = (input) => typeof input === "string" ? input : input?.url ?? input?.name ?? "item";
const formatJob = (job) => [
  `job ${job.id}  ${job.status}  (product ${job.product_id})`,
  ...(job.error ? [`  error: ${job.error}`] : []),
  ...(job.items ?? []).map((i) => `  [${i.status}] ${inputLabel(i.input)}${i.markdown_path ? `  -> ${i.markdown_path}` : ""}${i.error ? `  (${i.error})` : ""}`)
].join("\n");
const jobProgress = (job) => {
  const items = job.items ?? [];
  const settled = items.filter((i) => i.status && i.status !== "queued").length;
  return `job ${job.id}: ${job.status}${items.length ? ` (${settled}/${items.length} items)` : ""}`;
};

const productIdSchema = { product_id: { type: "string", description: "Product id" } };
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

async function saveLogin(ctx, apiUrl, token, kind) {
  const me = await ctx.clientWith(token, apiUrl).get("/v1/auth/me");
  const account = readAccount(me);
  await ctx.store.put(ctx.profile, { api_url: apiUrl, token, kind, account });
  return { signed_in: true, profile: ctx.profile, kind, api_url: apiUrl, account };
}

async function browserLogin(ctx) {
  const pkce = createPkce();
  const state = randomState();
  const receiver = ctx.receiverFactory({ state });
  const redirectUri = await receiver.start();
  const url = new URL("/desktop/sign-in", ctx.webUrl);
  for (const [k, v] of Object.entries({ state, code_challenge: pkce.challenge, redirect_uri: redirectUri, client: "cli" })) url.searchParams.set(k, v);
  ctx.log(`Open this URL to sign in to Hatch:\n${url}`);
  ctx.browser.open(url.toString());
  const code = await receiver.wait();
  const { token } = await ctx.anonymousClient().post("/v1/auth/desktop/token", { code, code_verifier: pkce.verifier, redirect_uri: redirectUri });
  return saveLogin(ctx, ctx.apiUrl, token, "session");
}

const apiKeyLogin = (readKey) => async (ctx) => {
  const key = (await readKey(ctx)).trim();
  if (!key) throw new HatchError("No API key given.", { code: "usage" });
  return saveLogin(ctx, ctx.apiUrl, key, "api_key");
};

const LOGIN_METHODS = {
  browser: browserLogin,
  api_key: apiKeyLogin((ctx) => ctx.prompter.secret(`Paste an API key (create one at ${new URL("/studio/api-keys", ctx.webUrl)}): `)),
  api_key_stdin: apiKeyLogin((ctx) => readAll(ctx.stdin))
};

const pickLoginMethod = (ctx, flags) =>
  flags["api-key-stdin"] ? "api_key_stdin"
    : flags.browser || !ctx.prompter.interactive ? "browser"
      : ctx.prompter.choose("How do you want to sign in to Hatch?", [["browser", "Browser"], ["api_key", "API key"]]);

const login = {
  name: "login",
  describe: "Sign in with the browser or an API key (asks which in a terminal)",
  usage: "login [--browser | --api-key-stdin]",
  options: {
    browser: { type: "boolean", describe: "Sign in through the browser without asking" },
    "api-key-stdin": { type: "boolean", describe: "Read an API key from stdin" }
  },
  async run(ctx, args) {
    return LOGIN_METHODS[await pickLoginMethod(ctx, args.flags)](ctx);
  },
  format: (r) => `Signed in as ${r.account.email ?? r.account.id} (profile ${r.profile}, ${r.kind}).`
};

const logout = {
  name: "logout",
  describe: "Sign out and delete the local credentials for this profile",
  usage: "logout",
  options: {},
  async run(ctx) {
    const stored = await ctx.store.get(ctx.profile);
    if (!stored) return { signed_out: false, note: "No stored credentials for this profile." };
    let note = "API key forgotten locally; it stays valid until revoked (`hatch keys revoke <id>`).";
    if (stored.kind === "session") {
      note = "Session revoked and local credentials deleted.";
      try { await ctx.clientWith(stored.token, stored.api_url).post("/v1/auth/logout"); }
      catch (error) { if (error.status !== 401) note = `Local credentials deleted, but the server could not revoke the session: ${error.message}`; }
    }
    await ctx.store.delete(ctx.profile);
    return { signed_out: true, note };
  },
  format: (r) => r.note
};

const whoami = {
  name: "whoami",
  describe: "Show the signed-in account",
  usage: "whoami",
  options: {},
  async run(ctx) {
    const me = await (await ctx.client()).get("/v1/auth/me");
    const creds = await ctx.credentials();
    return { account: readAccount(me), profile: ctx.profile, kind: creds.kind, api_url: creds.api_url, source: creds.source };
  },
  format: (r) => `${r.account.display_name ?? ""} <${r.account.email ?? r.account.id}>\nprofile ${r.profile} (${r.kind}${r.source === "env" ? ", from HATCH_API_KEY" : ""}) at ${r.api_url}`,
  mcp: { name: "whoami", description: "Show the Hatch account this server acts for.", inputSchema: object({}), toArgs: () => ({ _: [], flags: {} }) }
};

const keysCreate = {
  name: "keys create",
  describe: "Create an API key (shown once)",
  usage: "keys create <name>",
  options: {},
  async run(ctx, args) {
    const [name] = need(this, args, 1);
    return (await ctx.client()).post("/v1/auth/api-keys", { name });
  },
  format: (r) => `API key ${r.id} (${r.name}) created. Copy it now, it is shown once:\n${r.token}`
};
const keysList = {
  name: "keys list",
  describe: "List API keys",
  usage: "keys list",
  options: {},
  async run(ctx) { return listOf(await (await ctx.client()).get("/v1/auth/api-keys"), "api_keys", "keys", "items"); },
  format: (r) => r.length ? r.map((k) => `${k.id}  ${k.name}  created ${k.created_at ?? "?"}${k.revoked_at ? "  revoked" : ""}`).join("\n") : "No API keys."
};
const keysRevoke = {
  name: "keys revoke",
  describe: "Revoke an API key",
  usage: "keys revoke <id>",
  options: {},
  async run(ctx, args) {
    const [id] = need(this, args, 1);
    await (await ctx.client()).delete(`/v1/auth/api-keys/${encodeURIComponent(id)}`);
    return { revoked: id };
  },
  format: (r) => `Revoked ${r.revoked}.`
};

const productsList = {
  name: "products list",
  describe: "List your products",
  usage: "products list",
  options: {},
  async run(ctx) { return listOf(await (await ctx.client()).get("/v1/creator/products"), "products"); },
  format: (r) => r.length ? r.map(productLine).join("\n") : "No products.",
  mcp: { name: "products_list", description: "List the account's Hatch products.", inputSchema: object({}), toArgs: () => ({ _: [], flags: {} }) }
};
const productsShow = {
  name: "products show",
  describe: "Show one product",
  usage: "products show <id>",
  options: {},
  async run(ctx, args) {
    const [id] = need(this, args, 1);
    return unwrapProduct(await (await ctx.client()).get(productPath(id)));
  },
  format: (p) => `${productLine(p)}\n${p.promise ?? ""}`.trim(),
  mcp: { name: "products_show", description: "Show one Hatch product.", inputSchema: object(productIdSchema, ["product_id"]), toArgs: (i) => ({ _: [i.product_id], flags: {} }) }
};
const productsCreate = {
  name: "products create",
  describe: "Create a product (promise defaults to the name)",
  usage: "products create --name <name> [--promise <promise>]",
  options: { name: { type: "string", describe: "Product name" }, promise: { type: "string", describe: "What the product promises" } },
  async run(ctx, args) {
    const { name, promise } = args.flags;
    if (!name) throw new HatchError(`Usage: hatch ${this.usage}`, { code: "usage" });
    return unwrapProduct(await (await ctx.client()).post("/v1/creator/products", { name, promise: promise ?? name }));
  },
  format: (p) => `Created ${productLine(p)}`,
  mcp: {
    name: "products_create", description: "Create a Hatch product (draft).",
    inputSchema: object({ name: { type: "string" }, promise: { type: "string", description: "Defaults to the name" } }, ["name"]),
    toArgs: (i) => ({ _: [], flags: { name: i.name, promise: i.promise } })
  }
};
const productsUpdate = {
  name: "products update",
  describe: "Rename a product or change its promise",
  usage: "products update <id> [--name <name>] [--promise <promise>]",
  options: { name: { type: "string", describe: "New name" }, promise: { type: "string", describe: "New promise" } },
  async run(ctx, args) {
    const [id] = need(this, args, 1);
    const { name, promise } = args.flags;
    if (name === undefined && promise === undefined) throw new HatchError(`Usage: hatch ${this.usage}`, { code: "usage" });
    const client = await ctx.client();
    // The API requires the full pair and an optimistic-concurrency stamp, so merge onto the current product.
    const current = unwrapProduct(await client.get(productPath(id)));
    return unwrapProduct(await client.patch(productPath(id), {
      name: name ?? current.name, promise: promise ?? current.promise,
      ...(current.updated_at ? { expected_updated_at: current.updated_at } : {})
    }));
  },
  format: (p) => `Updated ${productLine(p)}`,
  mcp: {
    name: "products_update", description: "Rename a Hatch product or change its promise.",
    inputSchema: object({ ...productIdSchema, name: { type: "string" }, promise: { type: "string" } }, ["product_id"]),
    toArgs: (i) => ({ _: [i.product_id], flags: { name: i.name, promise: i.promise } })
  }
};
const productsUnlist = {
  name: "products unlist",
  describe: "Hide a product from public listings (--off lists it again)",
  usage: "products unlist <id> [--off]",
  options: { off: { type: "boolean", describe: "Undo: list the product again" } },
  async run(ctx, args) {
    const [id] = need(this, args, 1);
    return (await ctx.client()).put(productPath(id, "/listing"), { listed: Boolean(args.flags.off) });
  },
  format: (r) => r.listed ? `${r.product_id} is listed.` : `${r.product_id} is unlisted.`,
  mcp: {
    name: "products_unlist", description: "Hide a product from public listings, or list it again with listed=true.",
    inputSchema: object({ ...productIdSchema, listed: { type: "boolean", description: "true re-lists the product" } }, ["product_id"]),
    toArgs: (i) => ({ _: [i.product_id], flags: { off: i.listed === true } })
  }
};
const productsWithdraw = {
  name: "products withdraw",
  describe: "Withdraw a published product (stops new access)",
  usage: "products withdraw <id>",
  options: {},
  async run(ctx, args) {
    const [id] = need(this, args, 1);
    return unwrapProduct(await (await ctx.client()).post(productPath(id, "/withdraw")));
  },
  format: (p) => `Withdrawn: ${productLine(p)}`
};

const ingestSubmit = {
  name: "ingest",
  describe: "Ingest links and files into a product",
  usage: "ingest <product-id> <url-or-file>... [--context <text>] [--wait]",
  options: { context: { type: "string", describe: "Free-text context for the ingest" }, wait: { type: "boolean", describe: "Poll the job every 5 s until it finishes" } },
  async run(ctx, args) {
    const [id, ...inputs] = need(this, args, 2);
    const items = await buildIngestItems(inputs, { cwd: ctx.cwd });
    const client = await ctx.client();
    const body = { items, ...(args.flags.context ? { context: args.flags.context } : {}) };
    let job = (await client.post(productPath(id, "/ingest"), body)).job;
    if (args.flags.wait && !isFinished(job)) {
      job = (await waitForJob(async () => (await client.get(productPath(id, `/ingest/${encodeURIComponent(job.id)}`))).job,
        { sleep: ctx.sleep, intervalMs: ctx.pollMs, onProgress: (j) => ctx.log(jobProgress(j)) }));
    }
    if (job.status === "failed") ctx.exitCode = 1;
    return job;
  },
  format: formatJob,
  mcp: {
    name: "ingest_submit",
    description: "Ingest links (http/https URLs) and local files into a Hatch product. Returns the job; poll with ingest_status.",
    inputSchema: object({
      ...productIdSchema,
      items: { type: "array", items: { type: "string" }, minItems: 1, description: "URLs or local file paths" },
      context: { type: "string", description: "Optional free-text context" }
    }, ["product_id", "items"]),
    toArgs: (i) => ({ _: [i.product_id, ...i.items], flags: { context: i.context } })
  }
};
const ingestStatus = {
  name: "ingest status",
  describe: "Show an ingest job",
  usage: "ingest status <product-id> <job-id>",
  options: {},
  async run(ctx, args) {
    const [id, jobId] = need(this, args, 2);
    return (await (await ctx.client()).get(productPath(id, `/ingest/${encodeURIComponent(jobId)}`))).job;
  },
  format: formatJob,
  mcp: {
    name: "ingest_status", description: "Show the status and per-item results of an ingest job.",
    inputSchema: object({ ...productIdSchema, job_id: { type: "string" } }, ["product_id", "job_id"]),
    toArgs: (i) => ({ _: [i.product_id, i.job_id], flags: {} })
  }
};
const ingestList = {
  name: "ingest list",
  describe: "List recent ingest jobs of a product",
  usage: "ingest list <product-id>",
  options: {},
  async run(ctx, args) {
    const [id] = need(this, args, 1);
    return listOf(await (await ctx.client()).get(productPath(id, "/ingest")), "jobs", "items");
  },
  format: (jobs) => jobs.length ? jobs.map((j) => `${j.id}  ${j.status}  ${j.created_at ?? ""}`).join("\n") : "No ingest jobs.",
  mcp: {
    name: "ingest_list", description: "List recent ingest jobs of a product.",
    inputSchema: object(productIdSchema, ["product_id"]), toArgs: (i) => ({ _: [i.product_id], flags: {} })
  }
};

// Conversations: a product's workers and the account's Assistant share one message shape.
const WAIT_SECONDS = 60;
const workerPath = (id, worker, tail) => productPath(id, `/workers/${encodeURIComponent(worker)}${tail}`);
const ASSISTANT_PATH = "/v1/creator/assistant/conversation";
const afterQuery = (after) => after ? `?after=${encodeURIComponent(after)}` : "";
// --wait alone waits 60 s; MCP passes the seconds.
const waitSeconds = (flag) => flag === true ? WAIT_SECONDS : Number(flag) > 0 ? Number(flag) : 0;
const sentQuery = (flag) => waitSeconds(flag) ? `?wait=${waitSeconds(flag)}` : "";
const formatMessages = (r) => r.messages.length
  ? r.messages.map((m) => `[${m.id}] ${m.role === "user" ? "you" : "assistant"} (${m.created_at})\n${m.text}`).join("\n\n")
  : "No messages.";
const formatSent = (r) => r.reply ? r.reply.text : r.message.id;
// The turn's end is a result, not an error, unless it failed.
function finishSend(ctx, r, { waited, where }) {
  if (r.status === "failed") ctx.exitCode = 1;
  if (waited && r.status === "running") ctx.log(`Still running. Read the reply later with \`${where}\`.`);
  return r;
}
const sendTools = (name, description, extra, required, toArgs) => ({
  name, description: `${description} wait is seconds to hold for the reply (max 120); without it the message is only accepted.`,
  inputSchema: object({ ...extra, content: { type: "string", description: "The message" }, wait: { type: "number", description: "Seconds to wait for the reply, 0 to 120" } }, [...required, "content"]), toArgs
});
const historyTool = (name, description, extra, required, toArgs) => ({
  name, description, inputSchema: object({ ...extra, after: { type: "string", description: "Only messages after this message id" } }, required), toArgs
});
const workerIdSchema = { worker: { type: "string", description: "Worker id: research, interview, builder, cases or evaluator" } };

const workersList = {
  name: "workers",
  describe: "List a product's workers and whether they are idle or running",
  usage: "workers <product-id>",
  options: {},
  async run(ctx, args) {
    const [id] = need(this, args, 1);
    return (await (await ctx.client()).get(productPath(id, "/workers"))).workers;
  },
  format: (r) => r.map((w) => `${w.id.padEnd(10)} ${(w.availability === "locked" ? "locked" : w.status).padEnd(8)} ${w.name}${w.blocked_by ? `  (needs ${[...w.blocked_by.missing_required, ...w.blocked_by.needs_one_of].join(", ")})` : ""}`).join("\n"),
  mcp: { name: "workers_list", description: "List a Hatch product's workers (research, interview, builder, cases, evaluator): availability and idle/running.", inputSchema: object(productIdSchema, ["product_id"]), toArgs: (i) => ({ _: [i.product_id], flags: {} }) }
};
const chat = {
  name: "chat",
  describe: "Send a message to a worker; --wait prints its reply",
  usage: "chat <product-id> <worker> <message...> [--wait]",
  options: { wait: { type: "boolean", describe: "Hold up to 60 s for the reply" } },
  async run(ctx, args) {
    const [id, worker, ...words] = need(this, args, 3);
    const r = await (await ctx.client()).post(workerPath(id, worker, `/messages${sentQuery(args.flags.wait)}`), { content: words.join(" ") });
    return finishSend(ctx, r, { waited: waitSeconds(args.flags.wait) > 0, where: `hatch history ${id} ${worker}` });
  },
  format: formatSent,
  mcp: sendTools("worker_send", "Send a message to one of a Hatch product's workers (steers it if it is running).", { ...productIdSchema, ...workerIdSchema }, ["product_id", "worker"],
    (i) => ({ _: [i.product_id, i.worker, i.content], flags: { wait: i.wait } }))
};
const history = {
  name: "history",
  describe: "Read a worker's conversation",
  usage: "history <product-id> <worker> [--after <message-id>]",
  options: { after: { type: "string", describe: "Only messages after this id" } },
  async run(ctx, args) {
    const [id, worker] = need(this, args, 2);
    return (await ctx.client()).get(workerPath(id, worker, `/messages${afterQuery(args.flags.after)}`));
  },
  format: formatMessages,
  mcp: historyTool("worker_history", "Read a Hatch worker's conversation: status and messages, oldest first.", { ...productIdSchema, ...workerIdSchema }, ["product_id", "worker"],
    (i) => ({ _: [i.product_id, i.worker], flags: { after: i.after } }))
};
const stop = {
  name: "stop",
  describe: "Stop a worker's running turn",
  usage: "stop <product-id> <worker>",
  options: {},
  async run(ctx, args) {
    const [id, worker] = need(this, args, 2);
    return (await ctx.client()).post(workerPath(id, worker, "/stop"), {});
  },
  format: () => "Stop requested.",
  mcp: { name: "worker_stop", description: "Stop a Hatch worker's running turn.", inputSchema: object({ ...productIdSchema, ...workerIdSchema }, ["product_id", "worker"]), toArgs: (i) => ({ _: [i.product_id, i.worker], flags: {} }) }
};
const assistantHistory = {
  name: "assistant history",
  describe: "Read the Assistant conversation",
  usage: "assistant history [--after <message-id>]",
  options: { after: { type: "string", describe: "Only messages after this id" } },
  async run(ctx, args) { return (await ctx.client()).get(`${ASSISTANT_PATH}/messages${afterQuery(args.flags.after)}`); },
  format: formatMessages,
  mcp: historyTool("assistant_history", "Read the account's Hatch Assistant conversation: status and messages, oldest first.", {}, [], (i) => ({ _: [], flags: { after: i.after } }))
};
const assistant = {
  name: "assistant",
  describe: "Send a message to the Assistant; --wait prints its reply",
  usage: "assistant <message...> [--wait]",
  options: { wait: { type: "boolean", describe: "Hold up to 60 s for the reply" } },
  async run(ctx, args) {
    const words = need(this, args, 1);
    const r = await (await ctx.client()).post(`${ASSISTANT_PATH}/messages${sentQuery(args.flags.wait)}`, { content: words.join(" ") });
    return finishSend(ctx, r, { waited: waitSeconds(args.flags.wait) > 0, where: "hatch assistant history" });
  },
  format: formatSent,
  mcp: sendTools("assistant_send", "Send a message to the account's Hatch Assistant.", {}, [], (i) => ({ _: [i.content], flags: { wait: i.wait } }))
};

const SKILL_SOURCE = fileURLToPath(new URL("../skill/hatch", import.meta.url));
const installSkill = {
  name: "install-skill",
  describe: "Copy the Hatch coding-agent skill into ./.agents/skills (or -g for ~/.agents/skills)",
  usage: "install-skill [-g] [--dir <skills-dir>]",
  options: { global: { type: "boolean", describe: "Install under ~/.agents/skills (alias -g)" }, dir: { type: "string", describe: "Skills directory to install into" } },
  async run(ctx, args) {
    const base = args.flags.dir ? resolve(ctx.cwd, args.flags.dir)
      : (args.flags.global || args.flags.g) ? join(ctx.home, ".agents", "skills") : join(ctx.cwd, ".agents", "skills");
    const target = join(base, "hatch");
    await cp(SKILL_SOURCE, target, { recursive: true, force: true });
    return { installed: target };
  },
  format: (r) => `Skill installed to ${r.installed}`
};

export const COMMANDS = [
  login, logout, whoami, keysCreate, keysList, keysRevoke,
  productsList, productsShow, productsCreate, productsUpdate, productsUnlist, productsWithdraw,
  ingestSubmit, ingestStatus, ingestList,
  workersList, chat, history, stop, assistantHistory, assistant, installSkill
];
