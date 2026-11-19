// Operator script: create or update the Kimi Hosted Agents side of the Kimi-hosted engine, then print the ids.
//   agentsecrets exec ... SYSTEM_MD=<SYSTEM.md> node scripts/provision-kimi-hosted.mjs   (see provision-kimi-hosted.sh)
// The agent's system prompt is the Product corpus file runtime/kimi-hosted/SYSTEM.md: pass its path; this script never carries a prompt.
// Env: LLM_API_KEY (Moonshot), PAGESPEED_API_KEY, GOOGLE_MAPS_API_KEY, CF_API_TOKEN (never printed), KIMI_HOSTED_NAME_PREFIX (default hatch-site-audit).
// Idempotent by name: re-running with another --system updates the agent in place. Environments are immutable on the platform, so a changed
// environment config (see CONFIG_DIGEST) creates a new environment and prints its id; unchanged config reuses the existing one.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1";
const H = { authorization: `Bearer ${process.env.LLM_API_KEY}`, "kimi-api-version": "2026-09-01-beta" };
const DIR = path.dirname(new URL(import.meta.url).pathname);
const BIN = path.join(DIR, "..", "kimi-hosted", "bin");
const PREFIX = process.env.KIMI_HOSTED_NAME_PREFIX ?? "hatch-site-audit";
const MODEL = process.env.KIMI_HOSTED_MODEL ?? "kimi-k3.1-pro";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const api = async (method, p, body) => {
  for (let i = 0; ; i++) {
    const res = await fetch(BASE + p, { method, headers: { ...H, ...(body ? { "content-type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
    if ((res.status >= 500 || res.status === 429) && i < 4) { await sleep(1000 * 2 ** i); continue; }
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${(await res.text()).slice(0, 400)}`);
    return res.status === 204 ? {} : res.json().catch(() => ({}));
  }
};
const list = async p => { const out = []; let tok; do { const r = await api("GET", `${p}${p.includes("?") ? "&" : "?"}page_size=100${tok ? `&page_token=${tok}` : ""}`); out.push(...r.items ?? []); tok = r.next_page_token; } while (tok); return out; };

// ---- the environment: what our agent box image has (hatch-agent-box/Dockerfile), plus the three research CLIs ----
const CLIS = ["page_speed", "place_search", "ip_info"];
const installClis = () => CLIS.map(name => `echo ${fs.readFileSync(path.join(BIN, name)).toString("base64")} | base64 -d | $SUDO tee /usr/local/bin/${name} >/dev/null\n$SUDO chmod 0755 /usr/local/bin/${name}`).join("\n");
const SETUP = `set -eu
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
python3 -m playwright install --with-deps chromium
CHROME="$(find / -type f -name chrome -path '*chromium-*' 2>/dev/null | head -1)"
[ -n "$CHROME" ] || CHROME="$(command -v chromium chromium-browser | head -1)"
[ -n "$CHROME" ] && for n in chrome google-chrome chromium; do $SUDO ln -sf "$CHROME" /usr/local/bin/$n; done
# The shell tool reads no profile: lighthouse finds Chrome by the google-chrome name. whois needs its service name.
grep -qw whois /etc/services 2>/dev/null || printf "whois\\t\\t43/tcp\\t\\tnicname\\n" | $SUDO tee -a /etc/services >/dev/null
echo 'export CHROME_PATH=/usr/local/bin/chrome' | $SUDO tee /etc/profile.d/hatch.sh >/dev/null
grep -q '^CHROME_PATH=' /etc/environment 2>/dev/null || echo 'CHROME_PATH=/usr/local/bin/chrome' | $SUDO tee -a /etc/environment >/dev/null
${installClis()}
`;
const ENVIRONMENT = {
  config: {
    type: "cloud", networking: { type: "unrestricted" },
    packages: {
      apt: "curl wget openssl ca-certificates dnsutils whois git jq ripgrep unzip xz-utils zip build-essential pandoc poppler-utils qpdf imagemagick fonts-noto-cjk fonts-noto-color-emoji".split(" "),
      pip: "uv httpx requests beautifulsoup4 lxml extruct numpy pandas jinja2 pillow playwright".split(" "),
      npm: ["lighthouse"]
    },
    setup_script: SETUP
  }
};
const CONFIG_DIGEST = createHash("sha256").update(JSON.stringify(ENVIRONMENT.config)).digest("hex").slice(0, 12);

// ---- the keys: write-only vault credentials, substituted only on requests to the listed hosts ----
const KEYS = [["PAGESPEED_API_KEY", "www.googleapis.com"], ["GOOGLE_MAPS_API_KEY", "places.googleapis.com"], ["CF_API_TOKEN", "api.cloudflare.com"]];

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function provision() {
  const systemPath = arg("system") ?? process.env.SYSTEM_MD;
  if (!systemPath || !fs.existsSync(systemPath)) throw new Error("--system <path> (or env SYSTEM_MD) is required (the Product corpus file runtime/kimi-hosted/SYSTEM.md)");
  const system = fs.readFileSync(systemPath, "utf8");
  if (!system.trim()) throw new Error(`${systemPath} is empty`);
  if (!process.env.LLM_API_KEY) throw new Error("LLM_API_KEY is not set");
  for (const [name] of KEYS) if (!process.env[name]) throw new Error(`${name} is not set`);

  // environment
  const environments = (await list("/environments")).filter(e => e.name === `${PREFIX}-env` && !e.archived_at);
  let environment = environments.find(e => e.metadata?.config_digest === CONFIG_DIGEST);
  if (!environment) environment = await api("POST", "/environments", { name: `${PREFIX}-env`, description: "Hatch website-audit sandbox", metadata: { config_digest: CONFIG_DIGEST }, ...ENVIRONMENT });
  const t0 = Date.now();
  for (;;) {
    const e = await api("GET", `/environments/${environment.id}`);
    console.error("environment build:", e.build_status, Math.round((Date.now() - t0) / 1000) + "s");
    if (e.build_status === "ready") break;
    if (e.build_status === "failed") throw new Error("environment build failed: " + JSON.stringify(e).slice(0, 800));
    await sleep(15000);
  }

  // vault and its credentials (values are write-only: always written, so a rotated key is picked up)
  const vaultName = `${PREFIX}-keys`;
  const vault = (await list("/vaults")).find(v => v.display_name === vaultName && !v.archived_at) ?? await api("POST", "/vaults", { display_name: vaultName });
  const credentials = await list(`/vaults/${vault.id}/credentials`);
  for (const [secret_name, host] of KEYS) {
    const auth = { type: "environment_variable", secret_name, secret_value: process.env[secret_name], networking: { type: "limited", allowed_hosts: [host] }, injection_location: { header: true, body: true } };
    const existing = credentials.find(c => c.auth?.secret_name === secret_name);
    if (existing) await api("PATCH", `/vaults/${vault.id}/credentials/${existing.id}`, { auth });
    else await api("POST", `/vaults/${vault.id}/credentials`, { display_name: secret_name, auth });
  }

  // agent: the platform's built-in toolset only; the audit prompt is the system prompt
  const agentBody = { name: `${PREFIX}-agent`, description: "Hatch website audit on Kimi Hosted Agents", model: { id: MODEL }, system, tools: [{ type: "agent_toolset", name: "default_toolset_20260901" }] };
  const found = (await list("/agents")).find(a => a.name === agentBody.name && !a.archived_at);
  const agent = found ? await api("PATCH", `/agents/${found.id}`, agentBody) : await api("POST", "/agents", agentBody);
  console.log(JSON.stringify({ agentId: found?.id ?? agent.id, environmentId: environment.id, vaultId: vault.id, systemBytes: Buffer.byteLength(system), keys: KEYS.map(([name]) => name) }));
}

provision().catch(e => { console.error("FATAL", e.message); process.exit(1); });
