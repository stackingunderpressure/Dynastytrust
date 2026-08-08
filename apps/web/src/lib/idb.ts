// Tiny IndexedDB wrapper -- Promise-shaped, no external dep. Ported from
// tapit-wallet's src/shared/lib/idb.ts (same shape, same rationale: durable
// local storage that survives a reload, without pulling in a library for
// what's a ~30-line wrapper around three IDBObjectStore calls).

const DB_NAME = 'dynastytrust';
const DB_VERSION = 1;
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB tx failed'));
      }),
  );
}

export const idb = {
  get<T>(key: string): Promise<T | undefined> {
    return tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  },
  put<T>(key: string, value: T): Promise<IDBValidKey> {
    return tx('readwrite', (s) => s.put(value, key));
  },
  delete(key: string): Promise<undefined> {
    return tx<undefined>('readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
  },
};
