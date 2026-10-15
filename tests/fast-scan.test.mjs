import assert from 'node:assert/strict';
import { scanImapHeaders, normalizeImapMessage } from '../backend/scanner/reader.mjs';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp = await mkdtemp(join(tmpdir(), 'mailbot-stream-')); 
const outfile = join(temp, 'reader.mjs');
await build({ entryPoints: ['lib/fast-reader.ts'], bundle: true, platform: 'node', format: 'esm', outfile });
const { scanFastSenderDirectory } = await import(outfile);
const deleted = new Set(); let folder = ''; let fetches = 0; let closed = false;
const client = {
  capabilities: new Map([['X-GM-EXT-1', true]]),
  connect: async () => {}, close: () => { closed = true; },
  list: async () => [{ path: 'All', specialUse: '\\All' }, { path: 'Spam', specialUse: '\\Junk' }],
  mailboxOpen: async (path, options) => { assert.equal(options.readOnly, true); folder = path; },
  search: async (_query, options) => { assert.equal(options.uid, true); return Array.from({ length: folder === 'All' ? 21000 : 10 }, (_, index) => index + 1); },
  async *fetch(uids, options, mode) {
    assert.equal(mode.uid, true); assert.equal(options.source, undefined); assert.equal(options.bodyParts, undefined);
    assert.ok(uids.length <= 500); fetches++;
    for (const uid of uids) {
      if (deleted.has(uid) && folder === 'All') continue;
      const id = 1000000000000000000n + BigInt(folder === 'Spam' && uid > 5 ? 30000 + uid : uid);
      yield { uid, emailId: String(id), size: 1234, internalDate: new Date('2026-01-01'), flags: new Set(['\\Seen']), labels: new Set(['\\Inbox']), envelope: { from: [{ address: 'news@example.com', name: 'News' }], subject: `Email ${uid}` } };
    }
  },
};
globalThis.window = { MAILBOT_CONFIG: { scannerUrl: 'https://scanner.example' } };
const session = { fastReader: 'https://scanner.example', token: 'mock', expiresAt: Date.now() + 60000, email: 'mock@example.com', name: 'Mock', imap: true };
globalThis.fetch = async () => {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        await scanImapHeaders(client, async event => {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
          if (event.type === 'messages' && !deleted.size) deleted.add(777); // Concurrent Trash removes a pending UID.
        });
        controller.close();
      } catch (error) { controller.error(error); }
    },
  }));
};
let cached = new Map(); let reconciled = false;
const result = await scanFastSenderDirectory(session, ids => { reconciled = true; assert.equal(ids.size, cached.size); }, async messages => {
  for (const message of messages) cached.set(message.id, message);
});
assert.equal(result.indexed, 21004); // 21k - one concurrently removed + five distinct spam messages.
assert.equal(fetches, 43);
assert.equal(cached.has((1000000000000000000n + 777n).toString(16)), false);
assert.equal(cached.has((1000000000000000000n + 778n).toString(16)), true, 'UID deletion must not shift or skip neighboring emails');
assert.ok(reconciled && closed);
assert.equal(normalizeImapMessage({ emailId: '1000000000000000123', labels: new Set(['\\Sent']) }), null);
assert.equal(normalizeImapMessage({ emailId: '1000000000000000123', flags: new Set(['\\Draft']) }), null);
globalThis.fetch = async () => new Response('{"type":"messages","messages":[],"checked":1,"total":2}\n');
await assert.rejects(scanFastSenderDirectory(session, () => { throw new Error('Must not reconcile a partial scan'); }, async () => {}), /interrupted/);
console.log('21,000-message streaming, 500-header reads, exact Gmail IDs, concurrent Trash UID stability, and incomplete-stream protection passed.');

await assert.rejects(scanFastSenderDirectory({ ...session, fastReader: 'https://other.example' }, () => {}, async () => {}), /authorize/);
await assert.rejects(scanFastSenderDirectory({ ...session, expiresAt: 0 }, () => {}, async () => {}), /expired/);
await rm(temp, { recursive: true, force: true });
