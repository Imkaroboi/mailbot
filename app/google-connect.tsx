"use client";

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { googleRequest, type GoogleSession } from '@/lib/google-mail';
import { fastReaderUrl } from '@/lib/runtime-config';
import { fastReaderEnabled } from '@/lib/fast-reader';
import { browserSessionStorage, clearGoogleSession, restoreGoogleSession, saveGoogleSession } from '@/lib/google-session';

type TokenResponse = { access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
declare global { interface Window { google?: { accounts: { oauth2: { initTokenClient(config: { client_id: string; scope: string; callback: (response: TokenResponse) => void; error_callback: (error: { type: string }) => void }): { requestAccessToken(options: { prompt: string }): void } } } } } }

export function useGoogleConnection(initialClientId: string) {
  const [session, setSession] = useState<GoogleSession | null>(null);
  const [clientId, setClientId] = useState(initialClientId);
  const [setupOpen, setSetupOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [storageWarning, setStorageWarning] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const attempt = useRef(0);
  const restoreController = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!initialClientId) { try { setClientId(localStorage.getItem('mailbot.googleClientId') || ''); } catch {} }
    if (window.google?.accounts.oauth2) { setReady(true); return; }
    const existing = document.querySelector<HTMLScriptElement>('script[data-mailbot-google]');
    const script = existing || document.createElement('script');
    const loaded = () => setReady(true);
    const failed = () => setConnectionError('Google sign-in could not load. Check your internet connection and refresh.');
    script.addEventListener('load', loaded); script.addEventListener('error', failed);
    if (!existing) { script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.dataset.mailbotGoogle = 'true'; document.head.appendChild(script); }
    return () => { script.removeEventListener('load', loaded); script.removeEventListener('error', failed); };
  }, [initialClientId]);
  useEffect(() => {
    if (!clientId) { setRestoring(false); return; }
    const controller = new AbortController(); restoreController.current = controller;
    const currentAttempt = ++attempt.current;
    setRestoring(true);
    void restoreGoogleSession(clientId, browserSessionStorage(), (saved, signal) => googleRequest<{ emailAddress: string }>(saved, '/profile', { signal }), controller.signal).then(result => {
      if (attempt.current !== currentAttempt || controller.signal.aborted) return;
      if (result.session) { setSession(result.session); setConnectionError(''); }
      else if (result.status === 'expired') setConnectionError('Your Google access expired. Connect Google again to renew it.');
      else if (result.status === 'unavailable') setStorageWarning(true);
    }).catch(error => {
      if (attempt.current === currentAttempt && !controller.signal.aborted) setConnectionError(error instanceof Error ? `Could not restore Gmail: ${error.message}` : 'Could not restore Gmail. Try reconnecting.');
    }).finally(() => {
      if (attempt.current === currentAttempt) { restoreController.current = null; setRestoring(false); }
    });
    return () => controller.abort();
  }, [clientId]);
  useEffect(() => {
    if (session) setStorageWarning(!saveGoogleSession(clientId, session, browserSessionStorage()));
  }, [session, clientId]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => { clearGoogleSession(browserSessionStorage()); setSession(null); setConnectionError('Your Google access expired. Connect Google again to renew it.'); }, Math.max(0, session.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [session]);
  function connect(fast = false, drive = false) {
    setConnectionError('');
    const reader = fast ? fastReaderUrl() : fastReaderEnabled(session) ? session!.fastReader : '';
    if (fast && !reader) { setConnectionError('Fast scanning has not been configured for this website yet.'); return; }
    if (!clientId) { setSetupOpen(true); return; }
    if (!ready || !window.google) { setConnectionError('Google sign-in is still loading. Try again in a moment.'); return; }
    restoreController.current?.abort(); restoreController.current = null;
    const currentAttempt = ++attempt.current;
    setRestoring(false);
    setConnecting(true);
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: [reader ? 'https://mail.google.com/' : 'https://www.googleapis.com/auth/gmail.modify', ...(drive || session?.drive ? ['https://www.googleapis.com/auth/drive'] : [])].join(' '),
      error_callback: () => { if (attempt.current === currentAttempt) { setConnecting(false); setConnectionError('Google sign-in was closed or blocked. Allow the popup and try again.'); } },
      callback: async response => {
        if (attempt.current !== currentAttempt) return;
        if (!response.access_token || response.error) { setConnecting(false); setConnectionError(response.error_description || 'Google did not grant Gmail access.'); return; }
        const scopes = new Set(response.scope?.split(' '));
        const next: GoogleSession = { token: response.access_token, expiresAt: Date.now() + Number(response.expires_in || 3600) * 1000 - 30000, email: '', name: '', imap: scopes.has('https://mail.google.com/'), ...(reader && scopes.has('https://mail.google.com/') ? { fastReader: reader } : {}), drive: scopes.has('https://www.googleapis.com/auth/drive') };
        try {
          const profile = await googleRequest<{ emailAddress: string }>(next, '/profile');
          if (attempt.current !== currentAttempt) return;
          const connected = { ...next, email: profile.emailAddress, name: profile.emailAddress.split('@')[0] };
          setStorageWarning(!saveGoogleSession(clientId, connected, browserSessionStorage()));
          setSession(connected);
        } catch(e) { if (attempt.current === currentAttempt) setConnectionError(e instanceof Error ? e.message : 'Gmail could not connect.'); }
        finally { if (attempt.current === currentAttempt) setConnecting(false); }
      },
    });
    client.requestAccessToken({ prompt: 'select_account' });
  }
  function disconnect() {
    ++attempt.current; restoreController.current?.abort(); restoreController.current = null;
    clearGoogleSession(browserSessionStorage()); setSession(null); setConnecting(false); setRestoring(false); setConnectionError('');
  }
  function saveClientId(value: string) {
    const cleaned = value.trim();
    if (!/^[a-zA-Z0-9.-]+\.apps\.googleusercontent\.com$/.test(cleaned)) throw new Error('Enter the Google OAuth client ID ending in .apps.googleusercontent.com.');
    if (cleaned !== clientId) disconnect();
    localStorage.setItem('mailbot.googleClientId', cleaned); setClientId(cleaned); setSetupOpen(false);
  }
  function useStandardScanning() {
    setSession(current => current ? { ...current, fastReader: undefined } : null);
    setConnectionError('');
  }
  return { session, useStandardScanning, connect: () => connect(false), connectFast: () => connect(true), connectDrive: () => connect(false, true), disconnect, connecting: connecting || restoring, connectionError, storageWarning, setupOpen, setSetupOpen, clientId, saveClientId };
}

