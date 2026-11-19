import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { handleReportAssetRoute } from "./reportAssets.js";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => void handleReportAssetRoute(req, res, new URL(req.url!, "http://x")).then(done => { if (!done) { res.writeHead(404); res.end(); } }));
  await new Promise<void>(resolve => server.listen(0, resolve));
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`); } finally { server.close(); }
}

test("/report-assets/v1 serves the stylesheet and script with their types and a one-hour cache", () => withServer(async base => {
  const css = await fetch(`${base}/report-assets/v1/report.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type")!, /^text\/css/);
  assert.equal(css.headers.get("cache-control"), "public, max-age=3600");
  assert.match(await css.text(), /\.ring/);
  const js = await fetch(`${base}/report-assets/v1/report.js`);
  assert.match(js.headers.get("content-type")!, /^text\/javascript/);
  assert.equal(js.headers.get("cache-control"), "public, max-age=3600");
  assert.match(await js.text(), /reportFinish/);
}));

test("/report-assets answers 404 for an unknown version, file or traversal, and never caches the miss", () => withServer(async base => {
  for (const p of ["/report-assets/v9/report.css", "/report-assets/v1/other.css", "/report-assets/v1/../../package.json", "/report-assets/v1/report.css/x"]) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 404, p);
    assert.notEqual(r.headers.get("cache-control"), "public, max-age=3600");
  }
}));

const SCRIPT = (await import("node:fs")).readFileSync(new URL("../../report-assets/v1/report.js", import.meta.url), "utf8");
const DATA = { score: 20, dots: [60, 25, 14, 1], dims: [1, 1, 1, 1, 1, 1, 1, 1, 1], six: [0, 0, 0, 0, 0, 0], total: { sum: 9, deduct: 0 }, items: [], sources: ["a"] };
const red = (n: number) => `<div><h3>R${n}</h3><p>evidence ${n}</p></div>`;
const reasonOf = (n: number) => `<div class="see"><h3>S${n}</h3><p>see</p></div><p class="think">T${n}</p>`;
const page = (body: string) => `<main><section class="hero"></section><section id="journey"><div class="journey"><p>a</p><p>b</p><p>c</p><p>d</p></div></section>${body}<section id="dimensions"></section><section id="sustain"><div class="sus"></div></section><section id="services"></section><section id="appendix"></section></main><footer></footer><script type="application/json" id="report-data">${JSON.stringify(DATA)}</script>`;

test("report.js gives each hand-written red line, reason and minor reason its own block, and leaves correct markup as it is", async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true, ...(process.env.HATCH_CHROMIUM_PATH ? { executablePath: process.env.HATCH_CHROMIUM_PATH } : {}) }).catch(() => undefined);
  if (!browser) return; // no browser on this machine: the render check is skipped
  try {
    const shape = async (body: string) => {
      const p = await browser.newPage();
      await p.setContent(page(body));
      await p.evaluate(SCRIPT);
      const out = await p.evaluate(() => ({
        redlines: [...document.querySelectorAll(".redline")].map(b => [...b.children].map(c => c.tagName + ":" + c.textContent!.replace(/\s+/g, ""))),
        reasons: [...document.querySelectorAll(".reason")].map(b => [...b.children].map(c => c.className)),
        minors: [...document.querySelectorAll(".minors>*")].map(c => c.tagName + ":" + c.textContent!.replace(/\s+/g, "")),
        journey: document.querySelectorAll(".jstat").length
      }));
      await p.close();
      return out;
    };
    const good = await shape(`<section id="redlines">${`<div class="redline">${red(1)}</div>`}</section><section id="reasons"><div class="reason">${reasonOf(1)}</div><div class="reason">${reasonOf(2)}</div></section><section id="minor"><div class="minors">${red(1)}${red(2)}</div></section>`);
    assert.deepEqual(good.redlines, [["DIV:R1evidence1"]]);
    assert.deepEqual(good.reasons, [["see", "think"], ["see", "think"]]);
    assert.deepEqual(good.minors, ["DIV:R1evidence1", "DIV:R2evidence2"]);
    // two red lines in one .redline (divs, or flat h3 + p), two see/think pairs in one .reason, flat minors
    const packed = await shape(`<section id="redlines"><div class="redline">${red(1)}${red(2)}</div><div class="redline"><h3>R3</h3><p>evidence 3</p><h3>R4</h3><p>evidence 4</p></div></section><section id="reasons"><div class="reason">${reasonOf(1)}${reasonOf(2)}</div></section><section id="minor"><div class="minors"><h3>M1</h3><p>x</p><h3>M2</h3><p>y</p></div></section>`);
    assert.deepEqual(packed.redlines, [["DIV:R1evidence1"], ["DIV:R2evidence2"], ["DIV:R3evidence3"], ["DIV:R4evidence4"]]);
    assert.deepEqual(packed.reasons, [["see", "think"], ["see", "think"]]);
    assert.deepEqual(packed.minors, ["DIV:M1x", "DIV:M2y"]);
    assert.equal(packed.journey, 4);
  } finally { await browser.close(); }
});

test("report.js shows the content at once: no loader is built, and an old page's own .loader is removed", async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true, ...(process.env.HATCH_CHROMIUM_PATH ? { executablePath: process.env.HATCH_CHROMIUM_PATH } : {}) }).catch(() => undefined);
  if (!browser) return; // no browser on this machine: the render check is skipped
  try {
    const css = (await import("node:fs")).readFileSync(new URL("../../report-assets/v1/report.css", import.meta.url), "utf8");
    const open = async (body: string) => {
      const p = await browser.newPage();
      await p.setContent(`<style>${css}</style>${page(body)}`);
      await p.evaluate(SCRIPT);
      return p;
    };
    const fresh = await open("");
    assert.equal(await fresh.locator(".loader").count(), 0);
    assert.equal(await fresh.evaluate(() => document.body.classList.contains("ready")), true);
    assert.equal(await fresh.locator(".ring strong").isVisible(), true);
    assert.equal(await fresh.locator("#journey").isVisible(), true);
    assert.equal(await fresh.evaluate(() => typeof (window as unknown as { reportFinish: unknown }).reportFinish), "function");
    await fresh.evaluate(() => (window as unknown as { reportFinish: () => void }).reportFinish());
    assert.equal(await fresh.locator("main>section.visible").count(), 5);
    // an old report: the agent wrote a .loader into the HTML before the script ran
    const old = await browser.newPage();
    await old.setContent(`<style>${css}</style><div class="loader"><div class="loadbox">精准分析中…</div></div>${page("")}`);
    assert.equal(await old.locator(".loader").isVisible(), false, "hidden by the stylesheet before the script runs");
    await old.evaluate(SCRIPT);
    assert.equal(await old.locator(".loader").count(), 0);
    assert.equal(await old.locator(".ring strong").isVisible(), true);
    assert.equal(await old.evaluate(() => document.elementFromPoint(100, 100)?.closest(".loader") === null), true);
  } finally { await browser.close(); }
});
