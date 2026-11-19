#!/usr/bin/env node
// Creates (or finds) the sending domain in Resend and prints the DNS records it asks for; with --verify, asks Resend to check them.
// Idempotent. It never touches DNS: add the printed records yourself, then run again with --verify.
//   RESEND_API_KEY=re_... node scripts/setup-report-email-domain.mjs [domain] [--verify] [--region ap-northeast-1]
import { Resend } from "resend";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const domain = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--region") ?? "gethatchapp.com";
const region = option("--region", "ap-northeast-1");
const key = process.env.RESEND_API_KEY?.trim();
if (!key) { console.error("Set RESEND_API_KEY."); process.exit(1); }
const resend = new Resend(key);
const check = ({ data, error }, what) => { if (error) { console.error(`${what} failed: ${error.name}: ${error.message}`); process.exit(1); } return data; };

const listed = check(await resend.domains.list(), "List domains");
let id = listed.data.find((d) => d.name === domain)?.id;
if (!id) {
  let created = await resend.domains.create({ name: domain, region });
  if (created.error && region !== "us-east-1" && !args.includes("--region")) {
    console.error(`Region ${region} refused (${created.error.message}); using Resend's default.`);
    created = await resend.domains.create({ name: domain });
  }
  id = check(created, "Create domain").id;
  console.log(`Created ${domain} (${id}).`);
}
if (flag("--verify")) check(await resend.domains.verify(id), "Verify domain");
const found = check(await resend.domains.get(id), "Get domain");
console.log(`${found.name}  status=${found.status}  region=${found.region}  id=${found.id}\n`);
for (const r of found.records) {
  console.log(`${r.record.padEnd(5)} ${r.type.padEnd(5)} ${r.name.padEnd(28)} ${String(r.priority ?? "").padEnd(3)} ${r.value}   [${r.status}]`);
}
console.log(found.status === "verified" ? "\nVerified: the Runtime can send from this domain." : flag("--verify") ? "\nNot verified yet: DNS may still be propagating; run --verify again." : "\nAdd these records to DNS (leave the root MX on Feishu alone), then run with --verify.");
