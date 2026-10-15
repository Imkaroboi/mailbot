const systemLabels = new Map([
  ['\\Inbox', 'INBOX'], ['\\Sent', 'SENT'], ['\\Drafts', 'DRAFT'], ['\\Draft', 'DRAFT'],
  ['\\Trash', 'TRASH'], ['\\Spam', 'SPAM'], ['\\Junk', 'SPAM'], ['\\Starred', 'STARRED'],
  ['\\Flagged', 'STARRED'], ['\\Important', 'IMPORTANT'], ['Important', 'IMPORTANT'],
]);

export function normalizeImapMessage(message, spam = false) {
  // ImapFlow exposes X-GM-MSGID as a decimal string. Gmail REST IDs use hex.
  if (!message.emailId || !/^\d+$/.test(message.emailId)) throw new Error('Gmail did not provide a usable message ID.');
  const id = BigInt(message.emailId).toString(16);
  const labels = [...(message.labels || [])].map(label => systemLabels.get(label) || label);
  if (message.flags?.has('\\Draft')) labels.push('DRAFT');
  if (message.flags?.has('\\Flagged')) labels.push('STARRED');
  if (!message.flags?.has('\\Seen')) labels.push('UNREAD');
  if (spam) labels.push('SPAM');
  if (labels.some(label => ['SENT', 'DRAFT', 'TRASH'].includes(label))) return null;
  const from = message.envelope?.from?.find(value => value.address?.includes('@'));
  if (!from) return null;
  return {
    id, sender: from.address.trim().toLowerCase(), name: from.name || from.address,
    title: message.envelope?.subject || '(No subject)',
    date: Number(new Date(message.internalDate || message.envelope?.date || 0)) || 0,
    size: typeof message.size === 'number' ? message.size : null, labels: [...new Set(labels)],
  };
}

export async function scanImapHeaders(client, emit, signal, options = {}) {
  const sender = options.sender?.trim().toLowerCase();
  if (sender && (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(sender) || sender.length > 254)) throw new Error('Invalid sender address.');
  const abort = () => client.close();
  signal?.addEventListener('abort', abort, { once: true });
  const check = () => { if (signal?.aborted) throw new DOMException('Indexing paused', 'AbortError'); };
  const started = Date.now(); const seen = new Set();
  let checked = 0; let total = 0; let mailboxCount = 0;
  try {
    check(); await client.connect(); check();
    if (!client.capabilities.has('X-GM-EXT-1')) throw new Error('This connection does not expose Gmail message IDs.');
    const folders = await client.list();
    const allMail = folders.find(folder => folder.specialUse === '\\All');
    const spam = folders.find(folder => folder.specialUse === '\\Junk');
    if (!allMail) throw new Error('Gmail All Mail is not visible in IMAP. Enable Show in IMAP for All Mail in Gmail settings.');
    // Snapshot stable UIDs before fetching. Trashing messages concurrently can
    // change sequence numbers, but these UID snapshots retain their identity.
    const snapshots = [];
    for (const folder of [allMail, spam].filter(Boolean)) {
      check(); await client.mailboxOpen(folder.path, { readOnly: true });
      const uids = await client.search({ gmailraw: `in:anywhere ${sender ? `from:(${sender}) ` : ''}-in:sent -in:drafts -in:trash` }, { uid: true });
      if (!Array.isArray(uids)) throw new Error('Gmail could not list this mailbox.');
      snapshots.push({ path: folder.path, spam: folder === spam, uids }); total += uids.length;
    }
    await emit({ type: 'progress', checked, total, indexed: seen.size, rate: 0 });
    for (const snapshot of snapshots) {
      check(); await client.mailboxOpen(snapshot.path, { readOnly: true }); mailboxCount++;
      const newestFirst = [...snapshot.uids].sort((a, b) => b - a);
      for (let offset = 0; offset < newestFirst.length; offset += 500) {
        check(); const uids = newestFirst.slice(offset, offset + 500); const messages = [];
        for await (const message of client.fetch(uids, { uid: true, emailId: true, envelope: true, labels: true, flags: true, internalDate: true, size: true }, { uid: true })) {
          check(); const normalized = normalizeImapMessage(message, snapshot.spam);
          if (normalized && (!sender || normalized.sender === sender) && !seen.has(normalized.id)) { seen.add(normalized.id); messages.push(normalized); }
        }
        checked += uids.length;
        await emit({ type: 'messages', messages, checked, total, indexed: seen.size, rate: checked / Math.max(1, (Date.now() - started) / 1000) });
      }
    }
    check();
    await emit({ type: 'complete', checked, total, indexed: seen.size, mailboxCount, seconds: (Date.now() - started) / 1000 });
  } finally {
    signal?.removeEventListener('abort', abort);
    client.close();
  }
}
