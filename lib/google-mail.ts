import { mailItem, mailSearches, type CleanupItem } from './mailbot';
import { fastReaderEnabled, readFastSenderMail, scanFastSenderDirectory } from './fast-reader';

export type GoogleSession = { token: string; expiresAt: number; email: string; name: string; imap?: boolean; drive?: boolean; fastReader?: string };
export type SenderMessage = { id: string; title: string; date: string | null; size: number; labels: string[]; url: string };
export type IndexedMessage = { id: string; sender: string; name: string; title: string; date: number; size: number | null; labels: string[] };
export type DirectoryProgress = { phase: 'connecting' | 'listing' | 'indexing'; listed: number; indexed: number; total: number; mode?: 'imap'; rate?: number };
type Message = { id: string; internalDate?: string; sizeEstimate?: number; labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } };
export type ScanProgress = { phase: string; candidates: number; inspected: number; mailboxTotal: number };
export type PendingMessage = { id: string; category: string; message: IndexedMessage };
export type UndoMessage = { id: string; inInbox: boolean };
export type CleanupProgress = { phase: 'checking' | 'moving' | 'waiting'; total: number; batchSize: number; movedIds?: string[]; undoMessages?: UndoMessage[]; rate: number; seconds: number; waitSeconds?: number };
export type TrashOutcome = { moved: string[]; failed: string[]; remaining: string[]; cancelled: boolean; undo: UndoMessage[]; error?: string; seconds: number };
export const trashBatchSize = 1_000;
export const trashConcurrency = 3;
export const detailBatchSize = 100;
const root = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Keep a rolling per-account budget below Google's 6,000 units/minute limit.
// Pace metadata reads, but let bulk writes use available quota immediately.
const quotaUnitsPerMinute = 5_000;
type QuotaState = { ledger: { at: number; cost: number }[]; nextReadAt: number };
const quotas = new Map<string, QuotaState>();

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Scan cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); reject(new DOMException('Scan cancelled', 'AbortError')); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function quotaCost(path: string, method?: string) {
  if (path === '/profile') return 1;
  if (path === '/messages/batchModify') return 50;
  if (/^\/threads\/[^/?]+/.test(path)) return 40;
  if (method === 'POST' && /\/messages\/[^/]+\/trash$/.test(path)) return 20;
  if (/\/messages\/[^/?]+/.test(path)) return 20;
  return 5;
}
async function reserve(session: GoogleSession, cost: number, bulkWrite: boolean, signal?: AbortSignal): Promise<void> {
  const account = session.email.trim().toLowerCase() || 'pending-profile';
  let state = quotas.get(account);
  if (!state) { state = { ledger: [], nextReadAt: 0 }; quotas.set(account, state); }
  while (true) {
    if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
    const now = Date.now();
    state.ledger = state.ledger.filter(entry => entry.at > now - 60_000);
    const used = state.ledger.reduce((sum, entry) => sum + entry.cost, 0);
    let quotaWait = 0;
    if (used + cost > quotaUnitsPerMinute) {
      let released = 0;
      for (const entry of state.ledger) {
        released += entry.cost;
        if (used - released + cost <= quotaUnitsPerMinute) { quotaWait = entry.at + 60_000 - now; break; }
      }
    }
    const wait = Math.max(quotaWait, bulkWrite ? 0 : state.nextReadAt - now);
    if (wait > 0) { await pause(wait, signal); continue; }
    // No await between checking and recording: simultaneous callers cannot
    // spend the same remaining quota. Reads recheck after every wait.
    state.ledger.push({ at: now, cost });
    if (!bulkWrite) state.nextReadAt = now + cost * 60_000 / quotaUnitsPerMinute;
    return;
  }
}

