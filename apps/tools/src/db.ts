// A small IndexedDB: the app's metadata (add-on manifests, history) and files kept by add-ons.
const NAME = 'kurokawa-tools';
let dbp: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta'); if (!d.objectStoreNames.contains('files')) d.createObjectStore('files'); if (!d.objectStoreNames.contains('history')) d.createObjectStore('history', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | IDBRequest): Promise<T> {
  return openDb().then((d) => new Promise<T>((res, rej) => { const t = d.transaction(store, mode); const q = fn(t.objectStore(store)); q.onsuccess = () => res(q.result as T); q.onerror = () => rej(q.error); }));
}
export const db = {
  getMeta<T>(key: string): Promise<T | undefined> { return tx<T | undefined>('meta', 'readonly', (s) => s.get(key)); },
  setMeta<T>(key: string, value: T): Promise<void> { return tx('meta', 'readwrite', (s) => s.put(value, key)).then(() => undefined); },
  deleteMeta(key: string): Promise<void> { return tx('meta', 'readwrite', (s) => s.delete(key)).then(() => undefined); },
  getFile(key: string): Promise<Blob | undefined> { return tx<Blob | undefined>('files', 'readonly', (s) => s.get(key)); },
  putFile(key: string, blob: Blob): Promise<void> { return tx('files', 'readwrite', (s) => s.put(blob, key)).then(() => undefined); },
  deleteFile(key: string): Promise<void> { return tx('files', 'readwrite', (s) => s.delete(key)).then(() => undefined); },
};
export const uid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
