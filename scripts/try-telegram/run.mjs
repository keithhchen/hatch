#!/usr/bin/env node
// Try "Telegram <-> Studio Assistant" with a REAL bot. Local isolated stack (own Postgres, Registry, Runtime, Dashboard, Caddy)
// behind an ngrok tunnel. Everything lives under ~/hatch-try-telegram/ on non-default ports. Run it through agentsecrets (see README below).
//   agentsecrets exec --profile hatch --provider gemini -- agentsecrets exec --profile hatch --provider kimi -- node scripts/try-telegram/run.mjs
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "../../runtime-server/node_modules/pg/lib/index.js";
import { PostgresCluster } from "../../runtime-server/scripts/verify-surfaces/lib/processes.mjs";
import { freePort, until } from "../../runtime-server/scripts/verify-surfaces/lib/util.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const home = path.join(os.homedir(), "hatch-try-telegram");
const run = path.join(home, "run"), logs = path.join(home, "logs");
const telegramEnv = path.join(home, "telegram.env");
const MISSING = ["GEMINI_API_KEY", "LLM_API_KEY", "FIRECRAWL_API_KEY"].filter((name) => !process.env[name]);
if (MISSING.length) { console.error(`Missing ${MISSING.join(", ")}. Start it with:\n  scripts/try-telegram/start.sh`); process.exit(1); }

const telegram = existsSync(telegramEnv) ? Object.fromEntries(readFileSync(telegramEnv, "utf8").split("\n").map((l) => l.match(/^\s*(?:export\s+)?(HATCH_TELEGRAM_BOT_[A-Z]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, "")])) : {};
const bot = telegram.HATCH_TELEGRAM_BOT_TOKEN && telegram.HATCH_TELEGRAM_BOT_USERNAME ? { token: telegram.HATCH_TELEGRAM_BOT_TOKEN, username: telegram.HATCH_TELEGRAM_BOT_USERNAME.replace(/^@/, "") } : undefined;
const secret = randomBytes(24).toString("hex");
const tok = { toRegistry: randomBytes(16).toString("hex"), toRuntime: randomBytes(16).toString("hex") };

rmSync(run, { recursive: true, force: true }); rmSync(logs, { recursive: true, force: true });
mkdirSync(run, { recursive: true }); mkdirSync(logs, { recursive: true });