export function senderAddress(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(trimmed) || trimmed.length > 254) throw new Error('Enter a complete sender email address, such as newsletter@example.com.');
  return trimmed;
}
export function fromAddress(value: string): string {
  return (value.match(/<([^<>]+)>/)?.[1] || value).trim().toLowerCase();
}
export async function googleRequest<T>(session: GoogleSession, path: string, init?: RequestInit, beforeSendSignal?: AbortSignal, onRetry?: (seconds: number) => void): Promise<T> {
  const signal = beforeSendSignal || init?.signal || undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (Date.now() >= session.expiresAt) throw new Error('Your Google session expired. Connect Google again to continue.');
      await reserve(session, quotaCost(path, init?.method), path === '/messages/batchModify', signal);
      if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
      const response = await fetch(root + path, { ...init, headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, cache: 'no-store' });
      // batchModify can return an empty successful response.
      const body = await response.text();
      const data = (body.trim() ? JSON.parse(body) : {}) as T & { error?: { message?: string; errors?: { reason?: string }[] } };
      if (response.ok) return data;
      const message = data.error?.message || 'Google could not complete this request.';
      const reason = data.error?.errors?.[0]?.reason || '';
      const quota = response.status === 429 || (response.status === 403 && (/quota|rate.?limit/i.test(message) || /quota|rate.?limit/i.test(reason)));
      if (quota && attempt < 3) {
        const delay = 30_000 * 2 ** attempt + Math.floor(Math.random() * 1000);
        onRetry?.(Math.ceil(delay / 1000));
        await pause(delay, signal);
        continue;
      }
      throw Object.assign(new Error(response.status === 401 ? 'Your Google session expired. Connect Google again.' : quota ? 'Gmail is still rate limited. Wait a minute and try again.' : message), { status: response.status });
    }
    throw new Error('Gmail could not complete this request.');
}
async function pool<T, R>(values: T[], task: (value: T) => Promise<R>, concurrency = 6, signal?: AbortSignal): Promise<R[]> {
  const results: R[] = new Array(values.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
      const index = next++; results[index] = await task(values[index]);
    }
  }));
  return results;
}
function metadata(session: GoogleSession, id: string, signal?: AbortSignal) {
  return googleRequest<Message>(session, `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&fields=id%2ClabelIds%2CinternalDate%2CsizeEstimate%2Cpayload%2Fheaders`, { signal });
}
function header(message: Message, name: string) { return message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''; }
export async function scanSenderDirectory(
  session: GoogleSession,
  knownIds: Set<string>,
  onList: (ids: Set<string>, estimate: number) => void | Promise<void>,
  onBatch: (messages: IndexedMessage[], progress: DirectoryProgress) => Promise<void>,
  onProgress?: (progress: DirectoryProgress) => void,
  signal?: AbortSignal,
) {
  return scanFastSenderDirectory(session, onList, onBatch, onProgress, signal);
}

