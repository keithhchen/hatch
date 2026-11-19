import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { handleReportAssetRoute } from "./reportAssets.js";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => void handleReportAssetRoute(req, res, new URL(req.url!, "http://x")).then(done => { if (!done) { res.writeHead(404); res.end(); } }));
  await new Promise<void>(resolve => server.listen(0, resolve));
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`); } finally { server.close(); }
}

test("/report-assets/v1 serves the stylesheet and script with their types and an immutable year-long cache", () => withServer(async base => {
  const css = await fetch(`${base}/report-assets/v1/report.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type")!, /^text\/css/);
  assert.equal(css.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.match(await css.text(), /\.ring/);
  const js = await fetch(`${base}/report-assets/v1/report.js`);
  assert.match(js.headers.get("content-type")!, /^text\/javascript/);
  assert.equal(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.match(await js.text(), /reportFinish/);
}));

test("/report-assets answers 404 for an unknown version, file or traversal, and never caches the miss", () => withServer(async base => {
  for (const p of ["/report-assets/v9/report.css", "/report-assets/v1/other.css", "/report-assets/v1/../../package.json", "/report-assets/v1/report.css/x"]) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 404, p);
    assert.notEqual(r.headers.get("cache-control"), "public, max-age=31536000, immutable");
  }
}));
