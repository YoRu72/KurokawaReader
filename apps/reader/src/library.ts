// Library operations: importing files, listing, deleting, progress.
import { db, uid, type Book, type FileSource } from './db';
import { forgetBookSettings, getSettings } from './settings';

/** A File that knows where it came from, so it can be linked instead of copied. */
export type SourcedFile = File & { krSource?: FileSource };

export async function importFiles(files: FileList | File[], onEach?: (book: Book | null, file: File, error?: unknown) => void): Promise<Book[]> {
  const out: Book[] = [];
  const queue = Array.from(files);
  const worker = async () => { while (queue.length) await importOne(queue.shift()!); };
  // A few files at a time: metadata extraction (cover rendering, zip parsing) overlaps with storage writes.
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  return out;

  async function importOne(file: File): Promise<void> {
    try {
      const { readMeta, sniffFormat } = await import('./formats');
      const format = await sniffFormat(file, file.name);
      const meta = await readMeta(file, file.name, format);
      const book: Book = {
        id: uid(),
        title: meta.title,
        author: meta.author,
        language: meta.language,
        format,
        fileName: file.name,
        mime: file.type || undefined,
        size: file.size,
        addedAt: Date.now(),
        cover: await shrinkCover(meta.cover),
        pageCount: meta.pageCount,
        bookmarks: [],
        highlights: [],
      };
      const src = (file as SourcedFile).krSource;
      if (src) book.source = src; else await db.putFile(book.id, file);
      await db.putBook(book);
      out.push(book);
      onEach?.(book, file);
    } catch (err) {
      onEach?.(null, file, err);
    }
  }
}

/** Share a book's file (one at a time through the system sheet; the first when several are picked on platforms that take one). */
export async function shareBooks(ids: string[]): Promise<void> {
  const { shareFile } = await import('./ui/share');
  for (const id of ids) {
    const book = await db.getBook(id); if (!book) continue;
    const file = await db.getFile(id); if (!file) continue;
    await shareFile(file, book.fileName || `${book.title}.${book.format}`, book.title);
  }
}

export async function listBooks(): Promise<Book[]> {
  return db.allBooks();
}

/** Every meta key a book's own data is kept under, as `<kind>:<book id>` (translations, the whole-book mark, the
 *  translator kept on, names scanned for, PDF crop boxes, Anki progress, audiobook place and chapters). A new
 *  kind of per-book data is added HERE, so deleting a book takes it and the clean-up below finds it. */
export const BOOK_META = ['tr', 'trs', 'trWhole', 'trKeep', 'glossScan', 'crop', 'anki', 'audio', 'audioch'] as const;

export async function removeBooks(ids: string[]): Promise<void> {
  for (const id of ids) await db.deleteBook(id);
  await forgetBookData(ids);
}
/** All a book keeps besides its record, file and text (db.deleteBook): its meta, its own settings, its glossary
 *  terms, folder links and destination, its text rules, its place in the reading queue. (Keys matched whole —
 *  `tr:12` is not `tr:123` — and a glossary folder's or every book's terms kept: other books use them.) */
export async function forgetBookData(ids: string[]): Promise<void> {
  if (!ids.length) return;
  for (const id of ids) for (const k of BOOK_META) await db.deleteMeta(`${k}:${id}`);
  forgetBookSettings(ids);
  const [g, r, q] = await Promise.all([import('./glossary'), import('./textrules'), import('./ui/queue')]);
  g.forgetBooks(ids); r.forgetBooks(ids);
  const gone = new Set(ids); const queue = q.getQueue(); if (queue.some((x) => gone.has(x))) q.setQueue(queue.filter((x) => !gone.has(x)));
}
/** Once: what deletions made before this clean-up existed left behind (a book's meta and own settings, for books no longer here).
 *  Only keys certainly a book's; glossary terms and text rules the reader wrote are left alone. */
export async function cleanOrphans(): Promise<number> {
  const have = new Set((await db.allBooks()).map((b) => b.id)); let n = 0;
  const kinds = new Set<string>(BOOK_META);
  for (const key of await db.metaKeys()) {
    const i = key.indexOf(':'); if (i < 1 || !kinds.has(key.slice(0, i))) continue;
    const id = key.slice(i + 1); if (id && !have.has(id)) { await db.deleteMeta(key); n++; }
  }
  const dead: string[] = [];
  try { for (const k of ['kr.bookVisual', 'kr.glossaryLinks', 'kr.glossaryDest']) for (const id of Object.keys(JSON.parse(localStorage.getItem(k) ?? '{}') as object)) if (id !== '*' && !have.has(id)) dead.push(id); } catch { /* unreadable: left */ }
  if (dead.length) { forgetBookSettings(dead); (await import('./glossary')).forgetBooks(dead); n += dead.length; }
  return n;
}
export async function cleanOrphansOnce(): Promise<void> {
  try { if (localStorage.getItem('kr.orphansCleaned')) return; await cleanOrphans(); localStorage.setItem('kr.orphansCleaned', '1'); } catch { /* next start */ }
}

export async function touchBook(id: string): Promise<void> {
  // (Opening a novel is seeing its new chapters: the mark on it goes.)
  // (Incognito: the book is not put in the history.)
  const quiet = getSettings().incognito;
  await db.updateBook(id, (b) => { if (!quiet) b.lastOpenedAt = Date.now(); if (b.remote?.newChapters) b.remote.newChapters = 0; });
}

let coverUrls = new Map<string, string>();
export function coverUrl(book: Book): string | null {
  if (!book.cover) return null;
  let u = coverUrls.get(book.id);
  if (!u) { u = URL.createObjectURL(book.cover); coverUrls.set(book.id, u); }
  return u;
}
export function forgetCover(id: string): void {
  const u = coverUrls.get(id);
  if (u) { URL.revokeObjectURL(u); coverUrls.delete(id); }
}

/** Covers are shown at card size; a 3000-px publisher cover is wasted storage. */
export async function shrinkCover(cover?: Blob): Promise<Blob | undefined> {
  if (!cover || cover.size < 150_000) return cover;
  try {
    const bmp = await createImageBitmap(cover);
    const scale = Math.min(1, 720 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && cover.size < 400_000) return cover;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.84));
    return out && out.size < cover.size ? out : cover;
  } catch { return cover; }
}
