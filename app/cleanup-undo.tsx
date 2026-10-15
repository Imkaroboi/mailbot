"use client";

import { CheckCircle2, ChevronDown, RotateCcw, X } from 'lucide-react';
import type { UndoRecord } from '@/lib/cleanup-undo';
import type { useCleanupUndo } from './use-cleanup-undo';

export default function CleanupUndo({ undo, disabled }: { undo: ReturnType<typeof useCleanupUndo>; disabled: boolean }) {
  if (!undo.history.length && !undo.notice && !undo.error && !undo.restoring) return null;
  const [latest, ...older] = undo.history;
  const row = (record: UndoRecord) => <div className="cleanup-undo-row" key={record.id}>
    <div className="cleanup-undo-copy"><strong>{record.messages.length.toLocaleString()} email{record.messages.length === 1 ? '' : 's'} moved to Trash</strong><small title={record.label}>{record.label}</small></div>
    <div className="cleanup-undo-actions">
      <button type="button" className="undo-btn" disabled={disabled || !!undo.restoring} aria-label={`Undo cleanup of ${record.messages.length} emails from ${record.label}`} onClick={() => void undo.undo(record.id)}><RotateCcw size={14} aria-hidden="true" />{undo.restoring === record.id ? 'Restoring…' : 'Undo'}</button>
      <button type="button" className="undo-dismiss-btn undo-dismiss-record" disabled={disabled || !!undo.restoring} aria-label={`Dismiss Undo for ${record.label}`} title="Dismiss Undo. Emails stay in Trash." onClick={() => undo.dismiss(record.id)}><X size={15} aria-hidden="true" /></button>
    </div>
  </div>;
  return <section className="cleanup-undo" aria-label="Recent cleanups and Undo">
    <div className="cleanup-undo-heading"><span className="cleanup-undo-icon"><RotateCcw size={16} aria-hidden="true" /></span><div><h2>Recent cleanups</h2><p>Restore emails moved to Trash.</p></div></div>
    {latest && row(latest)}
    {older.length > 0 && <details className="cleanup-undo-older"><summary><span>{older.length} earlier cleanup{older.length === 1 ? '' : 's'}</span><ChevronDown size={14} aria-hidden="true" /></summary>{older.map(row)}</details>}
    {undo.restoring && <div className="cleanup-undo-feedback" role="status"><span>{undo.restoredCount.toLocaleString()} emails restored…</span><button type="button" className="undo-stop-btn" onClick={undo.cancel}>Stop restoring</button></div>}
    {undo.notice && <div className="cleanup-undo-feedback cleanup-undo-success" role="status"><CheckCircle2 size={15} aria-hidden="true" /><span>{undo.notice}</span><button type="button" className="undo-dismiss-btn" aria-label="Dismiss restore confirmation" onClick={undo.dismissNotice}><X size={14} /></button></div>}
    {undo.error && <div className="cleanup-undo-feedback cleanup-undo-error" role="alert"><span>{undo.error}</span><button type="button" className="undo-dismiss-btn" aria-label="Dismiss Undo error" onClick={undo.dismissError}><X size={14} /></button></div>}
    {undo.storageWarning && <p className="cleanup-undo-storage">Undo remains available in this tab; browser storage could not save it for a reload.</p>}
  </section>;
}