export function GoogleSetup({ clientId, onSave, onClose }: { clientId: string; onSave: (value: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(clientId); const [error, setError] = useState('');
  return <div className="modal-backdrop"><div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="google-setup-title"><button className="modal-close" onClick={onClose} aria-label="Close Google setup"><X size={19} /></button><div className="modal-kicker">GOOGLE CONNECTION</div><h2 id="google-setup-title">Connect your own Google account</h2><p>Google requires a web OAuth client ID for this app. This public ID is saved on this browser. Your connection is saved in this tab until Google access expires, so reloading keeps you connected. Disconnect clears it. Standard Gmail cleanup and Drive requests go directly to Google. Optional fast scanning sends a temporary token to the configured secure scanner, which reads headers without storing your token or emails.</p><ol className="setup-steps"><li>Enable the Gmail API, and the Drive API if you use Drive.</li><li>Create an OAuth client with application type <strong>Web application</strong>.</li><li>Add <code>{typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:5173'}</code> to Authorized JavaScript origins.</li><li>If your OAuth app is in testing, add your Google email as a test user.</li></ol><a className="setup-link" href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">Open Google Auth Platform <ArrowRight size={14} /></a><form onSubmit={e => { e.preventDefault(); try { onSave(value); } catch(error) { setError(error instanceof Error ? error.message : 'Invalid client ID'); } }}><label className="setup-label" htmlFor="google-client-id">Public Google OAuth client ID</label><input id="google-client-id" className="setup-input" value={value} onChange={e => setValue(e.target.value)} placeholder="123456789-example.apps.googleusercontent.com" required />{error && <p className="setup-error">{error}</p>}<div className="modal-buttons"><button type="button" className="cancel-btn" onClick={onClose}>Cancel</button><button type="submit" className="confirm-btn">Save connection <ArrowRight size={16} /></button></div></form></div></div>;
}
