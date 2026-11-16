// Local-only end-to-end: a parent fills Tina's intake in the real web UI and waits for the report.
import { createRequire } from "module";
import fs from "fs";
import path from "path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const BASE = "http://127.0.0.1:58080";
const PRODUCT = "802f2105-e28e-4ddc-996a-0a97a7fa4bb5";
const env = Object.fromEntries(fs.readFileSync("/Users/keithchen/hatch-local-prod/test-accounts.env", "utf8").split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")]));
const exe = fs.readdirSync(process.env.HOME + "/Library/Caches/ms-playwright").filter(d => d.startsWith("chromium_headless_shell-")).sort().pop();
const r0 = path.join(process.env.HOME, "Library/Caches/ms-playwright", exe);
const browser = await chromium.launch({ executablePath: path.join(r0, fs.readdirSync(r0).find(d => d.startsWith("chrome-headless-shell")), "chrome-headless-shell") });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Sample uploads: a transcript PDF and a photo of an award certificate.
const maker = await browser.newPage();
await maker.setContent(`<html><body style="font-family:'PingFang SC',sans-serif;padding:40px"><h2>上海某国际学校 2025–2026 学年第一学期成绩单</h2><p>学生：林同学　年级：10（高一）　课程：IB MYP / Pre-IB</p>
<table border=1 cellpadding=8 style="border-collapse:collapse"><tr><th>科目</th><th>等级</th><th>备注</th></tr>
<tr><td>English Language & Literature</td><td>6/7</td><td>写作进步明显</td></tr><tr><td>Mathematics (Standard)</td><td>4/7</td><td>代数需加强</td></tr>
<tr><td>Biology</td><td>6/7</td><td>实验报告优秀</td></tr><tr><td>Design</td><td>7/7</td><td>产品设计项目获全年级展示</td></tr><tr><td>German (ab initio)</td><td>5/7</td><td></td></tr><tr><td>Chinese A</td><td>6/7</td><td></td></tr></table>
<p>班主任评语：做事有主见，动手能力强，对环保话题投入。</p></body></html>`);
await maker.pdf({ path: path.join(OUT, "成绩单.pdf"), format: "A4" });
await maker.setViewportSize({ width: 1000, height: 700 });
await maker.setContent(`<html><body style="margin:0;background:#f6efe0;font-family:'PingFang SC',serif;display:flex;align-items:center;justify-content:center;height:700px"><div style="border:12px double #b08d3c;padding:60px;width:820px;text-align:center"><h1 style="font-size:46px;color:#8a1c1c">荣誉证书</h1><p style="font-size:26px">林同学 同学：</p><p style="font-size:24px">在 2025 年上海市青少年创新设计大赛中，作品《可回收材料的校园储物系统》荣获</p><p style="font-size:40px;color:#8a1c1c">二等奖</p><p style="font-size:20px">上海市青少年科技创新协会　2025 年 11 月</p></div></body></html>`);
await maker.screenshot({ path: path.join(OUT, "奖状.jpg"), type: "jpeg", quality: 85 });
await maker.close();

const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto(`${BASE}/sign-in?returnTo=%2Fstudio`);
await p.fill("input[type=email]", env.LOCAL_TEST_EMAIL);
await p.fill("input[type=password]", env.LOCAL_TEST_PASSWORD);
await p.locator("form button[type=submit]").click();
await p.waitForURL(/\/studio/);
await p.goto(`${BASE}/artifact/product/${PRODUCT}`);
await p.waitForTimeout(4000);
await p.screenshot({ path: path.join(OUT, "01-intake.png"), fullPage: false });
const body = await p.locator("body").innerText();
if (!/现在是谁在填/.test(body)) { console.log("INTAKE NOT SHOWN:\n" + body.slice(0, 1500)); await browser.close(); process.exit(1); }

const field = id => p.locator(`[data-field="${id}"]`);
const pick = async (id, option) => field(id).getByRole(/^(radio|checkbox)$/.test("radio") ? "radio" : "radio", { name: option }).click();
const choose = async (id, ...options) => { for (const o of options) await field(id).locator("button.artifact__option", { hasText: o }).first().click(); };
const type = async (id, text) => field(id).locator("input, textarea").first().fill(text);
await choose("filler", "家长");
await choose("grade", "高一");
await choose("curriculum", "IB");
await type("entry_year", "2029");
await field("transcript").locator("input[type=file]").first().setInputFiles(path.join(OUT, "成绩单.pdf"));
await type("free_time", "做手工和小家具，用废纸箱、木板做收纳和灯具，周末会在二手市集卖自己做的东西。");
await type("absorbed", "上个月为学校设计回收储物柜，连续三个周末在社区木工房做模型，没人催。");
await type("favorite_subject", "Design（设计课），因为能把想法做成真的东西");
await type("hard_subject", "数学");
await type("three_words", "有主见、动手能力强、慢热");
await type("activities", "1. 环保社团，两年，现在是项目组长，组织校园回收活动；2. 二手市集摆摊卖手工作品，一年半，累计卖出四十多件；3. 德语兴趣课，一年。");
await type("leadership", "高一发起了“旧物改造周”，带十几个同学把废旧家具改造后义卖，收入捐给流浪动物救助站。");
await field("awards").locator("input[type=file]").first().setInputFiles(path.join(OUT, "奖状.jpg"));
await type("child_direction", "不确定，可能是设计或者环境相关");
await type("parent_direction", "希望能兼顾就业，比如工业设计或商科");
await choose("regions", "美国", "英国", "香港");
await choose("budget", "50–80 万");
await type("worry", "数学偏弱会不会影响申请好学校，以及孩子兴趣太散、没有一条清楚的主线。");
await p.screenshot({ path: path.join(OUT, "02-filled.png"), fullPage: true });

const started = Date.now();
await p.locator("button[type=submit]").click();
log("submitted");
let conversationId;
for (let i = 0; i < 60 && !conversationId; i++) { await p.waitForTimeout(1000); conversationId = /conversation\/([^/?#]+)/.exec(p.url())?.[1]; }
log("conversation", conversationId ?? "(not in URL)", p.url());
await p.screenshot({ path: path.join(OUT, "03-after-submit.png") });

const report = async () => (await p.request.get(`${BASE}/v1/web-chat/conversations/${conversationId}/report`)).json().catch(() => ({}));
let last = "", status;
for (;;) {
  status = await report();
  const line = `${status.status}/${status.stage ?? ""} attempt=${status.attempt ?? ""}`;
  if (line !== last) { log(line, ((Date.now() - started) / 1000).toFixed(0) + "s"); last = line; }
  if (status.status === "ready" || status.status === "failed") break;
  if (Date.now() - started > 20 * 60_000) { log("timeout"); break; }
  await p.waitForTimeout(5000);
}
log("total", ((Date.now() - started) / 1000).toFixed(0) + "s");
fs.writeFileSync(path.join(OUT, "report-status.json"), JSON.stringify(status, null, 1));
await p.goto(`${BASE}/artifact/product/${PRODUCT}/conversation/${conversationId}?debug=1`);
await p.waitForTimeout(4000);
await p.screenshot({ path: path.join(OUT, "04-report.png"), fullPage: true });
for (const name of ["free.pdf", "preview.png", "full.pdf"]) {
  const r = await p.request.get(`${BASE}/v1/web-chat/conversations/${conversationId}/report/files/${name}`);
  log(name, r.status());
  if (r.ok()) fs.writeFileSync(path.join(OUT, name), await r.body());
}
await browser.close();
