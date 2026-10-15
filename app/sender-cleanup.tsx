"use client";

import { useRef, useState } from 'react';
import { ArrowRight, Mail, Search, Trash2, X } from 'lucide-react';
import { findSenderMail, senderAddress, trashGoogleMail, type CleanupProgress, type GoogleSession, type SenderMessage, type UndoMessage } from '@/lib/google-mail';

export default function SenderCleanup({ session, onConnect, onMoved, onBusy, onUndoGroup, externalBusy }: { session: GoogleSession | null; onConnect: () => void; onMoved: (ids: string[]) => void; onBusy: (busy: boolean) => void; onUndoGroup: (operationId: string, label: string, messages: UndoMessage[]) => void; externalBusy: boolean }) {
  const [sender, setSender] = useState(''); const [searchedSender, setSearchedSender] = useState('');
  const [messages, setMessages] = useState<SenderMessage[] | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(0);
  const [reviewLimit, setReviewLimit] = useState(100);
  const [review, setReview] = useState(false); const [result, setResult] = useState(''); const guard = useRef(false);
  const [operation, setOperation] = useState<'search' | 'cleanup' | null>(null);
  const [stopping, setStopping] = useState(false);
  const [cleanupProgress, setCleanupProgress] = useState<CleanupProgress | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  function cancel() {
    if (controllerRef.current) { setStopping(true); controllerRef.current.abort(); }
    else setReview(false);
  }
  async function search() {
    if (!session || guard.current || externalBusy) return;
    let address: string; try { address = senderAddress(sender); } catch(e) { setError((e as Error).message); return; }
    const controller = new AbortController(); controllerRef.current = controller;
    guard.current = true; setBusy(true); setOperation('search'); setStopping(false); onBusy(true); setProgress(0); setError(''); setResult(''); setMessages(null);
    try { const found = await findSenderMail(session, address, setProgress, controller.signal); if (!controller.signal.aborted) { setMessages(found); setSearchedSender(address); } }
    catch(e) { if (controller.signal.aborted) setResult('Search cancelled. No messages were changed.'); else setError(e instanceof Error ? e.message : 'Could not search this sender.'); }
    finally { controllerRef.current = null; guard.current = false; setBusy(false); setOperation(null); setStopping(false); onBusy(false); }
  }
  async function cleanup() {
    if (!session || !messages?.length || guard.current || externalBusy) return;
    const controller = new AbortController(); controllerRef.current = controller;
    guard.current = true; setBusy(true); setOperation('cleanup'); setStopping(false); onBusy(true); setProgress(0); setCleanupProgress(null); setError('');
    const operationId = crypto.randomUUID();
    try {
      const outcome = await trashGoogleMail(session, messages.map(m => m.id), searchedSender, (count, state) => {
        setProgress(count); setCleanupProgress(state || null);
        if (state?.undoMessages?.length) onUndoGroup(operationId, searchedSender, state.undoMessages);
      }, controller.signal, messages.map(message => ({ id: message.id, sender: searchedSender })));
      const moved = new Set(outcome.moved);
      onMoved(outcome.moved); setMessages(prev => prev?.filter(m => !moved.has(m.id)) || []);
      setReview(false); setResult(`${outcome.moved.length} messages moved to Gmail Trash.${outcome.cancelled ? ' Cleanup cancelled; remaining messages were kept.' : outcome.failed.length ? ' Cleanup stopped because Google could not confirm a cleanup group. Search again before continuing.' : ''}`);
    } catch(e) { setError(e instanceof Error ? e.message : 'Cleanup could not be confirmed. Check Gmail before trying again.'); }
    finally { controllerRef.current = null; guard.current = false; setBusy(false); setOperation(null); setStopping(false); onBusy(false); }
  }
  const protectedCount = messages?.filter(m => m.labels.some(label => ['STARRED', 'IMPORTANT'].includes(label))).length || 0;
  return <section className="sender-card"><div className="sender-heading"><span className="stat-icon purple"><Mail size={19} /></span><div><h2>Clean up by sender</h2><p>Find every email from a specific address, then review and move them to Trash.</p></div></div>{!session ? <button className="sender-connect" onClick={onConnect}>Connect Google to search your mailbox <ArrowRight size={15} /></button> : <><form className="sender-form" onSubmit={e => { e.preventDefault(); void search(); }}><label className="sender-input"><Mail size={17} /><input aria-label="Sender email address" type="email" placeholder="newsletter@example.com" value={sender} onChange={e => setSender(e.target.value)} disabled={busy || externalBusy} required /></label><button className="refresh-btn" disabled={busy || externalBusy || !sender}><Search size={15} />{operation === 'search' ? `Searching… ${progress}` : 'Find all emails'}</button>{operation === 'search' && <button type="button" className="cancel-btn" onClick={cancel} disabled={stopping}>{stopping ? 'Stopping…' : 'Cancel'}</button>}</form>{error && <p className="sender-error" role="alert">{error}</p>}{result && <p className="sender-result" role="status">{result}</p>}{messages && <div className="sender-results"><div className="sender-summary"><div><strong>{messages.length.toLocaleString()} messages</strong><span> from {searchedSender}</span><small>Includes archived mail and spam. Trash and drafts are excluded.</small></div><button className="cleanup-btn" onClick={() => { setReviewLimit(100); setReview(true); }} disabled={busy || externalBusy || !messages.length}><Trash2 size={15} />Review all</button></div>{messages.length > 0 && <div className="sender-samples">{messages.slice(0, 5).map(m => <a href={m.url} key={m.id} target="_blank" rel="noreferrer"><Mail size={14} /><span>{m.title}</span><ArrowRight size={14} /></a>)}{messages.length > 5 && <small>And {messages.length - 5} more. The review shows all matching messages.</small>}</div>}</div>}</>}{review && messages && <div className="modal-backdrop"><div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="sender-review-title"><button className="modal-close" onClick={cancel} disabled={stopping || externalBusy} aria-label="Close sender review"><X size={19} /></button><div className="modal-icon"><Trash2 size={22} /></div><div className="modal-kicker">REVIEW SENDER CLEANUP</div><h2 id="sender-review-title">Move all {messages.length.toLocaleString()} emails to Trash?</h2><p>These messages were sent by <strong>{searchedSender}</strong>. This affects the messages found in your search, including archived emails and spam.</p>{protectedCount > 0 && <div className="notice-banner sender-warning">Includes {protectedCount} starred or important messages. They will also move to Trash if you approve.</div>}<div className="review-list">{messages.slice(0, reviewLimit).map(m => <div key={m.id}><Mail size={16} /><a href={m.url} target="_blank" rel="noreferrer">{m.title}</a><button disabled={busy || externalBusy} onClick={() => setMessages(prev => prev?.filter(item => item.id !== m.id) || [])} aria-label={`Keep ${m.title}`}><X size={15} /></button></div>)}{messages.length > reviewLimit && <button className="directory-more" disabled={busy || externalBusy} onClick={() => setReviewLimit(limit => limit + 100)}>Show next {Math.min(100, messages.length - reviewLimit).toLocaleString()} of {(messages.length - reviewLimit).toLocaleString()} more emails</button>}</div><p>You can restore messages in Gmail Trash. Google normally removes them permanently after 30 days. New emails arriving after this search are not included.</p>{operation === 'cleanup' && <p className="sender-result" role="status">{stopping ? 'Stopping after the groups already sent finish.' : cleanupProgress?.phase === 'checking' ? 'Checking the selected emails…' : cleanupProgress?.phase === 'waiting' ? `Google requested a quota pause of about ${cleanupProgress.waitSeconds} seconds.` : `Moved ${progress.toLocaleString()} of ${messages.length.toLocaleString()}… Moving in groups of up to 1,000 emails.`}</p>}<div className="modal-buttons sender-modal-buttons"><button className="cancel-btn" disabled={stopping || externalBusy} onClick={cancel}>{stopping ? 'Stopping…' : 'Cancel'}</button><button className="confirm-btn" disabled={busy || externalBusy || !messages.length} onClick={() => void cleanup()}>{operation === 'cleanup' ? 'Moving…' : `Move ${messages.length} to Trash`} <ArrowRight size={16} /></button></div></div></div>}</section>;
}