export async function scanGoogleMail(session: GoogleSession, progress?: (value: ScanProgress) => void, signal?: AbortSignal) {
  if (!fastReaderEnabled(session)) throw new Error('Reconnect Google to enable fast scanning.');
  const controller = new AbortController();
  const scanSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const candidates = new Map<string, string>();
  const headers = new Map<string, IndexedMessage>();
  let mailboxTotal = 0; let inspected = 0;
  const report = (phase: string) => progress?.({ phase, candidates: candidates.size, inspected, mailboxTotal });
  // ID-only searches preserve Gmail's exact cleanup rules (including body-based
  // newsletter matching). All message details arrive through one bulk stream.
  try { await Promise.all([
    (async () => {
      const profile = await googleRequest<{ messagesTotal?: number }>(session, '/profile', { signal: scanSignal });
      mailboxTotal = profile.messagesTotal || 0;
      for (const search of mailSearches) {
        let pageToken = ''; const seenTokens = new Set<string>();
        do {
          const page = await googleRequest<{ messages?: { id: string }[]; nextPageToken?: string }>(session, `/messages?maxResults=500&includeSpamTrash=true&q=${encodeURIComponent(search.query)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { signal: scanSignal });
          for (const message of page.messages || []) if (!candidates.has(message.id)) candidates.set(message.id, search.category);
          report(`Searching ${search.category}`);
          pageToken = page.nextPageToken || '';
          if (pageToken && seenTokens.has(pageToken)) throw new Error('Google repeated a result page. Please scan again.');
          seenTokens.add(pageToken);
        } while (pageToken);
      }
    })(),
    scanFastSenderDirectory(session, () => {}, async batch => {
      for (const message of batch) headers.set(message.id, message);
    }, state => { inspected = state.indexed; report(state.phase === 'connecting' ? 'Connecting to fast scanner' : 'Fast scanning'); }, scanSignal),
  ]); } finally { controller.abort(); }
  const buckets = mailSearches.map(search => [...candidates].flatMap(([id, category]) => {
    const message = headers.get(id);
    return category === search.category && message ? [{ id, category, message }] : [];
  }));
  const pending: PendingMessage[] = [];
  const count = buckets.reduce((sum, bucket) => sum + bucket.length, 0);
  for (let index = 0; pending.length < count; index++) for (const bucket of buckets) if (bucket[index]) pending.push(bucket[index]);
  const batch = await loadGoogleMailBatch(session, pending, mailboxTotal, progress, signal);
  return { items: batch.items, errors: [], scanned: { gmail: mailboxTotal, drive: 0 }, candidateTotal: pending.length, pending: batch.pending, loaded: batch.loaded, coverage: googleCoverage(batch.loaded, pending.length) };
}

export function googleCoverage(loaded: number, candidateTotal: number) {
  return `Searched five cleanup rules and bulk-scanned received mail. Prepared ${loaded.toLocaleString()} of ${candidateTotal.toLocaleString()} matching messages for review.`;
}

export async function loadGoogleMailBatch(_session: GoogleSession, pending: PendingMessage[], mailboxTotal: number, progress?: (value: ScanProgress) => void, signal?: AbortSignal) {
  const items: CleanupItem[] = []; const batch = pending.slice(0, detailBatchSize);
  let inspected = 0;
  for (const { id, category, message } of batch) {
    if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError');
    if (!message || message.id !== id) throw new Error('Scanned headers are missing. Run the fast scan again.');
    const item = mailItem({ id, subject: message.title, from_: `${message.name} <${message.sender}>`, labels: message.labels, email_ts: message.date ? new Date(message.date).toISOString() : undefined, display_url: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(_session.email)}#all/${id}` }, category);
    if (item) items.push({ ...item, size: message.size });
    inspected++;
    if (inspected % 10 === 0 || inspected === batch.length) progress?.({ phase: 'Preparing scanned suggestions', candidates: batch.length, inspected, mailboxTotal });
  }
  return { items, pending: pending.slice(batch.length), loaded: batch.length };
}
export async function findSenderMail(session: GoogleSession, value: string, progress?: (count: number) => void, signal?: AbortSignal): Promise<SenderMessage[]> {
  const messages = await readFastSenderMail(session, senderAddress(value), progress, signal);
  return messages.map(message => ({ id: message.id, title: message.title, date: message.date ? new Date(message.date).toISOString() : null, size: message.size || 0, labels: message.labels, url: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(session.email)}#all/${message.id}` }));
}
export async function readSenderDirectory(session: GoogleSession, value: string, progress?: (count: number) => void, signal?: AbortSignal, cached?: readonly IndexedMessage[]): Promise<IndexedMessage[]> {
  const sender = senderAddress(value);
  if (!fastReaderEnabled(session)) throw new Error('Reconnect Google to enable fast scanning.');
  if (cached) {
    const baseQuery = `from:(${sender}) -in:sent -in:drafts -in:trash`;
    const list = async (extra = '') => {
      const ids = new Set<string>(); const tokens = new Set<string>(); let pageToken = '';
      do {
        const page = await googleRequest<{ messages?: { id: string }[]; nextPageToken?: string }>(session, `/messages?maxResults=500&includeSpamTrash=true&q=${encodeURIComponent(`${baseQuery}${extra ? ` ${extra}` : ''}`)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { signal });
        for (const message of page.messages || []) ids.add(message.id);
        if (!extra) progress?.(ids.size);
        pageToken = page.nextPageToken || '';
        if (pageToken && tokens.has(pageToken)) throw new Error('Google repeated a sender lookup page. No emails were changed.');
        tokens.add(pageToken);
      } while (pageToken);
      return ids;
    };
    // Immutable headers are already in the index. Refresh only current IDs and
    // protection labels, so a fully indexed sender needs no header reread.
    const [ids, starred, important] = await Promise.all([list(), list('is:starred'), list('label:IMPORTANT')]);
    const known = new Map(cached.map(message => [message.id, message]));
    const missing = [...ids].filter(id => !known.has(id));
    if (missing.length) {
      const fresh = await readFastSenderMail(session, sender, progress, signal);
      for (const message of fresh) if (ids.has(message.id)) known.set(message.id, message);
    }
    return [...ids].flatMap(id => {
      const message = known.get(id);
      if (!message || message.sender !== sender) return [];
      const labels = message.labels.filter(label => !['STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'TRASH'].includes(label));
      if (starred.has(id)) labels.push('STARRED');
      if (important.has(id)) labels.push('IMPORTANT');
      return [{ ...message, labels }];
    });
  }
  return readFastSenderMail(session, sender, progress, signal);
}

export async function trashGoogleMail(session: GoogleSession, ids: string[], sender?: string, progress?: (count: number, state?: CleanupProgress) => void, signal?: AbortSignal, reviewedMessages?: readonly Pick<IndexedMessage, 'id' | 'sender'>[]): Promise<TrashOutcome> {
  const moved: string[] = []; const failed: string[] = [];
  const undo: UndoMessage[] = [];
  const unique = [...new Set(ids)];
  const exactSender = sender ? senderAddress(sender) : null;
  const started = Date.now();
  let errorMessage = '';
  const report = (phase: CleanupProgress['phase'], movedIds?: string[], waitSeconds?: number, undoMessages?: UndoMessage[]) => {
    const seconds = (Date.now() - started) / 1000;
    progress?.(moved.length, { phase, total: unique.length, batchSize: trashBatchSize, movedIds, undoMessages, seconds, rate: moved.length / Math.max(0.001, seconds), waitSeconds });
  };
  const cancelled = (error: unknown) => !!signal?.aborted || error instanceof DOMException && error.name === 'AbortError';
  try {
    if (unique.some(id => !/^[a-f0-9]+$/i.test(id))) throw new Error('Invalid Gmail message selection.');
    if (!unique.length || signal?.aborted) return { moved, failed, remaining: unique, cancelled: !!signal?.aborted, undo, seconds: 0 };
    report('checking');
    if (exactSender) {
      // Message IDs and their From headers are immutable. Reuse headers already
      // read for the review; callers without that evidence still fetch metadata.
      const reviewed = new Map(reviewedMessages?.map(message => [message.id, message.sender]));
      const missing = unique.filter(id => !reviewed.has(id));
      const invalid = unique.filter(id => reviewed.has(id) && reviewed.get(id) !== exactSender);
      await pool(missing, async id => {
        const message = await metadata(session, id, signal);
        if (fromAddress(header(message, 'From')) !== exactSender) invalid.push(id);
      }, 6, signal);
      if (invalid.length) { failed.push(...invalid); return { moved, failed, remaining: unique, cancelled: !!signal?.aborted, undo, seconds: (Date.now() - started) / 1000, error: 'The selection includes another sender. No emails were changed.' }; }
    }
    // A paged eligibility search refreshes mutable labels at a fraction of the
    // cost of one messages.get per email. Only reviewed IDs enter the write.
    const wanted = new Set(unique); const eligible = new Set<string>(); const inbox = new Set<string>();
    const query = `${exactSender ? `from:(${exactSender}) ` : '-is:starred -label:IMPORTANT '}-in:sent -in:drafts -in:trash`;
    // Disjoint Inbox/archived searches capture the original location for Undo
    // without a separate metadata read for each message.
    await Promise.all([true, false].map(async inInbox => {
      let pageToken = ''; const tokens = new Set<string>();
      do {
        const page = await googleRequest<{ messages?: { id: string }[]; nextPageToken?: string }>(session, `/messages?maxResults=500&includeSpamTrash=true&q=${encodeURIComponent(`${query} ${inInbox ? 'in:inbox' : '-in:inbox'}`)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { signal }, undefined, seconds => report('waiting', undefined, seconds));
        for (const message of page.messages || []) if (wanted.has(message.id)) { eligible.add(message.id); if (inInbox) inbox.add(message.id); }
        pageToken = page.nextPageToken || '';
        if (pageToken && tokens.has(pageToken)) throw new Error('Google repeated a cleanup check page. Refresh before continuing.');
        tokens.add(pageToken);
      } while (pageToken && eligible.size < wanted.size);
    }));
    const ready = unique.filter(id => eligible.has(id));
    report('moving');
    // Bounded bulk concurrency overlaps Google's processing time. Cancel and
    // failures stop queued groups; writes already sent finish and are counted.
    let next = 0; let stopped = false;
    const gate = new AbortController();
    const dispatchSignal = signal ? AbortSignal.any([signal, gate.signal]) : gate.signal;
    await Promise.all(Array.from({ length: Math.min(trashConcurrency, Math.ceil(ready.length / trashBatchSize)) }, async () => {
      while (next < ready.length && !stopped && !signal?.aborted) {
        const offset = next; next += trashBatchSize;
        const batch = ready.slice(offset, offset + trashBatchSize);
        try {
          await googleRequest(session, '/messages/batchModify', { method: 'POST', body: JSON.stringify({ ids: batch, addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] }) }, dispatchSignal, seconds => report('waiting', undefined, seconds));
          const undoMessages = batch.map(id => ({ id, inInbox: inbox.has(id) }));
          moved.push(...batch); undo.push(...undoMessages); report('moving', batch, undefined, undoMessages);
        } catch (error) {
          if (!cancelled(error) && !(error instanceof DOMException && error.name === 'AbortError' && gate.signal.aborted)) {
            failed.push(...batch); errorMessage ||= error instanceof Error ? error.message : 'Gmail did not confirm a cleanup group.';
          }
          stopped = true; gate.abort();
        }
      }
    }));
  } catch (error) {
    if (!cancelled(error)) { const acknowledged = new Set(moved); failed.push(...unique.filter(id => !acknowledged.has(id))); errorMessage = error instanceof Error ? error.message : 'Gmail could not check the selection.'; }
  }
  // Skipped IDs remain selected so the UI cannot claim they were moved.
  const movedSet = new Set(moved);
  return { moved, failed, remaining: unique.filter(id => !movedSet.has(id)), cancelled: !!signal?.aborted, undo, error: errorMessage || undefined, seconds: (Date.now() - started) / 1000 };
}

export async function restoreGoogleMail(session: GoogleSession, messages: readonly UndoMessage[], progress?: (restored: UndoMessage[]) => void, signal?: AbortSignal) {
  const unique = [...new Map(messages.map(message => [message.id, message])).values()];
  if (unique.some(message => !/^[a-f0-9]+$/i.test(message.id) || typeof message.inInbox !== 'boolean')) throw new Error('The Undo record is invalid. No emails were changed.');
  const restored: UndoMessage[] = []; const failed: string[] = []; let errorMessage = '';
  const groups: UndoMessage[][] = [];
  // Restore Inbox only for messages that were there before cleanup. Archived
  // mail stays archived, and all other labels remain untouched.
  for (const inInbox of [true, false]) {
    const partition = unique.filter(message => message.inInbox === inInbox);
    for (let offset = 0; offset < partition.length; offset += trashBatchSize) groups.push(partition.slice(offset, offset + trashBatchSize));
  }
  let next = 0; let stopped = false; const gate = new AbortController();
  const dispatchSignal = signal ? AbortSignal.any([signal, gate.signal]) : gate.signal;
  await Promise.all(Array.from({ length: Math.min(trashConcurrency, groups.length) }, async () => {
    while (next < groups.length && !stopped && !signal?.aborted) {
      const group = groups[next++];
      try {
        await googleRequest(session, '/messages/batchModify', { method: 'POST', body: JSON.stringify({ ids: group.map(message => message.id), removeLabelIds: ['TRASH'], addLabelIds: group[0].inInbox ? ['INBOX'] : [] }) }, dispatchSignal);
        restored.push(...group); progress?.(group);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) { failed.push(...group.map(message => message.id)); errorMessage ||= error instanceof Error ? error.message : 'Gmail did not confirm a restore group.'; }
        stopped = true; gate.abort();
      }
    }
  }));
  const done = new Set(restored.map(message => message.id));
  return { restored, failed, remaining: unique.filter(message => !done.has(message.id)), cancelled: !!signal?.aborted, error: errorMessage || undefined };
}
