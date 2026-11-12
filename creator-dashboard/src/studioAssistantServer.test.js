import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDashboardApp } from '../server.mjs';

// Explicit upstream fixture for transport tests, never product UAT: it only checks that Studio's Assistant page
// reaches Registry's conversation API as a cookie caller, CSRF on writes, with an upload kept as raw bytes.
test('the Assistant page reaches the conversation API: view, timezone, raw upload and image, with CSRF on writes', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dashboard-assistant-test-'));
  const account = { id: '11111111-1111-4111-8111-111111111111', email: 'fixture@example.test', display_name: 'Fixture' };
  const seen = [];
  const registry = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/auth/signin') return res.end(JSON.stringify({ account, token: 'cookie-token' }));
    if (req.url === '/v1/auth/me') return res.end(JSON.stringify(account));
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(chunks) });
    res.statusCode = req.method === 'POST' ? 201 : 200;
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
  const dashboard = await createDashboardApp({ ledgerPath: path.join(root, 'ledger.jsonl'), registryUrl: `http://127.0.0.1:${registry.address().port}`, publicOrigin: 'http://dashboard.test' });
  const api = createServer(dashboard.handler);
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.address().port}`;
  const C = '/v1/creator/assistant/conversation';
  try {
    const login = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: account.email, password: 'fixture-only' }) });
    const cookies = login.headers.getSetCookie().map(value => value.split(';')[0]);
    const csrf = decodeURIComponent(cookies.find(value => value.startsWith('hatch_web_csrf=')).split('=')[1]);
    const cookie = cookies.join('; ');
    const bytes = Buffer.from([0, 255, 1, 254, 137, 80, 78, 71]);

    assert.equal((await fetch(`${base}${C}/view?limit=50`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}${C}/assets/a-1`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}${C}/messages?before=abc`, { headers: { cookie } })).status, 200);
    assert.deepEqual(seen.map(call => `${call.method} ${call.url}`), [`GET ${C}/view?limit=50`, `GET ${C}/assets/a-1`, `GET ${C}/messages?before=abc`]);

    seen.length = 0;
    const noCsrf = [
      await fetch(`${base}${C}/assets?name=a.png`, { method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: bytes }),
      await fetch(`${base}${C}/timezone`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: '{"timezone":"Asia/Tokyo"}' })
    ];
    assert.deepEqual(noCsrf.map(response => response.status), [403, 403]);
    assert.equal(seen.length, 0);

    const uploaded = await fetch(`${base}${C}/assets?name=a.png`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'image/png' }, body: bytes });
    assert.equal(uploaded.status, 201);
    assert.equal(seen[0].url, `${C}/assets?name=a.png`);
    assert.equal(seen[0].type, 'image/png');
    assert.deepEqual(seen[0].body, bytes, 'the file reaches Registry byte for byte');
    const zone = await fetch(`${base}${C}/timezone`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: '{"timezone":"Asia/Tokyo"}' });
    assert.equal(zone.status, 200);
    assert.equal(seen[1].method, 'PUT');
    assert.equal(seen[1].body.toString(), '{"timezone":"Asia/Tokyo"}');
    assert.ok(seen.every(call => call.authorization === 'Bearer cookie-token'));
  } finally {
    api.closeAllConnections(); registry.closeAllConnections();
    await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => registry.close(resolve))]);
  }
});
