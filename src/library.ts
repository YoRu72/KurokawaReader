// Library operations: importing files, listing, deleting, progress.
import { db, uid, type Book, type FileSource } from './db';
import { forgetBookSettings } from './settings';

/** A File that knows where it came from, so it can be linked instead of copied. */
export type SourcedFile = File & { krSource?: FileSource };
import { readMeta, sniffFormat } from './formats';

export async function importFiles(files: FileList | File[], onEach?: (book: Book | null, file: File, error?: unknown) => void): Promise<Book[]> {
  const out: Book[] = [];
  const queue = Array.from(files);
  const worker = async () => { while (queue.length) await importOne(queue.shift()!); };
  // A few files at a time: metadata extraction (cover rendering, zip parsing) overlaps with storage writes.
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  return out;

  async function importOne(file: File): Promise<void> {
    try {
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

export async function removeBooks(ids: string[]): Promise<void> {
  for (const id of ids) await db.deleteBook(id);
  forgetBookSettings(ids);
}

export async function touchBook(id: string): Promise<void> {
  await db.updateBook(id, (b) => { b.lastOpenedAt = Date.now(); });
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
