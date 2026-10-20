// Library operations: importing files, listing, deleting, progress.
import { db, uid, type Book } from './db';
import { readMeta, sniffFormat } from './formats';

export async function importFiles(files: FileList | File[], onEach?: (book: Book | null, file: File, error?: unknown) => void): Promise<Book[]> {
  const out: Book[] = [];
  for (const file of Array.from(files)) {
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
        cover: meta.cover,
        pageCount: meta.pageCount,
        bookmarks: [],
        highlights: [],
      };
      await db.putFile(book.id, file);
      await db.putBook(book);
      out.push(book);
      onEach?.(book, file);
    } catch (err) {
      onEach?.(null, file, err);
    }
  }
  return out;
}

export async function listBooks(): Promise<Book[]> {
  return db.allBooks();
}

export async function removeBooks(ids: string[]): Promise<void> {
  for (const id of ids) await db.deleteBook(id);
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
