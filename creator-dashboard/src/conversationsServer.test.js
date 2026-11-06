import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDashboardApp } from '../server.mjs';

// Explicit upstream fixture for auth/transport tests, never product UAT: it only checks that
// the conversation paths reach Registry the same way for bearer and cookie callers.
test('worker and Assistant conversation paths reach Registry for bearer and cookie callers', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dashboard-conversations-test-'));
  const productId = '22222222-2222-4222-8222-222222222222';
  const workers = `/v1/creator/products/${productId}/workers`;
  const account = { id: '11111111-1111-4111-8111-111111111111', email: 'fixture@example.test', display_name: 'Fixture' };
  const seen = [];
  const registry = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/auth/signin') return res.end(JSON.stringify({ account, token: 'cookie-token' }));
    if (req.url === '/v1/auth/me') return res.end(JSON.stringify(account));
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    if (req.url.endsWith('/events')) { res.setHeader('content-type', 'text/event-stream'); return res.end('data: {"type":"state"}\n\n'); }
    if (req.method === 'POST') { res.statusCode = 202; return res.end(JSON.stringify({ accepted: true })); }
    res.end(JSON.stringify({ workers: [] }));
  });
  await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
  const dashboard = await createDashboardApp({ ledgerPath: path.join(root, 'ledger.jsonl'), registryUrl: `http://127.0.0.1:${registry.address().port}`, publicOrigin: 'http://dashboard.test' });
  const api = createServer(dashboard.handler);
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.address().port}`;
  const paths = [
    ['GET', workers],
    ['GET', `${workers}/research/messages?after=m1&limit=5`],
    ['POST', `${workers}/research/messages?wait=60`, { content: 'hi' }],
    ['GET', `${workers}/research/events`],
    ['POST', `${workers}/research/stop`, {}],
    ['GET', '/v1/creator/assistant/conversation/messages'],
    ['POST', '/v1/creator/assistant/conversation/messages?wait=60', { content: 'hi' }]
  ];
  try {
    assert.equal((await fetch(`${base}${workers}`)).status, 401);
    assert.equal(seen.length, 0);

    // Bearer callers: API key or CLI session.
    for (const [method, route, body] of paths) {
      const response = await fetch(`${base}${route}`, { method, headers: { authorization: 'Bearer api-key-1', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, method === 'POST' ? 202 : 200, `${method} ${route}`);
      await response.text();
    }
    assert.deepEqual(seen.map(call => `${call.method} ${call.url}`), paths.map(([method, route]) => `${method} ${route}`), 'query strings are forwarded untouched');
    assert.ok(seen.every(call => call.authorization === 'Bearer api-key-1'));
    assert.equal(seen[2].body, JSON.stringify({ content: 'hi' }));

    // Cookie callers: Studio web, with CSRF on writes.
    seen.length = 0;
    const login = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: account.email, password: 'fixture-only' }) });
    assert.equal(login.status, 200);
    const cookies = login.headers.getSetCookie().map(value => value.split(';')[0]);
    const csrf = decodeURIComponent(cookies.find(value => value.startsWith('hatch_web_csrf=')).split('=')[1]);
    const cookie = cookies.join('; ');
    assert.equal((await fetch(`${base}${workers}/research/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"content":"hi"}' })).status, 403);
    assert.equal(seen.length, 0);
    const sent = await fetch(`${base}${workers}/research/messages?wait=60`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: '{"content":"hi"}' });
    assert.equal(sent.status, 202);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${workers}/research/messages?wait=60`);
    assert.equal(seen[0].authorization, 'Bearer cookie-token');
    const history = await fetch(`${base}/v1/creator/assistant/conversation/messages`, { headers: { cookie } });
    assert.equal(history.status, 200);
  } finally {
    api.closeAllConnections(); registry.closeAllConnections();
    await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => registry.close(resolve))]);
  }
});
