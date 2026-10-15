import type { IndexedMessage } from './google-mail';

const databaseName = 'mailbot-sender-directory';
const storeName = 'messages';
type StoredMessage = IndexedMessage & { key: string; account: string };

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore(storeName, { keyPath: 'key' });
      store.createIndex('account', 'account');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function readSenderCache(account: string): Promise<IndexedMessage[]> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).index('account').getAll(account);
    const result = await new Promise<StoredMessage[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return result.map(({ key: _key, account: _account, ...message }) => message);
  } finally { db.close(); }
}

export async function saveSenderCache(account: string, messages: IndexedMessage[]): Promise<void> {
  if (!messages.length) return;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    for (const message of messages) store.put({ ...message, account, key: `${account}:${message.id}` } satisfies StoredMessage);
    await transactionDone(transaction);
  } finally { db.close(); }
}

export async function removeSenderCache(account: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    for (const id of ids) store.delete(`${account}:${id}`);
    await transactionDone(transaction);
  } finally { db.close(); }
}

export async function clearSenderCache(account: string): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(storeName, 'readwrite');
    const index = transaction.objectStore(storeName).index('account');
    const request = index.openKeyCursor(IDBKeyRange.only(account));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { transaction.objectStore(storeName).delete(cursor.primaryKey); cursor.continue(); }
    };
    await transactionDone(transaction);
  } finally { db.close(); }
}
