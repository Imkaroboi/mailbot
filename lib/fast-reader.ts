import type { DirectoryProgress, GoogleSession, IndexedMessage } from './google-mail';
import { fastReaderUrl } from './runtime-config';

type Event = { type: 'messages' | 'progress' | 'complete' | 'error' | 'heartbeat'; messages?: IndexedMessage[]; checked?: number; total?: number; indexed?: number; rate?: number; seconds?: number; message?: string };
export function fastReaderEnabled(session: GoogleSession | null): boolean {
  const endpoint = fastReaderUrl();
  return !!endpoint && !!session?.imap && session.fastReader === endpoint;
}
export async function fastReaderAvailable(): Promise<boolean> {
  const endpoint = fastReaderUrl();
  if (!endpoint) return false;
  // Warm a sleeping free service without sending credentials or blocking UI.
  void fetch(`${endpoint}/health`, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(60_000) }).catch(() => {});
  return true;
}
export async function scanFastSenderDirectory(
  session: GoogleSession,
  onList: (ids: Set<string>, estimate: number) => void | Promise<void>,
  onBatch: (messages: IndexedMessage[], progress: DirectoryProgress) => Promise<void>,
  onProgress?: (progress: DirectoryProgress) => void,
  signal?: AbortSignal,
  sender?: string,
) {
  const endpoint = fastReaderUrl();
  if (!fastReaderEnabled(session)) throw new Error('Connect fast scanning to authorize the configured Mailbot scanner.');
  if (session.expiresAt <= Date.now()) throw new Error('Your Google access expired. Reconnect fast scanning.');
  let progress: DirectoryProgress = { phase: 'connecting', indexed: 0, listed: 0, total: 0, mode: 'imap' };
  onProgress?.(progress);
  const response = await fetch(`${endpoint}/scan`, {
    method: 'POST', signal, cache: 'no-store', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: JSON.stringify(sender ? { sender } : {}),
  });
  if (!response.ok || !response.body) {
    let message = 'The fast scanner could not connect. Retry, or use standard scanning.';
    try { const data = await response.json(); if (typeof data.error === 'string') message = data.error; } catch {}
    throw Object.assign(new Error(message), { status: response.status });
  }
  const reader = response.body.getReader(); const decoder = new TextDecoder(); const ids = new Set<string>();
  let buffer = ''; let completed = false;
  const consume = async (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as Event;
    if (event.type === 'heartbeat') return;
    if (event.type === 'error') throw new Error(event.message || 'Fast scanning stopped. Completed headers were saved; resume to continue.');
    if (!['messages', 'progress', 'complete'].includes(event.type) || completed) throw new Error('The scanner returned an unexpected event.');
    const messages = event.messages || [];
    if (!Array.isArray(messages)) throw new Error('The scanner returned invalid headers.');
    for (const message of messages) {
      if (!/^[a-f0-9]+$/i.test(message.id) || typeof message.sender !== 'string' || typeof message.title !== 'string' || typeof message.name !== 'string' || !Number.isFinite(message.date) || !Array.isArray(message.labels) || message.labels.some(label => typeof label !== 'string') || message.labels.some(label => ['SENT', 'DRAFT', 'TRASH'].includes(label)) || (message.size !== null && (!Number.isFinite(message.size) || message.size < 0)) || (sender && message.sender !== sender)) throw new Error('The scanner returned invalid or mismatched headers. No emails were changed.');
      ids.add(message.id);
    }
    const rate = event.type === 'complete' && Number(event.seconds) > 0 ? Number(event.checked) / Number(event.seconds) : Number(event.rate) || 0;
    progress = { phase: 'indexing', indexed: Number(event.checked) || 0, listed: ids.size, total: Number(event.total) || 0, mode: 'imap', rate };
    if (messages.length) await onBatch(messages, progress);
    onProgress?.(progress);
    if (event.type === 'complete') {
      if (Number(event.indexed) !== ids.size) throw new Error('The stream ended before every header batch arrived. Saved headers are kept; resume to continue.');
      completed = true;
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1); await consume(line); }
      if (buffer.length > 8 * 1024 * 1024) throw new Error('The scanner returned an unexpectedly large batch.');
      if (chunk.done) { if (buffer.trim()) await consume(buffer); break; }
    }
    if (!completed) throw new Error('Fast scanning was interrupted. Completed headers were saved; resume to continue.');
    if (signal?.aborted) throw new DOMException('Scan paused', 'AbortError');
    await onList(ids, ids.size);
    return { ids, listed: ids.size, indexed: ids.size };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function readFastSenderMail(session: GoogleSession, sender: string, onProgress?: (count: number) => void, signal?: AbortSignal): Promise<IndexedMessage[]> {
  const messages = new Map<string, IndexedMessage>();
  await scanFastSenderDirectory(session, () => {}, async batch => {
    for (const message of batch) messages.set(message.id, message);
    onProgress?.(messages.size);
  }, undefined, signal, sender);
  return [...messages.values()];
}
