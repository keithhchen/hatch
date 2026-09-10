import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDashboardApp } from '../server.mjs';

// Explicit upstream fixture for auth/transport tests, never product UAT.
test('Factory reuses Dashboard Creator cookie, CSRF and streams authenticated Registry results', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dashboard-factory-test-'));
  const productId = '22222222-2222-4222-8222-222222222222';
  const factoryRoot = `/v1/creator/products/${productId}/factory-agents`;
  let role = 'creator'; let calls = 0;
  let streamClosed; const closed = new Promise(resolve => { streamClosed = resolve; });
  const registry = createServer((req, res) => {
    const account = { id: '11111111-1111-4111-8111-111111111111', email: 'fixture@example.test', display_name: 'Fixture', role };
    if (req.url === '/v1/auth/signin') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ account, token: 'fixture-registry-token' })); }
    if (req.url === '/v1/auth/me') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(account)); }
    assert.equal(req.headers.authorization, 'Bearer fixture-registry-token'); calls++;
    assert.ok(req.url.startsWith(factoryRoot));
    if (req.url.endsWith('/events')) { res.setHeader('content-type', 'text/event-stream'); res.once('close', streamClosed); return res.write('data: {"type":"state"}\n\n'); }
    if (req.url.includes('/files?') && req.method === 'GET') {
      res.statusCode = 206;
      res.setHeader('content-type', 'text/markdown');
      res.setHeader('content-disposition', 'attachment; filename="RESULT.md"');
      res.setHeader('cache-control', 'private, no-store');
      return res.end(Buffer.from('# Real bytes\n'));
    }
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/config')) return res.end(JSON.stringify({ services: { model: true } }));
    if (req.method === 'POST') { res.statusCode = 201; return res.end(JSON.stringify({ id: 'fixture-chat' })); }
    res.end(JSON.stringify({ sessions: [] }));
  });
  await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
  const dashboard = await createDashboardApp({ ledgerPath: path.join(root, 'ledger.jsonl'), registryUrl: `http://127.0.0.1:${registry.address().port}` });
  const api = createServer(dashboard.handler);
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.address().port}`;
  try {
    assert.equal((await fetch(`${base}${factoryRoot}/sessions`)).status, 401);
    const login = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'fixture@example.test', password: 'fixture-only' }) });
    assert.equal(login.status, 200);
    const cookies = login.headers.getSetCookie().map(v => v.split(';')[0]);
    const cookie = cookies.join('; ');
    const csrf = decodeURIComponent(cookies.find(v => v.startsWith('hatch_web_csrf=')).split('=')[1]);
    const headers = { cookie, 'content-type': 'application/json' };
    const route = `${base}${factoryRoot}/sessions`;
    assert.equal((await fetch(`${base}/v1/creator/factory-agents/sessions`, { headers: { cookie } })).status, 404);
    assert.equal(calls, 0);
    assert.equal((await fetch(route, { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal(calls, 0);
    const response = await fetch(route, { method: 'POST', headers: { ...headers, 'x-csrf-token': csrf }, body: JSON.stringify({ role: 'research' }) });
    assert.equal(response.status, 201); assert.deepEqual(await response.json(), { id: 'fixture-chat' });
    const config = await fetch(`${base}${factoryRoot}/config`, { headers: { cookie } });
    assert.equal(config.status, 200); assert.deepEqual(await config.json(), { services: { model: true } });
    const controller = new AbortController();
    const events = await fetch(`${base}${factoryRoot}/events`, { headers: { cookie }, signal: controller.signal });
    assert.match(events.headers.get('content-type'), /text\/event-stream/);
    const first = await events.body.getReader().read();
    assert.equal(new TextDecoder().decode(first.value), 'data: {"type":"state"}\n\n');
    controller.abort();
    await closed;
    const download = await fetch(`${base}${factoryRoot}/sessions/fixture-chat/files?path=output%2FRESULT.md&download=1`, { headers: { cookie } });
    assert.equal(download.status, 206);
    assert.equal(download.headers.get('content-disposition'), 'attachment; filename="RESULT.md"');
    assert.equal(await download.text(), '# Real bytes\n');
    assert.equal((await fetch(route, { headers: { cookie } })).status, 200);
    role = 'user';
    assert.equal((await fetch(route, { headers: { cookie } })).status, 403);
    assert.equal(calls, 5);
  } finally {
    api.closeAllConnections(); registry.closeAllConnections();
    await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => registry.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  }
});
