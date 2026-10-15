import type { GoogleSession } from './google-mail';

export const driveTypes = ['All files', 'Documents', 'Spreadsheets', 'Presentations', 'PDFs', 'Images', 'Videos', 'Audio', 'Archives', 'Shortcuts', 'Other'] as const;
export type DriveType = typeof driveTypes[number];
export type DriveSort = 'largest' | 'smallest' | 'name' | 'newest' | 'oldest';
export type DriveFile = { id: string; name: string; mimeType: string; size?: string; quotaBytesUsed?: string; modifiedTime?: string; ownedByMe?: boolean; shared?: boolean; driveId?: string; trashed?: boolean; capabilities?: { canTrash?: boolean; canUntrash?: boolean } };
const root = 'https://www.googleapis.com/drive/v3';
const fields = 'id,name,mimeType,size,quotaBytesUsed,modifiedTime,ownedByMe,shared,driveId,trashed,capabilities(canTrash,canUntrash)';
const folder = 'application/vnd.google-apps.folder';
const abortError = () => new DOMException('Drive operation cancelled', 'AbortError');
export class DriveError extends Error {
  constructor(message: string, public status: number, public reason = '') { super(message); }
}

export function driveType(file: DriveFile): DriveType {
  const mime = file.mimeType.toLowerCase(); const name = file.name.toLowerCase();
  if (mime === 'application/vnd.google-apps.shortcut') return 'Shortcuts';
  if (mime === 'application/pdf' || /\.pdf$/.test(name)) return 'PDFs';
  if (mime.startsWith('image/') || mime === 'application/vnd.google-apps.drawing') return 'Images';
  if (mime.startsWith('video/') || mime === 'application/vnd.google-apps.vid') return 'Videos';
  if (mime.startsWith('audio/')) return 'Audio';
  if (/spreadsheet|excel|csv/.test(mime) || /\.(xlsx?|csv|ods|tsv)$/.test(name)) return 'Spreadsheets';
  if (/presentation|powerpoint/.test(mime) || /\.(pptx?|odp)$/.test(name)) return 'Presentations';
  if (/document|msword|rtf|opendocument.text/.test(mime) || mime.startsWith('text/') || /\.(docx?|odt|rtf|txt|md)$/.test(name)) return 'Documents';
  if (/zip|compressed|x-tar|gzip|x-7z/.test(mime) || /\.(zip|rar|7z|tar|gz|bz2)$/.test(name)) return 'Archives';
  return 'Other';
}
export function driveBytes(file: DriveFile): number | null {
  const value = file.size ?? file.quotaBytesUsed;
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const size = Number(value); return Number.isSafeInteger(size) ? size : null;
}
export function formatDriveBytes(size: number | null): string {
  if (size === null) return 'Unavailable';
  if (size === 0) return '0 B';
  const unit = Math.min(4, Math.floor(Math.log(size) / Math.log(1000)));
  return `${(size / 1000 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
export function sortDriveFiles(files: DriveFile[], type: DriveType, query: string, sort: DriveSort): DriveFile[] {
  const needle = query.trim().toLocaleLowerCase();
  return files.filter(file => (type === 'All files' || driveType(file) === type) && (!needle || file.name.toLocaleLowerCase().includes(needle))).sort((a, b) => {
    if (sort === 'largest' || sort === 'smallest') {
      const x = driveBytes(a), y = driveBytes(b);
      if (x === null || y === null) return x === y ? a.name.localeCompare(b.name) : x === null ? 1 : -1;
      const difference = sort === 'largest' ? y - x : x - y;
      return difference || a.name.localeCompare(b.name);
    }
    if (sort === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true });
    return ((Date.parse(a.modifiedTime || '') || 0) - (Date.parse(b.modifiedTime || '') || 0)) * (sort === 'newest' ? -1 : 1) || a.name.localeCompare(b.name);
  });
}

async function request<T>(session: GoogleSession, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw abortError();
  if (session.expiresAt <= Date.now()) throw new DriveError('Google access expired. Reconnect Google Drive.', 401);
  const response = await fetch(`${root}${path}`, { ...init, headers: { Authorization: `Bearer ${session.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, cache: 'no-store' });
  const data = await response.json() as T & { error?: { message?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } };
  if (!response.ok) {
    const reason = data.error?.details?.find(detail => detail.reason)?.reason || data.error?.errors?.[0]?.reason || '';
    if (reason === 'SERVICE_DISABLED' || reason === 'accessNotConfigured') throw new DriveError('Enable the Google Drive API in your Google Cloud project, then retry.', response.status, 'disabled');
    if (response.status === 401) throw new DriveError('Google access expired. Reconnect Google Drive.', 401);
    if (reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') throw new DriveError('Connect Google Drive and approve Drive access to continue.', response.status, 'scope');
    throw new DriveError(data.error?.message || `Google Drive request failed (${response.status}).`, response.status, reason);
  }
  return data;
}

