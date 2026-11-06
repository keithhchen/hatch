// Usage: node capture.mjs <outDir>  — signs in with the local test account and screenshots every web surface.
import { chromium } from "playwright";
import fs from "node:fs";
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const env = Object.fromEntries(fs.readFileSync(process.env.ACCOUNT_FILE, "utf8").trim().split("\n").map(l => l.split(/=(.*)/s).slice(0, 2)));
const BASE = "http://127.0.0.1:5199";
const PID = process.env.PID || "437e54ce-abe8-4474-b9d5-ef4df68b83b1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const SIZES = process.env.SIZES || "desktop,mobile";
const pub = [["explore", "/explore"], ["sign-in", "/sign-in"], ["sign-up", "/sign-up"], ["account-help", "/account/help"], ["download", "/download"]];
const auth = [
  ["library", "/library"], ["orders", "/orders"], ["account", "/account"],
  ["studio-home", "/studio"], ["studio-products", "/studio/products"], ["studio-new", "/studio/products/new"],
  ["studio-orders", "/studio/orders"], ["studio-earnings", "/studio/earnings"], ["studio-settings", "/studio/settings"], ["studio-publish", `/studio/products/${PID}/publish`], ["studio-storefront", `/studio/products/${PID}/storefront`], ["studio-readiness", `/studio/products/${PID}/readiness`], ["studio-factory", `/studio/factory/${PID}`],
  ["studio-factory-uploads", `/studio/factory/${PID}/sources/uploads`], ["studio-factory-research", `/studio/factory/${PID}/sources/research`],
  ["studio-factory-voice", `/studio/factory/${PID}/sources/voice`], ["studio-factory-build", `/studio/factory/${PID}/build/generation`],
  ["studio-factory-cases", `/studio/factory/${PID}/evaluate/case-generation`], ["studio-factory-eval", `/studio/factory/${PID}/evaluate/evaluator`],
  ["studio-product-files", `/studio/products/${PID}/files`], ["studio-product-complete", `/studio/products/${PID}/complete`],
  ["studio-preview", `/studio/products/${PID}/preview`], ["product-page", `/products/${PID}`], ["chat", `/chat/product/${PID}`],
];
const browser = await chromium.launch({ channel: "chrome" });
for (const [vw, vh, tag] of [[1440, 900, "desktop"], [390, 844, "mobile"]].filter(([, , t]) => SIZES.includes(t))) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, locale: "zh-CN", deviceScaleFactor: tag === "mobile" ? 2 : 1 });
  await ctx.addInitScript(() => { try { localStorage.setItem("hatch.locale", "zh"); } catch {} });
  const page = await ctx.newPage();
  const shot = async (name, path) => {
    if (ONLY && !ONLY.has(name)) return;
    await page.goto(BASE + path, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${out}/${tag}-${name}.png`, fullPage: true });
  };
  for (const [n, p] of pub) await shot(n, p);
  await page.goto(BASE + "/sign-in", { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', env.EMAIL);
  await page.fill('input[type="password"]', env.PASSWORD);
  await page.locator('form button[type="submit"], form button').last().click();
  await page.waitForTimeout(2500);
  for (const [n, p] of auth) await shot(n, p);
  await ctx.close();
}
await browser.close();
console.log("done", fs.readdirSync(out).length);
