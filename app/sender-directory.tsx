"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownUp, ArrowRight, Check, Mail, RefreshCw, Search, Trash2, UsersRound, X } from 'lucide-react';
import { readSenderDirectory, scanSenderDirectory, trashGoogleMail, type CleanupProgress, type DirectoryProgress, type GoogleSession, type IndexedMessage, type UndoMessage } from '@/lib/google-mail';
import { clearSenderCache, readSenderCache, removeSenderCache, saveSenderCache } from '@/lib/sender-cache';
import { localReaderAvailable } from '@/lib/gmail-local-reader';

type SenderGroup = { sender: string; name: string; count: number; latest: number; size: number; unknownSizes: number };
type SenderSort = 'count' | 'recent' | 'name' | 'size';
type MessageSort = 'newest' | 'oldest' | 'largest' | 'subject';
const dateLabel = (date: number) => date ? new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown date';
const sizeLabel = (size: number | null) => size === null ? 'Size unavailable' : size >= 1e9 ? `${(size / 1e9).toFixed(1)} GB` : size >= 1e6 ? `${(size / 1e6).toFixed(1)} MB` : `${Math.round(size / 1e3)} KB`;

export default function SenderDirectory({ session, onConnect, onConnectFast, onMoved, onBusy, onScanning, onDeleting, onUndoGroup, externalBusy, externalMovedIds, externalRestoredMessages, undoPanel, active = true }: {
  session: GoogleSession | null;
  onConnect: () => void;
  onConnectFast: () => void;
  onMoved: (ids: string[]) => void;
  onBusy: (busy: boolean) => void;
  onScanning: (busy: boolean) => void;
  onDeleting: (busy: boolean) => void;
  onUndoGroup: (operationId: string, label: string, messages: UndoMessage[]) => void;
  externalBusy: boolean;
  externalMovedIds: string[];
  externalRestoredMessages: UndoMessage[];
  undoPanel: ReactNode;
  active?: boolean;
}) {
  const records = useRef(new Map<string, IndexedMessage>());
  const removedIds = useRef(new Set<string>());
  const removedRecords = useRef(new Map<string, IndexedMessage>());
  const restoredDuringScan = useRef(new Set<string>());
  const previousExternalMoves = useRef(new Set<string>());
  const previousExternalRestores = useRef(new Map<string, boolean>());
  const scanController = useRef<AbortController | null>(null);
  const deleteController = useRef<AbortController | null>(null);
  const prepareController = useRef<AbortController | null>(null);
  const autoStarted = useRef('');
  const [revision, setRevision] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState<DirectoryProgress | null>(null);
  const [query, setQuery] = useState('');
  const [senderSort, setSenderSort] = useState<SenderSort>('count');
  const [messageSort, setMessageSort] = useState<MessageSort>('newest');
  const [senderLimit, setSenderLimit] = useState(100);
  const [messageLimit, setMessageLimit] = useState(100);
  const [activeSender, setActiveSender] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewIds, setReviewIds] = useState<string[] | null>(null);
  const [reviewSnapshot, setReviewSnapshot] = useState<IndexedMessage[]>([]);
  const [reviewSender, setReviewSender] = useState('');
  const [preparingSender, setPreparingSender] = useState(false);
  const [senderFound, setSenderFound] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [movedCount, setMovedCount] = useState(0);
  const [cleanupProgress, setCleanupProgress] = useState<CleanupProgress | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const [helperAvailable, setHelperAvailable] = useState(false);
  const [needsRestoreRefresh, setNeedsRestoreRefresh] = useState(false);

  useEffect(() => { let live = true; void localReaderAvailable().then(value => { if (live) setHelperAvailable(value); }); return () => { live = false; }; }, []);

  useEffect(() => { onBusy(scanning || deleting || preparingSender); onScanning(scanning); onDeleting(deleting || preparingSender); }, [scanning, deleting, preparingSender, onBusy, onScanning, onDeleting]);

  useEffect(() => {
    let live = true;
    scanController.current?.abort(); scanController.current = null;
    deleteController.current?.abort(); deleteController.current = null;
    prepareController.current?.abort(); prepareController.current = null;
    records.current = new Map(); removedIds.current = new Set(); removedRecords.current.clear(); restoredDuringScan.current.clear();
    previousExternalMoves.current.clear(); previousExternalRestores.current.clear();
    setScanning(false); setDeleting(false); setStopping(false); setPreparingSender(false); setNeedsRestoreRefresh(false);
    setRevision(value => value + 1); setHydrated(false); setComplete(false); setActiveSender(null);
    setSelected(new Set()); setReviewIds(null); setReviewSnapshot([]); setReviewSender(''); setNotice(''); setError(''); setProgress(null);
    if (!session?.email) return () => { live = false; };
    void readSenderCache(session.email).then(messages => {
      if (!live) return;
      records.current = new Map(messages.filter(message => !removedIds.current.has(message.id)).map(message => [message.id, message]));
      setRevision(value => value + 1);
    }).catch(() => { if (live) setStorageWarning(true); }).finally(() => { if (live) setHydrated(true); });
    return () => { live = false; scanController.current?.abort(); deleteController.current?.abort(); prepareController.current?.abort(); onBusy(false); onScanning(false); onDeleting(false); };
  }, [session?.email]);

  useEffect(() => {
    const added = externalMovedIds.filter(id => !previousExternalMoves.current.has(id));
    previousExternalMoves.current = new Set(externalMovedIds);
    if (!session || !added.length) return;
    for (const id of added) {
      const message = records.current.get(id); if (message) removedRecords.current.set(id, message);
      removedIds.current.add(id); records.current.delete(id);
    }
    setSelected(previous => new Set([...previous].filter(id => !removedIds.current.has(id))));
    setRevision(value => value + 1);
    void removeSenderCache(session.email, added).catch(() => setStorageWarning(true));
  }, [externalMovedIds]);

  useEffect(() => {
    const added = externalRestoredMessages.filter(message => previousExternalRestores.current.get(message.id) !== message.inInbox);
    previousExternalRestores.current = new Map(externalRestoredMessages.map(message => [message.id, message.inInbox]));
    if (!session || !added.length) return;
    const restored: IndexedMessage[] = []; let missing = false;
    for (const entry of added) {
      removedIds.current.delete(entry.id);
      if (scanController.current) restoredDuringScan.current.add(entry.id);
      const previous = removedRecords.current.get(entry.id);
      if (!previous) { missing = true; continue; }
      const labels = previous.labels.filter(label => !['TRASH', 'INBOX'].includes(label));
      if (entry.inInbox) labels.push('INBOX');
      const message = { ...previous, labels }; records.current.set(entry.id, message); restored.push(message);
    }
    setRevision(value => value + 1);
    if (missing) setNeedsRestoreRefresh(true);
    void saveSenderCache(session.email, restored).catch(() => setStorageWarning(true));
  }, [externalRestoredMessages]);

  useEffect(() => {
    if (!needsRestoreRefresh || !session || !hydrated || externalBusy || scanController.current || deleteController.current || prepareController.current) return;
    setNeedsRestoreRefresh(false); void refresh();
  }, [needsRestoreRefresh, session, hydrated, externalBusy, scanning, deleting, preparingSender]);

  useEffect(() => {
    if (!active || !session || !hydrated || externalBusy || scanController.current || deleteController.current || prepareController.current || autoStarted.current === session.token) return;
    autoStarted.current = session.token;
    void refresh();
  }, [session?.token, hydrated, externalBusy, active, scanning, deleting]);

  async function refresh() {
    if (!session || !hydrated || externalBusy || scanController.current || deleteController.current || prepareController.current) return;
    const controller = new AbortController(); scanController.current = controller;
    removedIds.current.clear();
    restoredDuringScan.current.clear();
    const known = new Set(records.current.keys());
    setScanning(true); setComplete(false); setProgress(null); setError(''); setNotice('');
    try {
      const result = await scanSenderDirectory(session, known, async ids => {
        if (scanController.current !== controller) return;
        const stale = [...records.current.keys()].filter(id => !ids.has(id) && !restoredDuringScan.current.has(id) || removedIds.current.has(id));
        if (stale.length) {
          for (const id of stale) records.current.delete(id);
          setSelected(previous => new Set([...previous].filter(id => records.current.has(id))));
          setRevision(value => value + 1);
          try { await removeSenderCache(session.email, stale); } catch { setStorageWarning(true); }
        }
      }, async (messages, nextProgress) => {
        const merged = messages.filter(message => !removedIds.current.has(message.id)).map(message => scanController.current === controller ? { ...message, size: message.size ?? records.current.get(message.id)?.size ?? null } : message);
        if (scanController.current === controller) {
          for (const message of merged) records.current.set(message.id, message);
          setRevision(value => value + 1);
          setProgress(nextProgress);
        }
        try { await saveSenderCache(session.email, merged); }
        catch { setStorageWarning(true); }
      }, value => { if (scanController.current === controller) setProgress(value); }, controller.signal);
      if (scanController.current === controller) {
        setComplete(true);
        setNotice(`Directory updated from ${result.listed.toLocaleString()} received messages.`);
      }
    } catch (cause) {
      if (scanController.current === controller) {
        if (controller.signal.aborted) setNotice('Indexing paused. Your saved progress is ready to resume.');
        else setError(cause instanceof Error ? cause.message : 'Could not index the mailbox. Resume to try again.');
      }
    } finally {
      if (scanController.current === controller) { scanController.current = null; setScanning(false); }
    }
  }
  async function clearSavedIndex() {
    if (!session || scanning || deleting) return;
    try { await clearSenderCache(session.email); } catch { setStorageWarning(true); }
    records.current.clear(); setRevision(value => value + 1); setComplete(false);
    setSelected(new Set()); setActiveSender(null); setProgress(null);
    setNotice('Saved sender index cleared from this browser. Choose Resume indexing to rebuild it.');
  }

  const allMessages = useMemo(() => [...records.current.values()], [revision]);
  const groups = useMemo(() => {
    const map = new Map<string, SenderGroup>();
    for (const message of allMessages) {
      const group = map.get(message.sender);
      if (group) {
        group.count++; group.size += message.size || 0; group.unknownSizes += message.size === null ? 1 : 0;
        if (message.date > group.latest) { group.latest = message.date; group.name = message.name; }
      } else map.set(message.sender, { sender: message.sender, name: message.name, count: 1, latest: message.date, size: message.size || 0, unknownSizes: message.size === null ? 1 : 0 });
    }
    return [...map.values()];
  }, [allMessages]);
  const visibleGroups = useMemo(() => groups.filter(group => `${group.name} ${group.sender}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => {
    if (senderSort === 'name') return a.name.localeCompare(b.name) || a.sender.localeCompare(b.sender);
    if (senderSort === 'recent') return b.latest - a.latest || b.count - a.count;
    if (senderSort === 'size') return b.size - a.size || b.count - a.count;
    return b.count - a.count || b.latest - a.latest;
  }), [groups, query, senderSort]);
  const senderMessages = useMemo(() => allMessages.filter(message => message.sender === activeSender).sort((a, b) => {
    if (messageSort === 'oldest') return a.date - b.date;
    if (messageSort === 'largest') return (b.size || 0) - (a.size || 0);
    if (messageSort === 'subject') return a.title.localeCompare(b.title);
    return b.date - a.date;
  }), [allMessages, activeSender, messageSort]);
  const activeGroup = groups.find(group => group.sender === activeSender);
  const reviewed = reviewSnapshot;
  const protectedCount = reviewed.filter(message => message.labels.some(label => ['STARRED', 'IMPORTANT'].includes(label))).length;

  function openSender(sender: string) { setActiveSender(sender); setSelected(new Set()); setMessageLimit(100); setNotice(''); }
  function toggle(id: string) { setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function selectVisible() { setSelected(previous => { const next = new Set(previous); for (const message of senderMessages.slice(0, messageLimit)) next.add(message.id); return next; }); }
  function askDelete(ids: string[]) {
    if (!ids.length || deleting || preparingSender || !activeSender) return;
    const snapshot = ids.map(id => records.current.get(id)).filter((value): value is IndexedMessage => !!value);
    setReviewSnapshot(snapshot); setReviewIds(snapshot.map(message => message.id)); setReviewSender(activeSender);
    setMovedCount(0); setNotice(''); setError('');
  }
  async function prepareAllSender() {
    if (!session || !activeSender || deleting || externalBusy || prepareController.current) return;
    const sender = activeSender; const controller = new AbortController(); prepareController.current = controller;
    setPreparingSender(true); setSenderFound(0); setError(''); setNotice('');
    try {
      const found = await readSenderDirectory(session, sender, count => {
        if (prepareController.current === controller) setSenderFound(count);
      }, controller.signal, [...records.current.values()].filter(message => message.sender === sender));
      if (controller.signal.aborted || prepareController.current !== controller) return;
      const snapshot = found.filter(message => !removedIds.current.has(message.id));
      const ids = new Set(snapshot.map(message => message.id));
      const stale = [...records.current.values()].filter(message => message.sender === sender && !ids.has(message.id)).map(message => message.id);
      for (const id of stale) records.current.delete(id);
      for (const message of snapshot) records.current.set(message.id, message);
      setRevision(value => value + 1);
      setSelected(new Set()); setReviewSnapshot(snapshot); setReviewSender(sender);
      setReviewIds(snapshot.length ? snapshot.map(message => message.id) : null);
      if (!snapshot.length) setNotice('No received emails from this sender remain outside Trash.');
      try { await saveSenderCache(session.email, snapshot); await removeSenderCache(session.email, stale); } catch { setStorageWarning(true); }
    } catch (cause) {
      if (prepareController.current === controller) {
        if (controller.signal.aborted) setNotice('Sender lookup cancelled. No emails were changed.');
        else setError(cause instanceof Error ? cause.message : 'Could not load this sender. No emails were changed.');
      }
    } finally {
      if (prepareController.current === controller) { prepareController.current = null; setPreparingSender(false); }
    }
  }
  function cancelReview() {
    if (deleteController.current) { setStopping(true); deleteController.current.abort(); }
    else if (prepareController.current) prepareController.current.abort();
    else setReviewIds(null);
  }
  async function confirmDelete() {
    if (!session || !reviewSender || !reviewIds?.length || deleteController.current || prepareController.current || externalBusy) return;
    const controller = new AbortController(); deleteController.current = controller;
    setDeleting(true); setStopping(false); setMovedCount(0); setCleanupProgress(null);
    const operationId = crypto.randomUUID();
    try {
      const outcome = await trashGoogleMail(session, reviewIds, reviewSender, (count, state) => {
        if (deleteController.current !== controller) return;
        setMovedCount(count); setCleanupProgress(state || null);
        if (state?.movedIds?.length) {
          for (const id of state.movedIds) {
            const message = records.current.get(id); if (message) removedRecords.current.set(id, message);
            removedIds.current.add(id); records.current.delete(id);
          }
          setRevision(value => value + 1);
          onMoved(state.movedIds);
        }
        if (state?.undoMessages?.length) onUndoGroup(operationId, reviewSender, state.undoMessages);
      }, controller.signal, reviewed);
      for (const id of outcome.moved) { removedIds.current.add(id); records.current.delete(id); }
      try { await removeSenderCache(session.email, outcome.moved); } catch { setStorageWarning(true); }
      if (deleteController.current === controller) {
        for (const id of outcome.moved) records.current.delete(id);
        setRevision(value => value + 1);
        setSelected(previous => { const next = new Set(previous); for (const id of outcome.moved) next.delete(id); return next; });
        onMoved(outcome.moved);
        setReviewIds(null);
        setNotice(`${outcome.moved.length.toLocaleString()} messages moved to Gmail Trash${outcome.seconds ? ` in ${outcome.seconds.toFixed(1)} seconds` : ''}.${outcome.cancelled ? ' Remaining messages were kept.' : outcome.remaining.length && !outcome.failed.length ? ` ${outcome.remaining.length.toLocaleString()} messages were already in Trash or no longer eligible.` : ''}`);
        if (outcome.failed.length) setError(outcome.error || 'Gmail did not confirm a cleanup group. Completed groups were retained; refresh before continuing.');
      }
    } catch (cause) { if (deleteController.current === controller) setError(cause instanceof Error ? cause.message : 'Cleanup could not be confirmed. Check Gmail before trying again.'); }
    finally { if (deleteController.current === controller) { deleteController.current = null; setDeleting(false); setStopping(false); } }
  }

  return <section className="directory-page">
    <div className="directory-top"><div><div className="eyebrow"><span className="eyebrow-dot" /> YOUR MAILBOX, BY SENDER</div><h1>Every sender, in one place<span className="period">.</span></h1><p className="intro">Sort who writes to you, review their emails, and move only the messages you choose to Trash.</p></div>{session && <button className="refresh-btn directory-refresh" onClick={() => scanning ? scanController.current?.abort() : void refresh()} disabled={!hydrated || deleting || preparingSender || externalBusy}><RefreshCw size={16} className={scanning ? 'spin' : ''} />{scanning ? 'Pause indexing' : complete ? 'Refresh senders' : 'Resume indexing'}</button>}</div>
    {undoPanel}
    {!session ? <div className="directory-empty"><UsersRound size={28} /><h2>Connect Gmail to see your senders</h2><p>Mailbot will organize received messages by their From address.</p><button className="cleanup-btn" onClick={onConnect}>Connect Google <ArrowRight size={15} /></button></div> : <>
      <div className="directory-status"><div><strong>{groups.length.toLocaleString()} senders</strong><span>{allMessages.length.toLocaleString()} messages indexed{complete ? ' · Mailbox indexed' : ' · Results may change as indexing continues'}</span></div>{progress && <small>{progress.phase === 'listing' ? `Listing mailbox: ${progress.listed.toLocaleString()} found` : `${progress.mode === 'imap' ? 'Fast local scan' : progress.mode === 'bulk' ? 'Fast bulk scan' : 'Standard scan'}: ${progress.indexed.toLocaleString()}${progress.totalIsEstimate ? ' messages found' : ` of ${progress.total.toLocaleString()} messages`}${progress.rate ? ` · ${progress.rate.toFixed(1)} emails/sec` : ''}${progress.mode === 'standard' && progress.rate && progress.indexed < progress.total ? ` · about ${Math.ceil((progress.total - progress.indexed) / progress.rate / 60)} minutes left` : ''}`}</small>}</div>
      {progress?.phase === 'indexing' && progress.total > 0 && <div className={`directory-progress ${progress.totalIsEstimate ? 'directory-progress-indeterminate' : ''}`} role="progressbar" aria-label="Sender indexing progress" aria-valuenow={progress.totalIsEstimate ? undefined : progress.indexed} aria-valuemin={0} aria-valuemax={progress.totalIsEstimate ? undefined : progress.total}><span style={{ width: progress.totalIsEstimate ? '30%' : `${Math.min(100, progress.indexed / progress.total * 100)}%` }} /></div>}
      <p className="directory-help">Scanning continues when you switch Mailbot tabs. Keep this browser tab open; completed messages are saved here and reused when you resume. You can select and move emails to Trash while scanning continues. <button onClick={() => void clearSavedIndex()} disabled={scanning || deleting || preparingSender || !allMessages.length}>Clear saved index</button>{externalBusy && !scanning ? ' Waiting for the current mailbox scan to finish.' : ''}</p>
      {helperAvailable && !session.imap && <div className="directory-fast-connect"><div><strong>Scan hundreds of headers per request</strong><p>The local reader uses Gmail's standard mail connection. Google requires full mail permission for it; the reader opens your mailbox for reading and keeps its token only in memory on this Mac.</p></div><button className="cleanup-btn" disabled={deleting || preparingSender} onClick={() => { scanController.current?.abort(); onConnectFast(); }}>Connect fast scanner <ArrowRight size={15} /></button></div>}
      {progress?.bulkUnavailable && !session.imap && !helperAvailable && <div className="directory-warning"><strong>Standard Gmail scan.</strong> Google limits metadata requests. Completed headers are saved in this browser, so scans reuse the existing index.</div>}
      {storageWarning && <p className="directory-warning">Browser storage is unavailable. This directory will remain available until you close this tab.</p>}
      {error && <p className="sender-error" role="alert">{error}</p>}{notice && <p className="sender-result" role="status">{notice}</p>}
      <div className="directory-grid"><div className="directory-panel"><div className="directory-panel-head"><h2>Senders</h2><span>{visibleGroups.length.toLocaleString()}</span></div><div className="directory-controls"><label className="directory-search"><Search size={15} /><input value={query} onChange={event => { setQuery(event.target.value); setSenderLimit(100); }} placeholder="Search name or email" aria-label="Search senders" /></label><label className="directory-sort"><ArrowDownUp size={14} /><select value={senderSort} onChange={event => setSenderSort(event.target.value as SenderSort)} aria-label="Sort senders"><option value="count">Most emails</option><option value="recent">Most recent</option><option value="name">Name A–Z</option><option value="size">Largest known total</option></select></label></div><div className="directory-senders">{visibleGroups.length ? visibleGroups.slice(0, senderLimit).map(group => <button key={group.sender} className={`directory-sender ${activeSender === group.sender ? 'selected' : ''}`} disabled={deleting || preparingSender} onClick={() => openSender(group.sender)}><span className="directory-avatar">{group.name.slice(0, 1).toUpperCase()}</span><span className="directory-sender-copy"><strong title={group.name}>{group.name}</strong><small title={group.sender}>{group.sender}</small></span><span className="directory-sender-meta"><strong>{group.count.toLocaleString()}</strong><small>{dateLabel(group.latest)}</small></span></button>) : <div className="directory-no-results">{hydrated ? 'No senders match this search yet.' : 'Loading saved senders…'}</div>}</div>{visibleGroups.length > senderLimit && <button className="directory-more" onClick={() => setSenderLimit(value => value + 100)}>Show next 100 senders</button>}</div>
      <div className="directory-panel directory-detail" id="sender-detail">{activeSender && activeGroup ? <><div className="directory-detail-head"><div><span className="section-kicker">SENDER DETAILS</span><h2>{activeGroup.name}</h2><p>{activeGroup.sender} · {activeGroup.count.toLocaleString()} indexed messages · {activeGroup.unknownSizes === activeGroup.count ? 'Sizes not loaded' : `${sizeLabel(activeGroup.size)}${activeGroup.unknownSizes ? ' known size' : ''}`}</p></div><button className="directory-delete-all" disabled={deleting || preparingSender || externalBusy} title="Load every received email from this sender for review, including archived mail and spam" onClick={() => void prepareAllSender()}><Trash2 size={15} />{preparingSender ? `Loading sender… ${senderFound.toLocaleString()}` : 'Move all to Trash'}</button>{preparingSender && <button className="cancel-btn" onClick={cancelReview}>Cancel loading</button>}</div><div className="directory-detail-toolbar"><div className="directory-select-actions"><button onClick={selectVisible} disabled={deleting || preparingSender}>Select shown</button><button onClick={() => setSelected(new Set(senderMessages.map(message => message.id)))} disabled={deleting || preparingSender}>Select all indexed</button><button onClick={() => setSelected(new Set())} disabled={!selected.size || deleting}>Clear</button></div><label className="directory-sort"><ArrowDownUp size={14} /><select value={messageSort} onChange={event => { setMessageSort(event.target.value as MessageSort); setMessageLimit(100); }} aria-label="Sort emails"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="largest">Largest known first</option><option value="subject">Subject A–Z</option></select></label></div><div className="directory-message-list">{senderMessages.slice(0, messageLimit).map(message => <div className="directory-message" key={message.id}><button className={`check-box ${selected.has(message.id) ? 'checked' : ''}`} onClick={() => toggle(message.id)} disabled={deleting || preparingSender} aria-label={`Select ${message.title}`}>{selected.has(message.id) && <Check size={12} />}</button><span className="directory-message-copy"><a href={`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(session.email)}#all/${message.id}`} target="_blank" rel="noreferrer" title={message.title}>{message.title}</a><small>{dateLabel(message.date)} · {sizeLabel(message.size)}{message.labels.includes('STARRED') ? ' · Starred' : ''}{message.labels.includes('IMPORTANT') ? ' · Important' : ''}</small></span><button className="directory-single-trash" title="Move this email to Trash" aria-label={`Move ${message.title} to Trash`} disabled={deleting || preparingSender || externalBusy} onClick={() => askDelete([message.id])}><Trash2 size={15} /></button></div>)}</div>{senderMessages.length > messageLimit && <button className="directory-more" onClick={() => setMessageLimit(value => value + 100)}>Show next 100 emails</button>}<div className="directory-detail-foot"><span>{selected.size.toLocaleString()} selected</span><button className="cleanup-btn" disabled={!selected.size || deleting || preparingSender || externalBusy} onClick={() => askDelete([...selected])}><Trash2 size={15} />Move selected to Trash</button></div></> : <div className="directory-placeholder"><Mail size={27} /><h2>Choose a sender</h2><p>Select a sender to review individual messages and choose what to move to Trash.</p></div>}</div></div>
    </>}
    {reviewIds && <div className="modal-backdrop"><div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="directory-review-title"><button className="modal-close" onClick={cancelReview} disabled={stopping} aria-label="Close review"><X size={19} /></button><div className="modal-icon"><Trash2 size={22} /></div><div className="modal-kicker">REVIEW GMAIL CLEANUP</div><h2 id="directory-review-title">Move {reviewed.length.toLocaleString()} email{reviewed.length === 1 ? '' : 's'} to Trash?</h2><p>These emails are from <strong>{reviewSender}</strong>. You can restore them from Gmail Trash. Only the emails listed in this review will be moved. Emails arriving afterward are kept.</p>{protectedCount > 0 && <div className="notice-banner sender-warning">This selection includes {protectedCount} starred or important messages.</div>}<div className="review-list">{reviewed.slice(0, 30).map(message => <div key={message.id}><Mail size={16} /><span>{message.title}</span></div>)}{reviewed.length > 30 && <div>And {(reviewed.length - 30).toLocaleString()} more selected emails.</div>}</div>{deleting && <p role="status">{stopping ? 'Stopping after the groups already sent finish.' : cleanupProgress?.phase === 'checking' ? 'Checking the selected emails…' : cleanupProgress?.phase === 'waiting' ? `Google requested a quota pause of about ${cleanupProgress.waitSeconds} seconds. Cancel is available.` : `${movedCount.toLocaleString()} of ${reviewed.length.toLocaleString()} moved · ${Math.round(cleanupProgress?.rate || 0).toLocaleString()} emails/sec`}</p>}<div className="modal-buttons sender-modal-buttons"><button className="cancel-btn" onClick={cancelReview} disabled={stopping}>{stopping ? 'Stopping…' : 'Cancel'}</button><button className="confirm-btn" onClick={() => void confirmDelete()} disabled={deleting || preparingSender || !reviewed.length}>Move to Trash <ArrowRight size={16} /></button></div></div></div>}
  </section>;
}
