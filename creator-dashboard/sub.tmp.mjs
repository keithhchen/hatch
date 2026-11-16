import { createRequire } from "module"; import fs from "fs"; import path from "path";
const require = createRequire(import.meta.url); const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:58080", PRODUCT = "802f2105-e28e-4ddc-996a-0a97a7fa4bb5";
const env = Object.fromEntries(fs.readFileSync("/Users/keithchen/hatch-local-prod/test-accounts.env","utf8").split("\n").filter(l=>l.includes("=")).map(l=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).replace(/^["']|["']$/g,"")]));
const exe = fs.readdirSync(process.env.HOME+"/Library/Caches/ms-playwright").filter(d=>d.startsWith("chromium_headless_shell-")).sort().pop(); const r0=path.join(process.env.HOME,"Library/Caches/ms-playwright",exe);
const browser = await chromium.launch({ executablePath: path.join(r0, fs.readdirSync(r0).find(d=>d.startsWith("chrome-headless-shell")), "chrome-headless-shell") });
const p = await (await browser.newContext()).newPage();
await p.goto(`${BASE}/sign-in?returnTo=%2Fstudio`); await p.fill("input[type=email]", env.LOCAL_TEST_EMAIL); await p.fill("input[type=password]", env.LOCAL_TEST_PASSWORD); await p.locator("form button[type=submit]").click(); await p.waitForURL(/\/studio/);
await p.goto(`${BASE}/products/${PRODUCT}`); await p.waitForTimeout(3000);
console.log("buttons:", (await p.locator("button, a").allInnerTexts()).filter(t => t.trim()).slice(0, 40).join(" | "));
for (const label of [/^(Subscribe|订阅|Get access|Start|免费|Free)/i]) { const b = p.getByRole("button", { name: label }).first(); if (await b.count()) { await b.click(); await p.waitForTimeout(3000); console.log("clicked", await b.innerText().catch(()=>"")); } }
console.log("after:", p.url(), (await p.locator("button, a").allInnerTexts()).filter(t => t.trim()).slice(0, 25).join(" | "));
const confirm = p.getByRole("button", { name: /(Add to account|Confirm|确认|Subscribe|订阅|Complete|Place)/i }).first();
if (await confirm.count()) { await confirm.click(); await p.waitForTimeout(4000); console.log("confirmed ->", p.url()); }
const access = await (await p.request.get(`${BASE}/v1/user/product-access`)).json().catch(()=>({}));
console.log("access:", JSON.stringify(access).includes(PRODUCT) ? "has access" : "no access");
await browser.close();
