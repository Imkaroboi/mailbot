import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { tokenVerifier } from '../auth.mjs';
import { createScannerServer } from '../http.mjs';

const origin = 'https://app.example';
const headers = { Origin: origin, Authorization: 'Bearer fake-user-a', 'Content-Type': 'application/json' };
async function serve(t, overrides = {}) {
  const connections = [];
  const server = createScannerServer({ allowedOrigins: new Set([origin]), verifyToken: async token => `${token}@example.com`,
    createClient: (account, token) => { const client = { account, token, closed: false, close() { this.closed = true; } }; connections.push(client); return client; },
    scan: async (client, emit) => emit({ type: 'complete', checked: 0, total: 0, indexed: 0 }), ...overrides });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, connections };
}

test('verifies client, expiry, full mail scope, and identity through Google', async () => {
  let info = { aud: 'public-client', expires_in: '3600', scope: 'https://mail.google.com/' };
  const calls = [];
  const verify = tokenVerifier(new Set(['public-client']), async (url, init) => {
    calls.push([url, init]);
    return Response.json(url.endsWith('/tokeninfo') ? info : { emailAddress: 'Verified@Example.com' });
  });
  assert.equal(await verify('fake-token'), 'verified@example.com');
  assert.equal(calls[0][0], 'https://oauth2.googleapis.com/tokeninfo');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].body.get('access_token'), 'fake-token');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer fake-token');
  for (const invalid of [{ aud: 'another-client' }, { expires_in: '0' }, { scope: 'gmail.modify' }]) {
    const saved = info; info = { ...info, ...invalid };
    await assert.rejects(verify('fake-token')); info = saved;
  }
});

test('CORS, authorization, and options cannot spoof another account or host', async t => {
  const { url, connections } = await serve(t);
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/scan`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${url}/scan`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  for (const body of ['null', '{', '{"email":"victim@example.com"}', '{"host":"evil.example"}', '{"sender":"bad"}']) {
    assert.equal((await fetch(`${url}/scan`, { method: 'POST', headers, body })).status, 400);
  }
  assert.equal((await fetch(`${url}/scan`, { method: 'POST', headers, body: JSON.stringify({ sender: 'a'.repeat(2100) }) })).status, 413);
  assert.equal(connections.length, 0);
  const response = await fetch(`${url}/scan`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(await response.text(), /complete/);
  assert.equal(connections[0].account, 'fake-user-a@example.com');
  assert.ok(connections[0].closed);
});

test('isolates simultaneous visitors, caps same-account scans, and closes cancelled connections', async t => {
  const { url, connections } = await serve(t, { scan: async (_client, _emit, signal) => {
    if (!signal.aborted) await once(signal, 'abort');
  } });
  const a = new AbortController(), b = new AbortController(), c = new AbortController();
  const post = (token, signal) => fetch(`${url}/scan`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: '{}', signal });
  const responses = await Promise.all([post('a', a.signal), post('a', b.signal), post('b', c.signal)]);
  assert.ok(responses.every(response => response.ok));
  const blocked = await post('a'); assert.equal(blocked.status, 409); await blocked.text();
  assert.deepEqual(connections.map(client => client.account).sort(), ['a@example.com', 'a@example.com', 'b@example.com']);
  a.abort(); b.abort(); c.abort();
  for (let i = 0; i < 40 && connections.some(client => !client.closed); i++) await delay(5);
  assert.ok(connections.every(client => client.closed));
  for (const response of responses) await response.body.cancel().catch(() => {});
});

test('capacity includes requests waiting for token verification', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { url } = await serve(t, { maxConnections: 1, verifyToken: async () => { await gate; return 'a@example.com'; } });
  const pending = fetch(`${url}/scan`, { method: 'POST', headers, body: '{}' });
  await delay(20);
  const busy = await fetch(`${url}/scan`, { method: 'POST', headers, body: '{}' });
  assert.equal(busy.status, 503); release(); await (await pending).text();
});

test('deadline closes the IMAP connection and reports a resumable error', async t => {
  const { url, connections } = await serve(t, { timeoutMs: 40, scan: async (_client, _emit, signal) => { if (!signal.aborted) await once(signal, 'abort'); throw new Error('private error data'); } });
  const response = await fetch(`${url}/scan`, { method: 'POST', headers, body: '{}' });
  const body = await response.text();
  assert.match(body, /time limit/); assert.doesNotMatch(body, /private error data/);
  assert.ok(connections[0].closed);
});
