"use client";

import { useEffect, useRef, useState } from 'react';
import { restoreGoogleMail, type GoogleSession, type UndoMessage } from '@/lib/google-mail';
import { addUndoGroup, readUndoHistory, removeRestored, type UndoRecord } from '@/lib/cleanup-undo';

export function useCleanupUndo(session: GoogleSession | null, onRestored: (messages: UndoMessage[]) => void) {
  const [history, setHistory] = useState<UndoRecord[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoredCount, setRestoredCount] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const histories = useRef(new Map<string, UndoRecord[]>());
  const activeAccount = useRef('');
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    controller.current?.abort();
    activeAccount.current = session?.email || '';
    const account = activeAccount.current;
    setNotice(''); setError('');
    if (!account) { setHistory([]); return; }
    const records = histories.current.get(account) || readUndoHistory(account);
    histories.current.set(account, records); setHistory(records); setNotice(''); setError('');
  }, [session?.email]);
  useEffect(() => () => controller.current?.abort(), []);

  function update(account: string, change: (previous: UndoRecord[]) => UndoRecord[]) {
    const next = change(histories.current.get(account) || readUndoHistory(account));
    histories.current.set(account, next);
    if (activeAccount.current === account) setHistory(next);
    try { sessionStorage.setItem(`mailbot.cleanupUndo.v1:${account}`, JSON.stringify(next)); }
    catch { setStorageWarning(true); }
  }

  function recordGroup(operationId: string, label: string, messages: UndoMessage[]) {
    if (!session || !messages.length) return;
    setNotice(''); setError('');
    const account = session.email;
    update(account, previous => addUndoGroup(previous, { id: operationId, account, label, createdAt: Date.now(), messages }));
  }

  async function undo(id: string) {
    if (!session || controller.current) return;
    const record = histories.current.get(session.email)?.find(item => item.id === id && item.account === session.email);
    if (!record) return;
    const current = new AbortController(); controller.current = current;
    setRestoring(id); setRestoredCount(0); setNotice(''); setError('');
    let count = 0;
    try {
      const result = await restoreGoogleMail(session, record.messages, restored => {
        count += restored.length; setRestoredCount(count);
        update(record.account, previous => removeRestored(previous, id, restored));
        if (activeAccount.current === record.account) onRestored(restored);
      }, current.signal);
      if (activeAccount.current === record.account) {
        setNotice(`${result.restored.length.toLocaleString()} emails restored.${result.cancelled ? ' Remaining emails can still be undone.' : ''}`);
        if (result.failed.length) setError(result.error || 'Some emails could not be restored. Completed restores were kept; retry Undo for the remaining emails.');
      }
    } catch (cause) { if (activeAccount.current === record.account) setError(cause instanceof Error ? cause.message : 'Undo could not be confirmed. Retry after checking Gmail.'); }
    finally { if (controller.current === current) { controller.current = null; setRestoring(null); } }
  }

  function dismiss(id: string) {
    if (!session || controller.current) return;
    update(session.email, previous => previous.filter(record => record.id !== id));
  }

  return { history, restoring, restoredCount, notice, error, storageWarning, recordGroup, undo, dismiss, cancel: () => controller.current?.abort(), dismissNotice: () => setNotice(''), dismissError: () => setError('') };
}
