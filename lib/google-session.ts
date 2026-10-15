import type { GoogleSession } from './google-mail';

const key = 'mailbot.googleSession.v1';
export type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type SavedSession = { version: 1; clientId: string; session: GoogleSession };
export type SessionRead = { status: 'missing' | 'expired' | 'invalid' | 'unavailable'; session: null } | { status: 'saved' | 'restored'; session: GoogleSession };

export function browserSessionStorage(): SessionStorage | null {
  try { return window.sessionStorage; } catch { return null; }
}

export function clearGoogleSession(storage: SessionStorage | null): boolean {
  try { storage?.removeItem(key); return !!storage; } catch { return false; }
}

export function saveGoogleSession(clientId: string, session: GoogleSession, storage: SessionStorage | null): boolean {
  if (!clientId || session.expiresAt <= Date.now()) return false;
  try { storage?.setItem(key, JSON.stringify({ version: 1, clientId, session } satisfies SavedSession)); return !!storage; }
  catch { return false; }
}

export function readGoogleSession(clientId: string, storage: SessionStorage | null, now = Date.now()): SessionRead {
  if (!storage) return { status: 'unavailable', session: null };
  try {
    const value = storage.getItem(key);
    if (!value) return { status: 'missing', session: null };
    const data = JSON.parse(value) as Partial<SavedSession>;
    const session = data?.session;
    if (data?.version !== 1 || data.clientId !== clientId || !session || typeof session.token !== 'string' || !session.token || session.token.length > 8192 || /\s/.test(session.token) || typeof session.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(session.email) || typeof session.name !== 'string' || typeof session.expiresAt !== 'number' || !Number.isFinite(session.expiresAt) || session.expiresAt > now + 86_400_000 || (session.imap !== undefined && typeof session.imap !== 'boolean')) {
      clearGoogleSession(storage); return { status: 'invalid', session: null };
    }
    if (session.expiresAt <= now) { clearGoogleSession(storage); return { status: 'expired', session: null }; }
    if (session.drive !== undefined && typeof session.drive !== 'boolean') { clearGoogleSession(storage); return { status: 'invalid', session: null }; }
    if (session.fastReader !== undefined && (typeof session.fastReader !== 'string' || session.fastReader.length > 2048 || !session.fastReader.startsWith('https://') || new URL(session.fastReader).origin !== session.fastReader)) { clearGoogleSession(storage); return { status: 'invalid', session: null }; }
    return { status: 'saved', session: { token: session.token, email: session.email, name: session.name, expiresAt: session.expiresAt, imap: session.imap || false, ...(session.drive !== undefined ? { drive: session.drive } : {}), ...(session.fastReader ? { fastReader: session.fastReader } : {}) } };
  } catch { clearGoogleSession(storage); return { status: 'invalid', session: null }; }
}

export async function restoreGoogleSession(clientId: string, storage: SessionStorage | null, profile: (session: GoogleSession, signal?: AbortSignal) => Promise<{ emailAddress: string }>, signal?: AbortSignal): Promise<SessionRead> {
  if (signal?.aborted) throw new DOMException('Connection restore cancelled', 'AbortError');
  const saved = readGoogleSession(clientId, storage);
  if (!saved.session) return saved;
  try {
    const current = await profile(saved.session, signal);
    if (signal?.aborted) throw new DOMException('Connection restore cancelled', 'AbortError');
    if (typeof current.emailAddress !== 'string' || current.emailAddress.toLowerCase() !== saved.session.email.toLowerCase()) {
      clearGoogleSession(storage); return { status: 'invalid', session: null };
    }
    if (saved.session.expiresAt <= Date.now()) { clearGoogleSession(storage); return { status: 'expired', session: null }; }
    return { status: 'restored', session: { ...saved.session, email: current.emailAddress } };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Connection restore cancelled', 'AbortError');
    if ((error as { status?: number }).status === 401) { clearGoogleSession(storage); return { status: 'expired', session: null }; }
    // Keep a valid saved session during transient network or quota failures.
    throw error;
  }
}
