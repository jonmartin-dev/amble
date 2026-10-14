// A small IndexedDB store shared by the app and its service worker: the saved query cache, and
// the outbox of changes waiting to be sent.

const NAME = 'almanac';
const VERSION = 1;

export const OUTBOX = 'outbox';
export const FAILED = 'failed';
export const KV = 'kv';

let opening: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains(FAILED)) db.createObjectStore(FAILED, { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the database closes this connection; the next call reopens it.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      opening = null;
      reject(req.error);
    };
  });
  return opening;
}

/** Runs one transaction and resolves with `fn`'s request result once it commits. */
export async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : (undefined as T));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kvGet = <T>(key: string) => tx<T | undefined>(KV, 'readonly', (s) => s.get(key));
export const kvSet = (key: string, value: unknown) => tx<void>(KV, 'readwrite', (s) => void s.put(value, key));
export const kvDel = (key: string) => tx<void>(KV, 'readwrite', (s) => void s.delete(key));
