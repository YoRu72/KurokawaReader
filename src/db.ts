// IndexedDB storage for the library. Two stores: `books` (metadata, progress,
// bookmarks, highlights) and `files` (the raw file blobs). Everything stays on
// the device; nothing is ever uploaded.

export type Format =
  | 'epub' | 'pdf' | 'docx' | 'xlsx' | 'csv' | 'pptx' | 'txt' | 'md' | 'html'
  | 'fb2' | 'odt' | 'cbz' | 'image' | 'unknown';

export interface Locator {
  /** Which opened document (book id). */
  bookId: string;
  /** Index of the top-visible block inside that document's content. */
  block?: number;
  /** Fraction (0–1) scrolled through that block. */
  offset?: number;
  /** Anchor id, when the position comes from a TOC entry or a search hit. */
  anchor?: string;
  /** PDF page number (1-based). */
  page?: number;
  /** Chapter index inside the book (chapter-by-chapter mode). */
  chapter?: number;
  /** Overall fraction through the document, for the progress bar. */
  pct: number;
}

export interface Bookmark {
  id: string;
  label: string;
  excerpt?: string;
  locator: Locator;
  createdAt: number;
}

export interface Highlight {
  id: string;
  text: string;
  /** Anchor of the chapter / block the highlight lives in. */
  anchor?: string;
  color: 'amber' | 'rose' | 'mint' | 'sky' | 'violet';
  note?: string;
  createdAt: number;
}

export interface ReadingDay { ms: number; pct: number; words: number }
export interface ReadingStats { ms: number; words: number; days: Record<string, ReadingDay>; bookWords?: number; bookChars?: number }

export interface Folder { id: string; name: string; createdAt: number }

export interface Book {
  id: string;
  folderId?: string;
  stats?: ReadingStats;
  title: string;
  author?: string;
  language?: string;
  format: Format;
  fileName: string;
  mime?: string;
  size: number;
  addedAt: number;
  lastOpenedAt?: number;
  cover?: Blob;
  pageCount?: number;
  progress?: Locator;
  bookmarks: Bookmark[];
  highlights: Highlight[];
  /** Cached per-book override of the visual settings (optional). */
  prefs?: Record<string, unknown>;
}

const DB_NAME = 'kurokawa-reader';
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        const books = db.createObjectStore('books', { keyPath: 'id' });
        books.createIndex('addedAt', 'addedAt');
        books.createIndex('lastOpenedAt', 'lastOpenedAt');
      }
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        let result: T;
        if (req) req.onsuccess = () => (result = req.result);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const db = {
  async allBooks(): Promise<Book[]> {
    return tx<Book[]>('books', 'readonly', (s) => s.getAll());
  },
  async getBook(id: string): Promise<Book | undefined> {
    return tx<Book | undefined>('books', 'readonly', (s) => s.get(id));
  },
  async putBook(book: Book): Promise<void> {
    await tx('books', 'readwrite', (s) => s.put(book));
  },
  async updateBook(id: string, patch: (b: Book) => void): Promise<Book | undefined> {
    const b = await this.getBook(id);
    if (!b) return undefined;
    patch(b);
    await this.putBook(b);
    return b;
  },
  async deleteBook(id: string): Promise<void> {
    await tx('books', 'readwrite', (s) => s.delete(id));
    await tx('files', 'readwrite', (s) => s.delete(id));
  },
  async putFile(id: string, blob: Blob): Promise<void> {
    await tx('files', 'readwrite', (s) => s.put(blob, id));
  },
  async getFile(id: string): Promise<Blob | undefined> {
    return tx<Blob | undefined>('files', 'readonly', (s) => s.get(id));
  },
  async deleteFile(id: string): Promise<void> {
    await tx('files', 'readwrite', (s) => s.delete(id));
  },
  async getMeta<T>(key: string): Promise<T | undefined> {
    return tx<T | undefined>('meta', 'readonly', (s) => s.get(key));
  },
  async setMeta<T>(key: string, value: T): Promise<void> {
    await tx('meta', 'readwrite', (s) => s.put(value, key));
  },
  async clearAll(): Promise<void> {
    await tx('books', 'readwrite', (s) => s.clear());
    await tx('files', 'readwrite', (s) => s.clear());
  },
};

export function uid(): string {
  return (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 20);
}
