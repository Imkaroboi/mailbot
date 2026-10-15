"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, CheckCheck, ChevronDown, Cloud, FileText, HardDrive, Inbox, LayoutDashboard, LockKeyhole, Mail, Menu, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, UsersRound, X } from "lucide-react";
import type { CleanupItem } from "@/lib/mailbot";
import { detailBatchSize, googleCoverage, loadGoogleMailBatch, scanGoogleMail, trashGoogleMail, type CleanupProgress, type PendingMessage, type ScanProgress, type UndoMessage } from "@/lib/google-mail";
import { fastReaderEnabled } from "@/lib/fast-reader";
import { ScanNotice } from "./scan-notice";
import { GoogleSetup, useGoogleConnection } from "./google-connect";
import SenderCleanup from "./sender-cleanup";
import SenderDirectory from "./sender-directory";
import CleanupUndo from "./cleanup-undo";
import DriveBrowser from "./drive-browser";
import { useCleanupUndo } from "./use-cleanup-undo";

type Scan = { items: CleanupItem[]; errors: string[]; reconnect?: string | null; scanned: { gmail: number; drive: number }; coverage: string; candidateTotal?: number; loaded?: number; pending?: PendingMessage[] };
type Props = { user: { name: string; email: string } | null; signInPath: string; signOutPath: string; oauthClientId: string };
const categories = ["All items", "Promotions", "Newsletters", "Old mail", "Large mail", "Spam", "Same-name files", "Large files", "Old files"];
const formatSize = (n: number | null) => n == null ? "—" : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`;

export default function Dashboard({ user: hostedUser, signInPath, signOutPath, oauthClientId }: Props) {
  const google = useGoogleConnection(oauthClientId);
  const user = google.session ? { name: google.session.name, email: google.session.email } : hostedUser;
  const [senderBusy, setSenderBusy] = useState(false);
  const [view, setView] = useState<"overview" | "senders" | "drive">("overview");
  const [sendersOpened, setSendersOpened] = useState(false);
  const [driveOpened, setDriveOpened] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [directoryScanning, setDirectoryScanning] = useState(false);
  const [directoryDeleting, setDirectoryDeleting] = useState(false);
  const [scan, setScan] = useState<Scan | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const scanController = useRef<AbortController | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [source, setSource] = useState<"all" | "gmail" | "drive">("all");
  const [category, setCategory] = useState("All items");
  const [query, setQuery] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [stoppingCleanup, setStoppingCleanup] = useState(false);
  const [cleanupProgress, setCleanupProgress] = useState<CleanupProgress | null>(null);
  const [movedCount, setMovedCount] = useState(0);
  const [movedInOtherView, setMovedInOtherView] = useState<string[]>([]);
  const [restoredInOtherView, setRestoredInOtherView] = useState<UndoMessage[]>([]);
  const removedOverview = useRef(new Map<string, CleanupItem>());
  const undo = useCleanupUndo(google.session, restoreToViews);
  const cleanController = useRef<AbortController | null>(null);
  const [toast, setToast] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  useEffect(() => { setMovedInOtherView([]); setRestoredInOtherView([]); removedOverview.current.clear(); setScan(null); setSelected([]); setReviewOpen(false); setError(""); }, [google.session?.email]);
  async function refresh() {
    if (!user || scanController.current || senderBusy || driveBusy || undo.restoring) return;
    const controller = new AbortController(); scanController.current = controller;
    setLoading(true); setError(""); setScanProgress(null);
    try {
      if (google.session) {
        const result = await scanGoogleMail(google.session, setScanProgress, controller.signal);
        if (!controller.signal.aborted) { setScan(result); setSelected([]); }
        return;
      }
      throw new Error("Connect Google to use fast scanning.");
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Scan failed"); }
    finally { if (scanController.current === controller) { scanController.current = null; setLoading(false); setScanProgress(null); } }
  }
  async function loadMore() {
    if (!google.session || !scan?.pending?.length || scanController.current || senderBusy) return;
    const controller = new AbortController(); scanController.current = controller;
    setLoading(true); setError(""); setScanProgress(null);
    try {
      const batch = await loadGoogleMailBatch(google.session, scan.pending, scan.scanned.gmail, setScanProgress, controller.signal);
      if (!controller.signal.aborted) setScan(prev => {
        if (!prev) return prev;
        const loaded = (prev.loaded || 0) + batch.loaded;
        return { ...prev, items: [...prev.items, ...batch.items], pending: batch.pending, loaded, coverage: googleCoverage(loaded, prev.candidateTotal || loaded) };
      });
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load more messages."); }
    finally { if (scanController.current === controller) { scanController.current = null; setLoading(false); setScanProgress(null); } }
  }
  useEffect(() => {
    if (user) { if (view === "overview") void refresh(); } else { setScan(null); setSelected([]); }
    return () => { scanController.current?.abort(); scanController.current = null; setLoading(false); setScanProgress(null); };
  }, [user?.email, google.session?.token]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 5000); return () => clearTimeout(t); }, [toast]);
  const items = scan?.items || [];
  const visible = useMemo(() => items.filter(item => (source === "all" || item.source === source) && (category === "All items" || item.category === category) && (!query || `${item.title} ${item.subtitle} ${item.reason}`.toLowerCase().includes(query.toLowerCase()))), [items, source, category, query]);
  const selectable = visible.filter(item => item.canTrash);
  const selectedItems = items.filter(item => selected.includes(item.id));
  const driveBytes = items.filter(item => item.source === "drive").reduce((n, item) => n + (item.size || 0), 0);
  const knownSelectedBytes = selectedItems.reduce((n, item) => n + (item.size || 0), 0);
  const toggle = (id: string) => setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  function cancelReview() {
    if (cleanController.current) { setStoppingCleanup(true); cleanController.current.abort(); }
    else if (!cleaning) setReviewOpen(false);
  }
  function selectVisible() {
    const ids = selectable.map(item => item.id).slice(0, 50);
    setSelected(prev => ids.every(id => prev.includes(id)) ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])].slice(0, 50));
  }
  function removeFromOverview(ids: string[]) {
    const moved = new Set(ids);
    setRestoredInOtherView(previous => previous.filter(message => !moved.has(message.id)));
    for (const item of scan?.items || []) if (moved.has(item.id)) removedOverview.current.set(item.id, item);
    setScan(prev => prev ? { ...prev, items: prev.items.filter(item => !moved.has(item.id)), pending: prev.pending?.filter(message => !moved.has(message.id)) } : prev);
    setSelected(prev => prev.filter(id => !moved.has(id)));
  }
  function restoreToViews(messages: UndoMessage[]) {
    const restoredIds = new Set(messages.map(message => message.id));
    setMovedInOtherView(previous => previous.filter(id => !restoredIds.has(id)));
    setRestoredInOtherView(previous => [...new Map([...previous, ...messages].map(message => [message.id, message])).values()]);
    const items = messages.map(message => removedOverview.current.get(message.id)).filter((item): item is CleanupItem => !!item);
    setScan(previous => {
      if (!previous) return previous;
      const existing = new Set(previous.items.map(item => item.id));
      return { ...previous, items: [...previous.items, ...items.filter(item => !existing.has(item.id))] };
    });
  }
  async function clean() {
    if (!selected.length || cleaning || undo.restoring || (senderBusy && (!directoryScanning || directoryDeleting)) || loading) return;
    setCleaning(true);
    const controller = google.session ? new AbortController() : null;
    cleanController.current = controller;
    setStoppingCleanup(false); setCleanupProgress(null); setMovedCount(0);
    const operationId = crypto.randomUUID();
    try {
      if (google.session) {
        const result = await trashGoogleMail(google.session, selected, undefined, (count, state) => {
          setMovedCount(count); setCleanupProgress(state || null);
          if (state?.movedIds?.length) { removeFromOverview(state.movedIds); setMovedInOtherView(previous => [...new Set([...previous, ...state.movedIds!])]); }
          if (state?.undoMessages?.length) undo.recordGroup(operationId, 'Gmail cleanup', state.undoMessages);
        }, controller?.signal);
        setScan(prev => prev ? { ...prev, items: prev.items.filter(item => !result.moved.includes(item.id)) } : prev);
        setSelected(result.remaining); setReviewOpen(false);
        setToast(`${result.moved.length} messages moved to Gmail Trash.${result.cancelled ? ' Cleanup cancelled; remaining messages were kept.' : ''}`);
        if (result.failed.length) setError("Cleanup stopped after a Google error. Refresh before continuing; completed moves are retained.");
        return;
      }
      const res = await fetch("/api/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageIds: selected }), cache: "no-store" });
      const data = await res.json() as { status?: string; error?: string; moved?: number };
      if (!res.ok || data.status !== "success") throw new Error(data.error || "Cleanup could not be confirmed");
      setReviewOpen(false); setToast(`${data.moved} messages moved to Gmail Trash. You can restore them there.`);
      setScan(prev => prev ? { ...prev, items: prev.items.filter(item => !selected.includes(item.id)) } : prev);
      setSelected([]);
    } catch (e) { setError(e instanceof Error ? e.message : "Cleanup failed. Check Gmail before retrying."); setReviewOpen(false); }
    finally { cleanController.current = null; setCleaning(false); setStoppingCleanup(false); }
  }
  function openDrive() { scanController.current?.abort(); setDriveOpened(true); setView("drive"); setMobileNav(false); }
  const undoPanel = <CleanupUndo undo={undo} disabled={cleaning || directoryDeleting || (senderBusy && !directoryScanning)} />;
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
      <div className="brand"><div className="brand-mark"><Sparkles size={22} strokeWidth={2.4} /></div><span>mailbot<span className="brand-dot">.</span></span></div>
      <div className="nav-caption">WORKSPACE</div>
      <button className={`nav-item ${view === "overview" && source === "all" && category === "All items" ? "active" : ""}`} onClick={() => { setView("overview"); setSource("all"); setCategory("All items"); setMobileNav(false); }}><LayoutDashboard size={19} /> Overview <span className="nav-pill">{items.length || ""}</span></button>
      <button className={`nav-item ${view === "overview" && source === "gmail" ? "active" : ""}`} onClick={() => { setView("overview"); setSource("gmail"); setCategory("All items"); setMobileNav(false); }}><Inbox size={19} /> Gmail <span className="nav-count">{items.filter(i => i.source === "gmail").length || ""}</span></button>
      <button className={`nav-item ${view === "senders" ? "active" : ""}`} onClick={() => { scanController.current?.abort(); setSendersOpened(true); setView("senders"); setMobileNav(false); }}><UsersRound size={19} /> Senders {senderBusy && sendersOpened && <RefreshCw size={12} className="spin" />}</button>
      <button className={`nav-item ${view === "drive" ? "active" : ""}`} onClick={openDrive}><Cloud size={19} /> Google Drive</button>
      <div className="nav-caption nav-lower">QUICK FILTERS</div>
      {["Promotions", "Newsletters", "Large mail", "Same-name files"].map(name => <button key={name} className={`nav-item sub ${view === "overview" && category === name ? "active" : ""}`} onClick={() => { setView("overview"); setCategory(name); setSource("all"); setMobileNav(false); }}><span className="tiny-orb" />{name}</button>)}
      <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><ShieldCheck size={18} /></div><strong>Your data stays yours</strong><p>Mailbot never moves anything without your review and approval.</p><a href="https://support.google.com/mail/answer/7401" target="_blank" rel="noreferrer">How Trash works <ArrowRight size={13} /></a></div><div className="side-foot">MADE FOR A CLEARER HEADSPACE ✳</div></div>
    </aside>
    <main className="main">
      <header className="topbar"><button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle menu"><Menu size={21} /></button><div className="breadcrumb">Workspace <span>/</span> <strong>{view === "senders" ? "Senders" : view === "drive" ? "Google Drive" : "Overview"}</strong></div><div className="header-right"><div className="secure-label"><LockKeyhole size={14} /> Private workspace</div>{google.session ? <button className="google-account" disabled={senderBusy || driveBusy || cleaning || !!undo.restoring} onClick={google.disconnect} title="Disconnect Google account">{google.session.email} <X size={13} /></button> : hostedUser ? <><button className="signin-small google-signin" onClick={google.connect} disabled={google.connecting}>{google.connecting ? "Connecting…" : "Connect Google"}</button><a className="avatar" href={signOutPath} target="_top" title="Sign out">{user?.name.slice(0, 1).toUpperCase()}</a></> : <button className="signin-small google-signin" onClick={google.connect} disabled={google.connecting}>{google.connecting ? "Connecting…" : "Sign in with Google"}</button>}</div></header>
      <div className="content"><ScanNotice session={google.session} connecting={google.connecting} onConnect={google.connect} />{view !== "drive" && google.connectionError && <div className="error-banner" role="alert">{google.connectionError}<button onClick={google.connect} disabled={google.connecting}>Reconnect Google</button><button onClick={() => google.setSetupOpen(true)}>Connection settings</button></div>}{driveOpened && <div hidden={view !== "drive"}><DriveBrowser key={google.session?.email || "disconnected"} session={google.session} active={view === "drive"} connecting={google.connecting} connectionError={google.connectionError} clientId={google.clientId} externalBusy={loading || cleaning || senderBusy || !!undo.restoring} onConnect={google.connectDrive} onBusy={setDriveBusy} /></div>}{sendersOpened && <div hidden={view !== "senders"}><SenderDirectory key={google.session?.email || "disconnected"} undoPanel={undoPanel} active={view === "senders"} session={google.session} onConnect={google.connect} connecting={google.connecting} onBusy={setSenderBusy} onScanning={setDirectoryScanning} onDeleting={setDirectoryDeleting} externalBusy={loading || cleaning || driveBusy || !!undo.restoring} externalMovedIds={movedInOtherView} externalRestoredMessages={restoredInOtherView} onUndoGroup={undo.recordGroup} onMoved={removeFromOverview} /></div>}{view === "overview" && <>
        <div className="eyebrow"><span className="eyebrow-dot" /> YOUR DIGITAL SPACE, REIMAGINED</div>
        <div className="heading-row"><div><h1>A little less digital noise<span className="period">.</span></h1><p className="intro">Find what you no longer need. Keep what matters.</p></div><button className="refresh-btn" onClick={() => void refresh()} disabled={!user || loading || senderBusy || driveBusy || !!undo.restoring}><RefreshCw size={16} className={loading ? "spin" : ""} />{loading ? "Scanning…" : "Scan again"}</button></div>
        {undoPanel}
        {!user && <div className="connect-banner"><div className="connect-symbol"><Sparkles size={25} /></div><div><strong>Start with a clear view of your clutter</strong><p>Connect your Google account to scan Gmail and clean up mail from specific senders.</p></div><button onClick={google.connect} disabled={google.connecting} className="primary-btn">{google.connecting ? "Connecting…" : "Sign in with Google"} <ArrowRight size={16} /></button></div>}

        {google.storageWarning && <div className="error-banner">This browser is blocking session storage. Allow it for Mailbot to keep Gmail connected through reloads.</div>}
        {google.session && <div className="connected-banner"><ShieldCheck size={16} /><span>Gmail connected as <strong>{google.session.email}</strong></span><small>{loading && scanProgress ? `${scanProgress.phase}: ${scanProgress.inspected.toLocaleString()} ${scanProgress.phase === "Preparing scanned suggestions" ? "suggestions prepared" : "mailbox headers read"}; ${scanProgress.candidates.toLocaleString()} matches found. ${scanProgress.mailboxTotal.toLocaleString()} mailbox messages.` : fastReaderEnabled(google.session) ? "Fast scans use the hosted reader." : "Reconnect Google to enable fast scanning."}</small></div>}
        <SenderCleanup key={google.session?.email || "disconnected"} session={google.session} onConnect={google.connect} onBusy={setSenderBusy} onUndoGroup={undo.recordGroup} externalBusy={cleaning || loading || directoryScanning || directoryDeleting || !!undo.restoring} onMoved={ids => { removeFromOverview(ids); setMovedInOtherView(previous => [...new Set([...previous, ...ids])]); }} />
        {error && <div className="error-banner">{error}<button onClick={() => setError("")} aria-label="Dismiss"><X size={16} /></button></div>}
        {scan?.errors?.length ? <div className="notice-banner">Some sources need attention: {scan.errors.join(" · ")} {scan.reconnect ? <a href={scan.reconnect} target="_top">Connect account</a> : <button onClick={() => void refresh()}>Retry</button>}</div> : null}
        <div className="stat-grid">
          <div className="stat-card main-stat"><div className="stat-top"><span className="stat-icon purple"><HardDrive size={19} /></span><span className="stat-label">{google.session ? "MAILBOX MESSAGES" : "SCAN COVERAGE"}</span></div><div className="stat-number">{scan ? scan.scanned.gmail + scan.scanned.drive : "—"}<span className="stat-unit">items</span></div><div className="stat-desc">{google.session ? "Total Gmail messages; suggestions appear separately" : "Across connected Gmail & Drive results"}</div><div className="meter"><span style={{ width: scan && scan.scanned.gmail + scan.scanned.drive ? `${scan.scanned.gmail / (scan.scanned.gmail + scan.scanned.drive) * 100}%` : "0%" }} /></div><div className="meter-note"><span>Gmail {scan?.scanned.gmail ?? "—"}</span><span>Drive {scan?.scanned.drive ?? "—"}</span></div></div>
          <div className="stat-card"><div className="stat-top"><span className="stat-icon mint"><Sparkles size={19} /></span><span className="stat-label">OPPORTUNITIES FOUND</span></div><div className="stat-number">{scan ? items.length : "—"}<span className="stat-unit">suggestions</span></div><div className="stat-desc">Messages and files worth reviewing</div><div className="stat-foot mint-text">✳ Smart suggestions, never automatic</div></div>
          <div className="stat-card"><div className="stat-top"><span className="stat-icon peach"><Cloud size={19} /></span><span className="stat-label">DRIVE CANDIDATES</span></div><div className="stat-number">{scan ? formatSize(driveBytes) : "—"}</div><div className="stat-desc">Combined size of flagged Drive files</div><div className="stat-foot">Not a full account storage total</div></div>
        </div>
        <div className="insight-card"><div className="insight-glow" /><div className="insight-icon"><Sparkles size={20} /></div><div className="insight-copy"><span>SMART INSIGHT</span><h2>{scan ? items.length ? `${items.filter(i => i.source === "gmail").length} emails and ${items.filter(i => i.source === "drive").length} files deserve a closer look.` : "Looking good. No candidates in this scan." : "A calmer inbox is one scan away."}</h2><p>{scan ? "Suggestions use age, category, size and matching file names. Open anything you're unsure about before selecting it." : "Connect your account to get thoughtful, explainable cleanup suggestions."}</p></div><div className="insight-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><Sparkles size={44} /></div></div>
        <section className="review-section"><div className="section-heading"><div><div className="section-kicker">YOUR CLEANUP QUEUE</div><h2>Review & decide <span>{items.length}</span></h2><p>A thoughtful shortlist. Nothing changes until you confirm.</p></div><div className="section-actions"><button className="text-btn" onClick={selectVisible} disabled={!selectable.length}><CheckCheck size={16} /> Select visible</button><button className="cleanup-btn" onClick={() => setReviewOpen(true)} disabled={!selected.length || !!undo.restoring || (senderBusy && (!directoryScanning || directoryDeleting))}><Trash2 size={16} /> Review cleanup {selected.length ? `(${selected.length})` : ""}</button></div></div>
          <div className="queue-card"><div className="queue-toolbar"><div className="tabs"><button className={source === "all" ? "tab active-tab" : "tab"} onClick={() => setSource("all")}>All <span>{items.length}</span></button><button className={source === "gmail" ? "tab active-tab" : "tab"} onClick={() => setSource("gmail")}>Gmail <span>{items.filter(i => i.source === "gmail").length}</span></button><button className={source === "drive" ? "tab active-tab" : "tab"} onClick={openDrive}>Browse Drive</button></div><div className="toolbar-right"><label className="search-box"><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search items" /></label><label className="filter-box"><select value={category} onChange={e => setCategory(e.target.value)} aria-label="Filter category">{categories.map(c => <option key={c}>{c}</option>)}</select><ChevronDown size={14} /></label></div></div>
            <div className="list-head"><span>ITEM</span><span>RECOMMENDATION</span><span>SIZE</span><span>UPDATED</span><span></span></div>
            {loading && !scan ? <div className="empty-state"><div className="empty-orb pulse"><RefreshCw size={23} /></div><h3>Scanning your space…</h3><p>Looking for the things that might be ready to go.</p></div> : visible.length ? <div className="item-list">{visible.map(item => <div className={`item-row ${selected.includes(item.id) ? "row-selected" : ""}`} key={`${item.source}-${item.id}`}><div className="item-main"><button className={`check-box ${selected.includes(item.id) ? "checked" : ""}`} disabled={!item.canTrash} onClick={() => toggle(item.id)} aria-label={`Select ${item.title}`} title={item.canTrash ? "Select for cleanup" : "Open in Drive to review"}>{selected.includes(item.id) && <Check size={13} />}</button><div className={`item-icon ${item.source === "drive" ? "drive-icon" : "mail-icon"}`}>{item.source === "drive" ? <FileText size={19} /> : <Mail size={19} />}</div><div className="item-info"><a href={item.url} target="_blank" rel="noreferrer" title={item.title}>{item.title}</a><span>{item.subtitle}</span></div></div><div className="rec-col"><span className={`category-tag ${item.category === "Spam" ? "spam-tag" : ""}`}>{item.category}</span><small>{item.reason}</small></div><div className="size-cell">{item.size != null ? item.source === "gmail" ? `≥ ${formatSize(item.size)}` : formatSize(item.size) : "—"}</div><div className="date-cell">{item.date ? new Date(item.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—"}</div><a className="open-item" href={item.url} target="_blank" rel="noreferrer" title="Open item"><ArrowRight size={17} /></a></div>)}</div> : <div className="empty-state"><div className="empty-orb"><Inbox size={24} /></div><h3>{scan ? "Nothing matches this view" : "Your cleanup queue is ready when you are"}</h3><p>{scan ? "Try a different filter or search term." : "Connect and scan Gmail and Drive to see suggestions here."}</p></div>}</div>
          <div className="queue-footer"><span><ShieldCheck size={15} /> {scan ? scan.coverage : "All changes require your approval."}</span>{google.session && scan?.pending?.length ? <button className="text-btn" onClick={() => void loadMore()} disabled={loading || senderBusy || cleaning}>Load next {Math.min(detailBatchSize, scan.pending.length)} of {scan.pending.length.toLocaleString()} matches</button> : null}<span>{selected.length} selected</span></div></section>
        <footer className="page-footer"><span>Mailbot helps you make the call. You stay in control.</span><span>Gmail and Drive cleanup move reviewed items to Trash</span></footer></>}
      </div>
    </main>
    {reviewOpen && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) cancelReview(); }}><div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title"><button className="modal-close" onClick={cancelReview} disabled={stoppingCleanup || (cleaning && !google.session)} aria-label="Close"><X size={19} /></button><div className="modal-icon"><Trash2 size={22} /></div><div className="modal-kicker">ONE LAST LOOK</div><h2 id="review-title">Ready to clear some space?</h2><p>{selected.length} selected Gmail message{selected.length === 1 ? "" : "s"} will be moved to Trash. Review each one below. You can restore them from Gmail Trash.</p><div className="review-list">{selectedItems.map(item => <div key={item.id}><Mail size={16} /><span>{item.title}</span><button onClick={() => toggle(item.id)} disabled={cleaning} aria-label={`Remove ${item.title}`}><X size={15} /></button></div>)}</div><div className="modal-estimate"><span>Known minimum size in selection</span><strong>{formatSize(knownSelectedBytes)}</strong></div>{cleaning && google.session && <p role="status">{stoppingCleanup ? "Stopping after the groups already sent finish." : cleanupProgress?.phase === "checking" ? "Checking the selected emails…" : cleanupProgress?.phase === "waiting" ? `Google requested a quota pause of about ${cleanupProgress.waitSeconds} seconds.` : `${movedCount.toLocaleString()} moved so far. Moving in groups of up to 1,000 emails.`}</p>}<div className="modal-buttons"><button className="cancel-btn" onClick={cancelReview} disabled={stoppingCleanup || (cleaning && !google.session)}>{stoppingCleanup ? "Stopping…" : cleaning ? "Cancel" : "Keep these"}</button><button className="confirm-btn" disabled={!selected.length || cleaning} onClick={() => void clean()}>{cleaning ? "Moving…" : `Move ${selected.length} to Trash`} <ArrowRight size={16} /></button></div></div></div>}
    {google.setupOpen && <GoogleSetup clientId={google.clientId} onClose={() => google.setSetupOpen(false)} onSave={value => { google.saveClientId(value); setToast("Google connection saved. Click Sign in with Google to connect."); }} />}
    {toast && <div className="toast"><span className="toast-check"><Check size={15} /></span>{toast}<button onClick={() => setToast("")} aria-label="Dismiss"><X size={14} /></button></div>}
  </div>;
}
