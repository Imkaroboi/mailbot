import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'mailbot-fast-only-'));
const outfile = join(temp, 'mail.mjs');
await build({ entryPoints: ['lib/google-mail.ts'], bundle: true, platform: 'node', format: 'esm', outfile });
const api = await import(outfile);
globalThis.window = { MAILBOT_CONFIG: { scannerUrl: 'https://scanner.example' } };
const session = { email: 'fast-only@example.com', name: 'Test', token: 'fake', expiresAt: Date.now() + 3600000, imap: true, fastReader: 'https://scanner.example' };
const headers = Array.from({ length: 1005 }, (_, i) => ({ id: (i + 1).toString(16), sender: 'news@example.com', name: 'News', title: `Message ${i}`, date: 1700000000000, labels: ['INBOX'], size: 1234 }));
const stream = (messages = headers) => new Response([
  JSON.stringify({ type: 'messages', messages, checked: messages.length, total: messages.length }),
  JSON.stringify({ type: 'complete', checked: messages.length, total: messages.length, indexed: messages.length, seconds: 1 }),
].join('\n') + '\n');

test('all scan entry points refuse legacy sessions without making any request', async () => {
  let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('Unexpected request'); };
  const legacy = { ...session, imap: false, fastReader: undefined };
  await assert.rejects(api.scanSenderDirectory(legacy, new Set(), () => {}, async () => {}), /Connect fast scanning/);
  await assert.rejects(api.scanGoogleMail(legacy), /Reconnect Google/);
  await assert.rejects(api.findSenderMail(legacy, 'news@example.com'), /Connect fast scanning/);
  await assert.rejects(api.readSenderDirectory(legacy, 'news@example.com', undefined, undefined, headers), /Reconnect Google/);
  assert.equal(requests, 0);
});

test('Overview and load-more use one bulk stream with zero per-message requests', async () => {
  let streams = 0, reads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.origin === 'https://scanner.example') { streams++; return stream(); }
    if (url.pathname.endsWith('/profile')) return Response.json({ messagesTotal: 2000 });
    assert.ok(url.pathname.endsWith('/messages'), 'no metadata or thread-detail requests');
    reads++;
    // Include a nonexistent/sent candidate: it cannot enter the received-mail review.
    return Response.json({ messages: [...headers.map(message => ({ id: message.id })), { id: 'ffff' }] });
  };
  const result = await api.scanGoogleMail(session);
  assert.equal(streams, 1); assert.equal(reads, 5);
  assert.equal(result.candidateTotal, 1005); assert.equal(result.items.length, 100);
  assert.equal(result.pending.length, 905); assert.ok(result.pending.every(entry => entry.message.id === entry.id));
  let batch = await api.loadGoogleMailBatch(session, result.pending, 2000);
  assert.equal(batch.items.length, 100); assert.equal(streams, 1); assert.equal(reads, 5);
});

test('even one missing cached sender header uses the fast stream', async () => {
  let streams = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.origin === 'https://scanner.example') { streams++; assert.equal(JSON.parse(init.body).sender, 'news@example.com'); return stream(headers.slice(0, 2)); }
    assert.ok(url.pathname.endsWith('/messages'));
    return Response.json({ messages: url.searchParams.get('q').includes('is:starred') || url.searchParams.get('q').includes('label:IMPORTANT') ? [] : headers.slice(0, 2).map(message => ({ id: message.id })) });
  };
  const result = await api.readSenderDirectory(session, 'news@example.com', undefined, undefined, headers.slice(0, 1));
  assert.equal(result.length, 2); assert.equal(streams, 1);
});

test('a failed rule search cancels the parallel scanner without falling back', async () => {
  let scannerAborted = false;
  globalThis.fetch = async (input, init) => {
    if (new URL(input).origin === 'https://scanner.example') return new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => { scannerAborted = true; controller.error(new DOMException('Cancelled', 'AbortError')); }, { once: true });
    } }));
    return Response.json({ error: { message: 'Unavailable' } }, { status: 503 });
  };
  await assert.rejects(api.scanGoogleMail({ ...session, email: 'failure@example.com' }), /Unavailable/);
  assert.equal(scannerAborted, true);
});

test.after(async () => { await rm(temp, { recursive: true, force: true }); });