const children = [];
function start(name, command, args, { cwd = repo, env = {} } = {}) {
  const fd = openSync(path.join(logs, `${name}.log`), "a");
  const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", fd, fd] });
  closeSync(fd); child.once("exit", (code) => { if (!stopping) console.error(`${name} exited (${code}); see ${logs}/${name}.log`); });
  children.push(child); return child;
}
const ready = (what, url) => until(what, async () => (await fetch(url)).ok, { timeoutMs: 90_000 });
const telegramApi = (method, body) => fetch(`https://api.telegram.org/bot${bot.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch((e) => ({ ok: false, description: e.message }));

let stopping = false, cluster, webhookSet = false;
async function stop() {
  if (stopping) return; stopping = true;
  if (webhookSet) console.log("deleteWebhook:", (await telegramApi("deleteWebhook", {})).ok ? "ok" : "failed");
  for (const child of children.reverse()) child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  for (const child of children) child.kill("SIGKILL");
  await cluster?.stop();
  process.exit(0);
}
process.on("SIGINT", stop); process.on("SIGTERM", stop);

try {
  cluster = await PostgresCluster.start(run);
  const admin = new pg.Pool({ connectionString: cluster.url(), max: 1 });
  for (const db of ["registry", "runtime"]) await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();

  const [edgePort, registryPort, runtimePort, dashboardPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const local = `http://127.0.0.1:${edgePort}`;

  // The edge is Caddy with the repo's own routing rules (/Caddyfile), service names mapped to local ports.
  const routes = readFileSync(path.join(repo, "Caddyfile"), "utf8").split("{$HATCH_DOMAIN}")[0]
    .replaceAll("registry:8100", `127.0.0.1:${registryPort}`).replaceAll("runtime:8400", `127.0.0.1:${runtimePort}`).replaceAll("dashboard:8500", `127.0.0.1:${dashboardPort}`);
  writeFileSync(path.join(run, "Caddyfile"), `{\n  auto_https off\n  admin off\n}\n${routes}\nhttp://:${edgePort} {\n  bind 127.0.0.1\n  import hatch_routes\n}\n`);
  start("caddy", "caddy", ["run", "--config", path.join(run, "Caddyfile"), "--adapter", "caddyfile"]);

  // NO_NGROK=1: local-only (no Telegram delivery possible); used to test the stack without a tunnel.
  if (!process.env.NO_NGROK) start("ngrok", "ngrok", ["http", String(edgePort), "--log", "stdout", ...(process.env.NGROK_DOMAIN ? [`--url=https://${process.env.NGROK_DOMAIN}`] : [])], { env: { HOME: os.homedir() } });
  const publicUrl = process.env.NO_NGROK ? local : await until("the ngrok tunnel (see logs/ngrok.log)", async () => (await (await fetch("http://127.0.0.1:4040/api/tunnels")).json()).tunnels.find((t) => t.public_url.startsWith("https://") && t.config?.addr?.endsWith(`:${edgePort}`))?.public_url, { timeoutMs: 30_000 });

  const base = { NODE_ENV: "development", DOTENV_CONFIG_PATH: "/dev/null", GEMINI_API_KEY: process.env.GEMINI_API_KEY, LLM_API_KEY: process.env.LLM_API_KEY, ...(process.env.FIRECRAWL_API_KEY ? { FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY } : {}) };
  const runtimeSrv = path.join(repo, "runtime-server");
  start("registry", process.execPath, [path.join(runtimeSrv, "dist/registryServer.js")], { cwd: runtimeSrv, env: {
    ...base, REGISTRY_HOST: "127.0.0.1", REGISTRY_PORT: String(registryPort),
    HATCH_REGISTRY_DATABASE_URL: cluster.url("registry"), HATCH_AGENT_CORPUS_ROOT: path.join(run, "registry-corpora"), HATCH_CREATOR_FACTORY_ROOT: path.join(run, "factory"),
    HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN: tok.toRegistry, HATCH_RUNTIME_CHAT_URL: local, HATCH_RUNTIME_CHAT_SERVICE_TOKEN: tok.toRuntime,
    HATCH_CREDENTIALS_KEY: randomBytes(24).toString("hex"), HATCH_STUDIO_ASSISTANT_URL: `${publicUrl}/studio/assistant`, HATCH_FACTORY_LLM_PROFILE: "gemini-api",
    ...(bot ? { HATCH_TELEGRAM_BOT_TOKEN: bot.token, HATCH_TELEGRAM_BOT_USERNAME: bot.username, HATCH_TELEGRAM_WEBHOOK_SECRET: secret } : {})
  } });
  start("runtime", process.execPath, [path.join(runtimeSrv, "dist/index.js")], { cwd: runtimeSrv, env: {
    ...base, PORT: String(runtimePort), HATCH_RUNTIME_HOST: "127.0.0.1",
    HATCH_RUNTIME_DATABASE_URL: cluster.url("runtime"), HATCH_RUNTIME_DATA_DIR: path.join(run, "runtime-data"), HATCH_RUNTIME_CORPUS_ROOT: path.join(run, "corpora"),
    HATCH_REGISTRY_URL: `http://127.0.0.1:${registryPort}`, HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN: tok.toRegistry, HATCH_RUNTIME_CHAT_SERVICE_TOKEN: tok.toRuntime,
    HATCH_LLM_PROFILE: "gemini-api", HATCH_RUNTIME_ALLOWED_ORIGINS: `${local},${publicUrl}`
  } });
  start("dashboard", process.execPath, [path.join(repo, "creator-dashboard/server.mjs")], { cwd: path.join(repo, "creator-dashboard"), env: {
    NODE_ENV: "development", HATCH_CREATOR_DASHBOARD_API_HOST: "127.0.0.1", HATCH_CREATOR_DASHBOARD_API_PORT: String(dashboardPort),
    HATCH_REGISTRY_URL: `http://127.0.0.1:${registryPort}`, HATCH_RUNTIME_URL: `http://127.0.0.1:${runtimePort}`,
    HATCH_PUBLIC_ORIGIN: publicUrl, HATCH_PUBLIC_ORIGINS: local, HATCH_OAUTH_STATE_KEY: randomBytes(24).toString("hex"),
    HATCH_COMMERCE_LEDGER_PATH: path.join(run, "ledger.jsonl"), HATCH_PORTAL_STATE_PATH: path.join(run, "portal-state.json"), HATCH_PORTAL_TELEMETRY_PATH: path.join(run, "telemetry.jsonl")
  } });
  await Promise.all([ready("the Registry", `http://127.0.0.1:${registryPort}/healthz`), ready("the Runtime", `http://127.0.0.1:${runtimePort}/readyz`), ready("the Dashboard", `http://127.0.0.1:${dashboardPort}/readyz`)]);

  if (bot && !process.env.NO_NGROK) {
    const result = await telegramApi("setWebhook", { url: `${publicUrl}/v1/channels/telegram/webhook`, secret_token: secret });
    webhookSet = result.ok;
    console.log(result.ok ? "Telegram webhook: set" : `Telegram webhook FAILED: ${result.description}`);
  } else if (!bot) console.log(`No bot configured. Create ${telegramEnv} containing:\n  HATCH_TELEGRAM_BOT_TOKEN=<token from @BotFather>\n  HATCH_TELEGRAM_BOT_USERNAME=<bot username, without @>\nthen restart this launcher. (Everything else is running; the Telegram tile will not appear until then.)`);
  console.log(`\nDashboard (works for sign-in): ${publicUrl}   or   ${local}\nSign up: open it, create an account with any email + password (local throwaway account), open the Assistant, click the Telegram tile, press Start in Telegram.\nLogs: ${logs}\nCtrl-C stops everything.`);
  await new Promise(() => {});
} catch (error) { console.error(error.message); await stop(); }
