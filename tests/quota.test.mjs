import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('bulk writes bypass metadata pacing; account quotas stay independent', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mailbot-quota-'));
  try {
    const outfile = join(temp, 'mail.mjs');
    await build({ entryPoints: ['lib/google-mail.ts'], bundle: true, platform: 'node', format: 'esm', outfile });
    const { googleRequest } = await import(outfile);
    const started = performance.now(), sent = [];
    globalThis.fetch = async (url, init) => { sent.push({ token: init.headers.Authorization, at: performance.now() - started }); return Response.json({}); };
    const a = { email: 'a@example.com', token: 'fake-a', expiresAt: Date.now() + 60000 };
    const b = { ...a, email: 'b@example.com', token: 'fake-b' };
    await googleRequest(a, '/messages/1'); // Schedules the next metadata read 240ms later.
    await Promise.all(Array.from({ length: 3 }, () => googleRequest(a, '/messages/batchModify', { method: 'POST', body: '{}' })));
    await googleRequest(b, '/messages/1');
    assert.equal(sent.length, 5);
    assert.ok(sent.every(request => request.at < 200), 'available bulk/account quota must not wait on metadata pacing');
    const control = new AbortController(); control.abort();
    await assert.rejects(googleRequest(a, '/messages/batchModify', { method: 'POST' }, control.signal), { name: 'AbortError' });
    assert.equal(sent.length, 5);
    const c = { ...a, email: 'c@example.com' };
    await Promise.all(Array.from({ length: 100 }, () => googleRequest(c, '/messages/batchModify', { method: 'POST', body: '{}' })));
    assert.equal(sent.length, 105, '100 bulk requests spend exactly 5,000 units');
    const blockedController = new AbortController();
    const blocked = googleRequest(c, '/messages/batchModify', { method: 'POST' }, blockedController.signal);
    const rejected = assert.rejects(blocked, { name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sent.length, 105, 'cannot exceed the rolling quota budget');
    await googleRequest(b, '/messages/batchModify', { method: 'POST', body: '{}' });
    assert.equal(sent.length, 106, 'a busy account cannot block another account');
    blockedController.abort(); await rejected;
  } finally { await rm(temp, { recursive: true, force: true }); }
});