export async function listDriveFiles(session: GoogleSession, onPage: (files: DriveFile[], complete: boolean) => void, signal?: AbortSignal): Promise<DriveFile[]> {
  const files = new Map<string, DriveFile>(); const seen = new Set<string>(); let pageToken = '';
  do {
    const params = new URLSearchParams({ q: `trashed = false and mimeType != '${folder}'`, pageSize: '1000', spaces: 'drive', corpora: 'user', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true', orderBy: 'quotaBytesUsed desc,name', fields: `nextPageToken,incompleteSearch,files(${fields})` });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await request<{ files?: DriveFile[]; nextPageToken?: string; incompleteSearch?: boolean }>(session, `/files?${params}`, { signal }, signal);
    if (signal?.aborted) throw abortError();
    for (const file of page.files || []) if (file.id && file.mimeType !== folder && !file.trashed) files.set(file.id, file);
    if (page.incompleteSearch) throw new DriveError('Google returned an incomplete Drive search. Refresh to try again.', 503);
    pageToken = page.nextPageToken || '';
    if (pageToken && seen.has(pageToken)) throw new DriveError('Google repeated a Drive page. Refresh to restart.', 503);
    seen.add(pageToken); onPage([...files.values()], !pageToken);
  } while (pageToken);
  return [...files.values()];
}

export type DriveTrashResult = { moved: string[]; failed: { id: string; name: string; error: string }[]; remaining: string[]; cancelled: boolean };
export async function trashDriveFiles(session: GoogleSession, reviewed: DriveFile[], onMoved: (id: string) => void, signal?: AbortSignal): Promise<DriveTrashResult> {
  const unique = [...new Map(reviewed.map(file => [file.id, file])).values()];
  if (unique.some(file => !/^[\w-]+$/.test(file.id) || file.mimeType === folder || !file.capabilities?.canTrash)) throw new Error('Only reviewed files that you can move to Trash may be selected.');
  const moved: string[] = []; const failed: DriveTrashResult['failed'] = []; let next = 0; let stop = false;
  await Promise.all(Array.from({ length: Math.min(5, unique.length) }, async () => {
    while (next < unique.length && !stop && !signal?.aborted) {
      const file = unique[next++];
      try {
        const current = await request<DriveFile>(session, `/files/${encodeURIComponent(file.id)}?supportsAllDrives=true&fields=id,mimeType,trashed,capabilities(canTrash)`, { signal }, signal);
        if (signal?.aborted) break;
        if (current.trashed) throw new Error('This file is already in Trash. Refresh the list.');
        if (!current.capabilities?.canTrash || current.mimeType === folder) throw new Error('You no longer have permission to move this file to Trash.');
        // Cancel stops queued work; submitted writes must finish so results stay accurate.
        const result = await request<{ id: string; trashed: boolean }>(session, `/files/${encodeURIComponent(file.id)}?supportsAllDrives=true&fields=id,trashed`, { method: 'PATCH', body: JSON.stringify({ trashed: true }) });
        if (result.id !== file.id || result.trashed !== true) throw new Error('Google did not confirm moving this file. Check Drive before retrying.');
        moved.push(file.id); onMoved(file.id);
      } catch (error) {
        if (signal?.aborted && (error as Error).name === 'AbortError') continue;
        failed.push({ id: file.id, name: file.name, error: error instanceof Error ? error.message : 'Move could not be confirmed. Check Drive.' });
        if (error instanceof DriveError && [401, 429, 503].includes(error.status)) stop = true;
      }
    }
  }));
  const completed = new Set(moved);
  return { moved, failed, remaining: unique.filter(file => !completed.has(file.id)).map(file => file.id), cancelled: signal?.aborted || false };
}
