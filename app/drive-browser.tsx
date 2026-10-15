"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Cloud, FileText, RefreshCw, Search, Trash2, X } from 'lucide-react';
import type { GoogleSession } from '@/lib/google-mail';
import { DriveError, driveBytes, driveType, driveTypes, formatDriveBytes, listDriveFiles, sortDriveFiles, trashDriveFiles, type DriveFile, type DriveSort, type DriveType } from '@/lib/google-drive';

type Props = { session: GoogleSession | null; active: boolean; connecting: boolean; connectionError: string; clientId: string; externalBusy: boolean; onConnect: () => void; onBusy: (busy: boolean) => void };
export default function DriveBrowser({ session, active, connecting, connectionError, clientId, externalBusy, onConnect, onBusy }: Props) {
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [type, setType] = useState<DriveType>('All files');
  const [sorts, setSorts] = useState<Partial<Record<DriveType, DriveSort>>>({});
  const [query, setQuery] = useState('');
  const [showOwned, setShowOwned] = useState(true);
  const [showNotOwned, setShowNotOwned] = useState(false);
  const [limit, setLimit] = useState(100);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [complete, setComplete] = useState(false);
  const [moving, setMoving] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [moved, setMoved] = useState(0);
  const [review, setReview] = useState<DriveFile[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [needsApi, setNeedsApi] = useState(false);
  const [needsScope, setNeedsScope] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const loadedToken = useRef('');
  const busy = loading || moving;
  const sort = sorts[type] || 'largest';
  const ownershipFiles = useMemo(() => files.filter(file => file.ownedByMe === true ? showOwned : showNotOwned), [files, showOwned, showNotOwned]);
  const ownedCount = useMemo(() => files.filter(file => file.ownedByMe === true).length, [files]);
  const visible = useMemo(() => sortDriveFiles(ownershipFiles, type, query, sort), [ownershipFiles, type, query, sort]);
  const shown = visible.slice(0, limit);
  const stats = useMemo(() => driveTypes.map(label => {
    const group = label === 'All files' ? ownershipFiles : ownershipFiles.filter(file => driveType(file) === label);
    return { label, count: group.length, bytes: group.reduce((total, file) => total + (driveBytes(file) || 0), 0) };
  }), [ownershipFiles]);
  const totalBytes = stats[0].bytes;
  const selectedFiles = files.filter(file => selected.includes(file.id));

  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (active && session?.drive && loadedToken.current !== session.token && !controller.current) void refresh();
  }, [active, session?.token, externalBusy]);
  useEffect(() => { setLimit(100); }, [type, query, sort, showOwned, showNotOwned]);
  useEffect(() => {
    if (!review.length) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') closeReview(); };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [review.length, moving]);

  async function refresh() {
    if (!session?.drive || controller.current || externalBusy) return;
    const current = new AbortController(); controller.current = current; loadedToken.current = session.token;
    setLoading(true); setComplete(false); setFiles([]); setSelected([]); setError(''); setNeedsApi(false); setNeedsScope(false); setNotice('');
    try { await listDriveFiles(session, (page, done) => { setFiles(page); setComplete(done); }, current.signal); }
    catch (cause) {
      if (!current.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Drive could not load. Try refreshing.');
        setNeedsApi(cause instanceof DriveError && cause.reason === 'disabled');
        setNeedsScope(cause instanceof DriveError && (cause.reason === 'scope' || cause.status === 401));
      }
    } finally { if (controller.current === current) { controller.current = null; setLoading(false); } }
  }
  function toggle(id: string) { setSelected(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]); }
  function changeOwnership(owned: boolean, checked: boolean) {
    if (moving) return;
    if (owned) setShowOwned(checked); else setShowNotOwned(checked);
    setSelected([]);
  }
  function selectShown() {
    const ids = shown.filter(file => file.capabilities?.canTrash).map(file => file.id);
    setSelected(previous => ids.every(id => previous.includes(id)) ? previous.filter(id => !ids.includes(id)) : [...new Set([...previous, ...ids])]);
  }
  function openReview(items: DriveFile[]) { if (!busy && !externalBusy) { setReview(items.map(file => ({ ...file }))); setError(''); } }
  function closeReview() { if (moving) { setStopping(true); controller.current?.abort(); } else setReview([]); }
  async function move() {
    if (!session?.drive || !review.length || controller.current || externalBusy) return;
    const current = new AbortController(); controller.current = current;
    setMoving(true); setMoved(0); setStopping(false); setError(''); setNotice('');
    try {
      const result = await trashDriveFiles(session, review, id => {
        setMoved(count => count + 1); setFiles(previous => previous.filter(file => file.id !== id)); setSelected(previous => previous.filter(value => value !== id));
      }, current.signal);
      setReview([]);
      setNotice(`${result.moved.length.toLocaleString()} file${result.moved.length === 1 ? '' : 's'} moved to Drive Trash.${result.cancelled ? ' Canceled; remaining files were kept.' : ''}`);
      if (result.failed.length) setError(`${result.failed.length} file${result.failed.length === 1 ? '' : 's'} could not be moved. ${result.failed[0].name}: ${result.failed[0].error}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Drive cleanup failed. Check Drive before retrying.'); setReview([]); }
    finally { if (controller.current === current) { controller.current = null; setMoving(false); setStopping(false); } }
  }
  const blocked = busy || externalBusy;
  const project = clientId.split('-')[0];
  return <section className="drive-browser" aria-label="Google Drive file browser">
    <div className="eyebrow"><span className="eyebrow-dot" /> YOUR FILES, A LITTLE LIGHTER</div>
    <div className="directory-top"><div><h1>Google Drive<span className="period">.</span></h1><p className="intro">Find your biggest files. Browse by type, then choose what to keep.</p></div><button className="refresh-btn directory-refresh" disabled={!session?.drive || blocked} onClick={() => void refresh()}><RefreshCw size={16} className={loading ? 'spin' : ''} />Refresh files</button></div>
    {!session?.drive ? <div className="directory-empty"><Cloud size={30} /><h2>Connect your Google Drive</h2><p>Browse existing files and move selected files to Trash. Google will ask for Drive access.</p><button className="primary-btn" disabled={connecting || externalBusy} onClick={onConnect}>{connecting ? 'Connecting…' : 'Connect Google Drive'}<ArrowRight size={16} /></button>{connectionError && <p className="drive-connect-error" role="alert">{connectionError}</p>}</div> : <>
      <div className="drive-summary"><div><strong>{ownershipFiles.length.toLocaleString()}</strong><span>{loading ? 'matching files loaded so far' : complete ? 'files matching ownership' : 'matching files · scan incomplete'}</span></div><div><strong>{formatDriveBytes(totalBytes)}</strong><span>Known size of filtered files</span></div><div className="drive-summary-account"><Cloud size={17} /><span>{session.email}</span></div>{loading && <button className="text-btn" onClick={() => controller.current?.abort()}>Stop loading</button>}</div>
      {loading && <p className="directory-help" role="status">Loading every page of files. Largest-first sorting updates as files arrive.</p>}
      {!loading && !complete && files.length > 0 && <p className="directory-warning">This is a partial list. Refresh to load all pages.</p>}
      {error && <div className="error-banner" role="alert"><span>{error}{needsApi && <a href={`https://console.cloud.google.com/apis/library/drive.googleapis.com${/^\d+$/.test(project) ? `?project=${project}` : ''}`} target="_blank" rel="noreferrer"> Open Google Cloud</a>}{needsScope && <button onClick={onConnect} disabled={blocked || connecting}>Reconnect Drive</button>}</span><button onClick={() => setError('')} aria-label="Dismiss Drive error"><X size={16} /></button></div>}
      {notice && <div className="drive-notice" role="status"><Check size={16} /><span>{notice} <a href="https://drive.google.com/drive/trash" target="_blank" rel="noreferrer">Open Drive Trash to restore</a></span><button className="undo-dismiss-btn" aria-label="Dismiss Drive confirmation" onClick={() => setNotice('')}><X size={15} /></button></div>}
      <fieldset className="drive-ownership"><legend>File ownership</legend><label><input type="checkbox" checked={showOwned} disabled={moving} onChange={event => changeOwnership(true, event.target.checked)} /><span>Owned by me</span><small>{ownedCount.toLocaleString()}</small></label><label><input type="checkbox" checked={showNotOwned} disabled={moving} onChange={event => changeOwnership(false, event.target.checked)} /><span>Not owned by me</span><small>{(files.length - ownedCount).toLocaleString()}</small></label></fieldset>
      <div className="drive-types" aria-label="File types">{stats.map(stat => <button key={stat.label} className={`drive-type ${type === stat.label ? 'drive-type-active' : ''}`} aria-pressed={type === stat.label} onClick={() => { setType(stat.label); setSelected([]); }}><span>{stat.label}</span><strong>{stat.count.toLocaleString()}</strong><small>{formatDriveBytes(stat.bytes)}</small></button>)}</div>
      <div className="queue-card drive-files"><div className="drive-toolbar"><label className="directory-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search file names" aria-label="Search Drive files" /></label><label className="drive-sort"><span>Sort {type.toLowerCase()}</span><select aria-label="Sort Drive files" value={sort} onChange={event => setSorts(previous => ({ ...previous, [type]: event.target.value as DriveSort }))}><option value="largest">Largest first</option><option value="smallest">Smallest first</option><option value="name">Name A–Z</option><option value="newest">Recently updated</option><option value="oldest">Oldest updated</option></select></label></div>
        <div className="drive-selection"><div><button className="text-btn" disabled={blocked || !shown.some(file => file.capabilities?.canTrash)} onClick={selectShown}>Select visible ({shown.filter(file => file.capabilities?.canTrash).length})</button>{selected.length > 0 && <button className="text-btn" disabled={moving} onClick={() => setSelected([])}>Clear selection</button>}<span>{selected.length.toLocaleString()} selected</span></div><button className="cleanup-btn" disabled={blocked || !selectedFiles.length} onClick={() => openReview(selectedFiles)}><Trash2 size={15} />Review Trash{selectedFiles.length ? ` (${selectedFiles.length})` : ''}</button></div>
        <div className="drive-list-head"><span>FILE</span><span>SIZE</span><span>UPDATED</span><span /></div>
        {shown.length ? <div>{shown.map(file => <div className={`drive-file-row ${selected.includes(file.id) ? 'row-selected' : ''}`} key={file.id}><div className="item-main"><button className={`check-box ${selected.includes(file.id) ? 'checked' : ''}`} aria-label={`Select ${file.name}`} aria-pressed={selected.includes(file.id)} disabled={blocked || !file.capabilities?.canTrash} title={file.capabilities?.canTrash ? 'Select for Trash' : 'You cannot move this file to Trash'} onClick={() => toggle(file.id)}>{selected.includes(file.id) && <Check size={13} />}</button><div className="item-icon drive-icon"><FileText size={18} /></div><div className="item-info"><a href={`https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`} target="_blank" rel="noreferrer" title={file.name}>{file.name}</a><span>{driveType(file)}{file.ownedByMe === true ? file.shared ? ' · Owned by you · Shared' : ' · Owned by you' : file.driveId ? ' · Shared drive' : ' · Not owned by you'}{!file.capabilities?.canTrash ? ' · Cannot trash' : ''}</span></div></div><div className="size-cell" title={file.size === undefined && file.quotaBytesUsed !== undefined ? 'Storage bytes reported by Google' : 'File size reported by Google'}>{formatDriveBytes(driveBytes(file))}</div><div className="date-cell">{file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</div><button className="directory-single-trash" aria-label={`Move ${file.name} to Trash`} title="Review moving this file to Trash" disabled={blocked || !file.capabilities?.canTrash} onClick={() => openReview([file])}><Trash2 size={16} /></button></div>)}</div> : <div className="empty-state"><Cloud size={28} /><h3>{!showOwned && !showNotOwned ? 'Choose which files to show' : loading ? 'Loading your Drive…' : files.length ? 'No matching files' : complete ? 'No files here' : 'Your files will appear here'}</h3><p>{!showOwned && !showNotOwned ? 'Check Owned by me or Not owned by me above.' : files.length ? 'Try another file type, ownership filter, or search.' : 'Files from My Drive and files shared with you appear here.'}</p></div>}
        <div className="drive-list-foot"><span>Showing {shown.length.toLocaleString()} of {visible.length.toLocaleString()}{loading ? ' loaded matches' : ' matches'}</span>{shown.length < visible.length && <button className="text-btn" onClick={() => setLimit(previous => previous + 100)}>Show 100 more</button>}</div>
      </div><p className="directory-help">Folders are excluded. Shortcuts refer to the shortcut itself. Unknown sizes appear last when sorting by size. Listed sizes are not a storage quota total.</p>
    </>}
    {review.length > 0 && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeReview(); }}><div className="review-modal" role="dialog" aria-modal="true" aria-labelledby="drive-review-title"><button className="modal-close" aria-label="Close Drive review" disabled={stopping} onClick={closeReview}><X size={19} /></button><div className="modal-icon"><Trash2 size={22} /></div><div className="modal-kicker">REVIEW YOUR FILES</div><h2 id="drive-review-title">Move {review.length.toLocaleString()} file{review.length === 1 ? '' : 's'} to Trash?</h2><p>You can restore these files from Google Drive Trash. Google automatically removes trashed files after 30 days.</p>{review.some(file => file.shared || file.driveId || file.ownedByMe === false) && <p className="drive-shared-warning">This selection includes shared files. Other people may still be able to access them while they are in Trash.</p>}<div className="review-list">{review.map(file => <div key={file.id}><FileText size={16} /><a href={`https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`} target="_blank" rel="noreferrer">{file.name}</a><small>{formatDriveBytes(driveBytes(file))}</small><button disabled={moving} aria-label={`Keep ${file.name}`} onClick={() => setReview(previous => previous.filter(item => item.id !== file.id))}><X size={15} /></button></div>)}</div><div className="modal-estimate"><span>Known size of selected files</span><strong>{formatDriveBytes(review.reduce((total, file) => total + (driveBytes(file) || 0), 0))}</strong></div>{moving && <p role="status">{stopping ? 'Stopping after requests already sent finish…' : `${moved.toLocaleString()} of ${review.length.toLocaleString()} files moved…`}</p>}<div className="modal-buttons"><button className="cancel-btn" disabled={stopping} onClick={closeReview}>{stopping ? 'Stopping…' : moving ? 'Cancel' : 'Keep files'}</button><button className="confirm-btn" disabled={moving || externalBusy} onClick={() => void move()}>{moving ? 'Moving…' : 'Move to Trash'}<ArrowRight size={16} /></button></div></div></div>}
  </section>;
}
