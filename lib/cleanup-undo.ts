import type { UndoMessage } from './google-mail';

export type UndoRecord = { id: string; account: string; label: string; createdAt: number; messages: UndoMessage[] };

export function addUndoGroup(history: UndoRecord[], group: UndoRecord): UndoRecord[] {
  if (!group.messages.length) return history;
  const incoming = new Set(group.messages.map(message => message.id));
  const previous = history.find(record => record.id === group.id && record.account === group.account);
  const messages = new Map(previous?.messages.map(message => [message.id, message]));
  for (const message of group.messages) messages.set(message.id, message);
  const record = { ...group, createdAt: previous?.createdAt || group.createdAt, messages: [...messages.values()] };
  // An older cleanup must not undo a later cleanup of the same message.
  const other = history.filter(item => item.id !== group.id && item.account === group.account).map(item => ({ ...item, messages: item.messages.filter(message => !incoming.has(message.id)) })).filter(item => item.messages.length);
  return [record, ...other].slice(0, 5);
}

export function removeRestored(history: UndoRecord[], id: string, restored: UndoMessage[]): UndoRecord[] {
  const ids = new Set(restored.map(message => message.id));
  return history.map(record => record.id === id ? { ...record, messages: record.messages.filter(message => !ids.has(message.id)) } : record).filter(record => record.messages.length);
}

export function readUndoHistory(account: string): UndoRecord[] {
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(`mailbot.cleanupUndo.v1:${account}`) || '[]');
    if (!Array.isArray(data)) return [];
    return data.filter((record): record is UndoRecord => !!record && record.account === account && typeof record.id === 'string' && typeof record.label === 'string' && typeof record.createdAt === 'number' && Array.isArray(record.messages) && record.messages.every((message: UndoMessage) => !!message && typeof message.id === 'string' && /^[a-f0-9]+$/i.test(message.id) && typeof message.inInbox === 'boolean')).slice(0, 5);
  } catch { return []; }
}
