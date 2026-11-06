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

const login = {
  name: "login",
  describe: "Sign in through the browser (or --api-key-stdin to store an API key)",
  usage: "login [--api-key-stdin]",
  options: { "api-key-stdin": { type: "boolean", describe: "Read an API key from stdin instead of opening the browser" } },
  async run(ctx, args) {
    if (args.flags["api-key-stdin"]) {
      const key = (await readAll(ctx.stdin)).trim();
      if (!key) throw new HatchError("No API key on stdin.", { code: "usage" });
      return saveLogin(ctx, ctx.apiUrl, key, "api_key");
    }
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
  ingestSubmit, ingestStatus, ingestList, installSkill
];
