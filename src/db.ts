// IndexedDB storage for the library. Two stores: `books` (metadata, progress,
// bookmarks, highlights) and `files` (the raw file blobs). Everything stays on
// the device; nothing is ever uploaded.

export type Format =
  | 'epub' | 'pdf' | 'docx' | 'xlsx' | 'csv' | 'pptx' | 'txt' | 'md' | 'html'
  | 'fb2' | 'odt' | 'cbz' | 'image' | 'mobi' | 'anki' | 'audio' | 'shamela' | 'webnovel' | 'unknown';

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
  /** Index of the contents entry the position is under. */
  toc?: number;
  /** Overall fraction through the document, for the progress bar. */
  pct: number;
}

/** A linked file: a content:// / file:// URI on Android, a path on the desktop. */
/** The reserved tag that marks favourites (shown with a heart, sorted first; it syncs and backs up like any tag). */
export const FAV_TAG = '★';

export interface FileSource { uri?: string; tree?: string; path?: string }

export interface Bookmark {
  id: string;
  label: string;
  excerpt?: string;
  locator: Locator;
  createdAt: number;
}

/** A stroke of ink on a PDF page: points as fractions of the page (x, y, x, y…), the width as a fraction of its width. */
export interface InkStroke { id: string; page: number; color: string; w: number; pts: number[]; createdAt: number }

/** A note pinned to a point on a PDF page (x, y as fractions of the page). */
export interface PdfNote { id: string; page: number; x: number; y: number; note: string; color: Highlight['color']; createdAt: number }

/** A text highlight on a PDF page. Rects are fractions of the page: [x, y, width, height]. */
export interface PdfHighlight { id: string; page: number; rects: [number, number, number, number][]; text: string; color: Highlight['color']; note?: string; noteAt?: number; createdAt: number }

export interface Highlight {
  id: string;
  text: string;
  /** Anchor of the chapter / block the highlight lives in. */
  anchor?: string;
  color: 'amber' | 'rose' | 'mint' | 'sky' | 'violet';
  note?: string;
  noteAt?: number;
  createdAt: number;
}

export interface ReadingDay { ms: number; pct: number; words: number; sessions?: number; pages?: number }
export interface ReadingStats { ms: number; words: number; pages?: number; sessions?: number; sessionAt?: number; days: Record<string, ReadingDay>; bookWords?: number; bookChars?: number }

export interface Folder { id: string; name: string; createdAt: number }
/** A tag the user created; kept even while no book carries it (meta 'tags'). */
export interface TagDef { name: string; createdAt: number }

export interface Book {
  id: string;
  folderId?: string;
  tags?: string[];
  tagsAt?: number;
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
  progressAt?: number;
  /** Marked read (or marked not read though its progress is at the end); unset: by progress. */
  done?: boolean;
  doneAt?: number;
  /** The reader's own rating, 1–5 stars. */
  rating?: number;
  ratingAt?: number;
  /** The reader's own words about the book. */
  review?: string;
  reviewAt?: number;
  /** Chapters marked read by hand on the book's page: every contents entry up to this index. */
  readToc?: number;
  readTocAt?: number;
  /** Chapters marked read (1) or unread (0) by hand, by contents index — over and above the position. */
  chapterMarks?: Record<string, 0 | 1>;
  chapterMarksAt?: number;
  /** How many chapters the book really has, as the reader says (a contents list carries covers, credits…). */
  chapters?: number;
  chaptersAt?: number;
  /** The book's entry on a tracking service (AniList), kept with it. */
  track?: import('./anilist').Track;
  /** The publisher's blurb, when the file carries one. */
  description?: string;
  bookmarks: Bookmark[];
  highlights: Highlight[];
  pins?: PdfNote[];
  ink?: InkStroke[];
  /** Where the file lives when it is linked instead of copied into the app (scan import). */
  source?: FileSource;
  /** A book from an online source (a Shamela book read from the site, a novel from an extension): where it
   *  came from, and whether its text still lives there (`online`) or has been fetched into its file; for a
   *  novel, how many chapters arrived since it was last opened and when the site was last asked. */
  remote?: { source: string; id: string; online?: boolean; newChapters?: number; checkedAt?: number; chapterCount?: number };
  /** The series the book is a volume of, as its source said (a title's own numbering is read otherwise). */
  series?: { name: string; index?: number };
  pdfHighlights?: PdfHighlight[];
  /** Cached per-book override of the visual settings (optional). */
  prefs?: Record<string, unknown>;
}

