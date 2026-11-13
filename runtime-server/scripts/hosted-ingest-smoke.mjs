// Development tool, not a product path: runs one real ingest on Kimi Hosted Agents and writes what came back.
// A file input needs its original at HATCH_SMOKE_DOWNLOAD_URL (a presigned GET stand-in); its local copy only gives name and size.
// Usage: KIMI_API_KEY=... [DASHSCOPE_API_KEY=...] node scripts/hosted-ingest-smoke.mjs <out-dir> <url-or-file>...
// Browser profiles come from an in-memory store seeded by HATCH_SMOKE_COOKIES=<platform>:<cookie-export.json>.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KimiApi } from "../dist/hostedAgents/kimiApi.js";
import { zipDirectory } from "../dist/hostedAgents/zip.js";
import { Provisioner } from "../dist/hostedAgents/provisioner.js";
import { KimiHostedAgent } from "../dist/hostedAgents/kimiHostedAgent.js";
import { HostedIngest } from "../dist/hostedAgents/ingest.js";
import { INGEST_SANDBOX, ingestAgent, ingestSecrets } from "../dist/hostedAgents/ingestAgent.js";
import { MODEL_ROLES } from "../dist/modelRoles.js";
import { MemoryBrowserProfiles, cookiesFromExport, hostsForCookies } from "../dist/hostedAgents/browserProfiles.js";

const [outDir, ...inputs] = process.argv.slice(2);
if (!outDir || !inputs.length) throw new Error("usage: hosted-ingest-smoke.mjs <out-dir> <url-or-file>...");
const apiKey = process.env.KIMI_API_KEY ?? process.env.LLM_API_KEY;
if (!apiKey) throw new Error("KIMI_API_KEY is required");

const accountId = "00000000-0000-4000-8000-000000000000";
const profiles = new MemoryBrowserProfiles();
if (process.env.HATCH_SMOKE_COOKIES) {
  const [platform, file] = process.env.HATCH_SMOKE_COOKIES.split(":");
  const cookies = cookiesFromExport(JSON.parse(await readFile(file, "utf8")));
  await profiles.put({
    accountId, platform, label: "smoke", hosts: hostsForCookies(cookies), cookies, status: "ready",
    fingerprint: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", locale: "zh-CN", timezone: "Asia/Shanghai", viewport: { width: 1440, height: 900 } },
  });
}

const items = await Promise.all(inputs.map(async (input, i) => /^https?:\/\//.test(input)
  ? { id: `i${i + 1}`, kind: "link", url: input }
  : { id: `i${i + 1}`, kind: "file", name: path.basename(input), bytes: (await readFile(input)).length, downloadUrl: process.env.HATCH_SMOKE_DOWNLOAD_URL }));

const api = new KimiApi({ apiKey });
const agent = new KimiHostedAgent(api, new Provisioner(api, INGEST_SANDBOX, async () => ingestAgent(MODEL_ROLES.ingest), zipDirectory));
const started = Date.now();
const outcome = await new HostedIngest(agent, profiles, ingestSecrets(process.env)).ingest({ accountId, items, context: "Hatch smoke test" });

await mkdir(outDir, { recursive: true });
for (const item of outcome.items) {
  if (item.original) await writeFile(path.join(outDir, item.original.name), item.original.bytes);
  if (item.markdown) await writeFile(path.join(outDir, `${item.id}.content.md`), item.markdown);
}
const summary = { sessionId: outcome.sessionId, seconds: Math.round((Date.now() - started) / 1000), items: outcome.items.map(({ original, markdown, ...rest }) => ({ ...rest, original: original?.name, original_bytes: original?.bytes.length, markdown_chars: markdown?.length })), profiles: await profiles.list(accountId).then(list => list.map(p => ({ platform: p.platform, status: p.status, note: p.note, cookies: p.cookies.length }))), report: outcome.report };
await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