const DB_NAME = 'kurokawa-reader';
const DB_VERSION = 3;

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
      // Each book's text, read once for searching across the library.
      if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts');
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

// Small cache so re-opening a linked book, or re-rendering it, does not re-read it from storage.
const linkedCache = new Map<string, { size: number; blob: Blob }>();
async function readLinked(src: FileSource, name: string, mime?: string): Promise<Blob | undefined> {
  const key = src.uri ?? src.path ?? '';
  const hit = linkedCache.get(key); if (hit) return hit.blob;
  let blob: Blob | undefined;
  const cap = (window as unknown as { Capacitor?: { Plugins?: { Kurokawa?: { readDocument?(o: { uri: string; tree?: string }): Promise<{ data: string }> } } } }).Capacitor;
  const desk = (window as unknown as { kurokawaDesktop?: { readFile?(p: string): Promise<ArrayBuffer | Uint8Array> } }).kurokawaDesktop;
  try {
    const conv = (window as unknown as { Capacitor?: { convertFileSrc?(u: string): string } }).Capacitor?.convertFileSrc;
    if (src.uri && conv) {
      // The WebView reads the file straight from storage (no base64 round trip through the bridge).
      try { const r = await fetch(conv(src.uri)); if (r.ok) blob = new File([await r.blob()], name, { type: mime }); } catch { /* fall back below */ }
    }
    if (!blob && src.uri && cap?.Plugins?.Kurokawa?.readDocument) {
      const { data } = await cap.Plugins.Kurokawa.readDocument({ uri: src.uri, tree: src.tree });
      const bin = atob(data); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new File([bytes], name, { type: mime });
    } else if (src.path && desk?.readFile) {
      blob = new File([await desk.readFile(src.path) as ArrayBuffer], name, { type: mime });
    }
  } catch { blob = undefined; }
  if (blob) { linkedCache.set(key, { size: blob.size, blob }); while (linkedCache.size > 3) linkedCache.delete(linkedCache.keys().next().value!); }
  return blob;
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
    await tx('texts', 'readwrite', (s) => s.delete(id)).catch(() => undefined);
  },
  /** A book's searchable text (its pages or chapters), keyed by the book and the file it was read from. */
  async getText(id: string): Promise<{ key: string; units: { label: string; text: string }[] } | undefined> {
    return tx<{ key: string; units: { label: string; text: string }[] } | undefined>('texts', 'readonly', (s) => s.get(id)).catch(() => undefined);
  },
  async putText(id: string, value: { key: string; units: { label: string; text: string }[] }): Promise<void> {
    await tx('texts', 'readwrite', (s) => s.put(value, id)).catch(() => undefined);
  },
  async putFile(id: string, blob: Blob): Promise<void> {
    await tx('files', 'readwrite', (s) => s.put(blob, id));
  },
  async getFile(id: string): Promise<Blob | undefined> {
    const stored = await tx<Blob | undefined>('files', 'readonly', (s) => s.get(id));
    if (stored) return stored;
    // Linked books are read from where they live, through the platform bridge.
    const book = await this.getBook(id);
    if (!book?.source) return undefined;
    return readLinked(book.source, book.fileName, book.mime);
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
  async deleteMeta(key: string): Promise<void> {
    await tx('meta', 'readwrite', (s) => s.delete(key)).catch(() => undefined);
  },
  async clearAll(): Promise<void> {
    await tx('books', 'readwrite', (s) => s.clear());
    await tx('files', 'readwrite', (s) => s.clear());
    await tx('texts', 'readwrite', (s) => s.clear()).catch(() => undefined);
  },
};

export function uid(): string {
  return (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 20);
}
