// Undo for what is kept in a book's lists — bookmarks, highlights, PDF highlights, PDF page notes — and for a note's
// text. A thing taken out is tombstoned at once (src/sync.ts markDeleted) and comes back under a new id; a note
// cleared comes back as a later edit (stampAfter). Why: src/ui/undo.ts.
import { db, uid, stampAfter, type Book } from './db';
import { markDeleted, scheduleSync } from './sync';
import { offerUndo } from './ui/undo';

type ListKind = 'bookmarks' | 'highlights' | 'pdfHighlights' | 'pins';
type Item = { id: string; createdAt: number };

/** Put an item back into a book's list under a new id; returns the book as stored, and the new id. */
export async function putBack(bookId: string, kind: ListKind, item: Item): Promise<{ book?: Book; id: string }> {
  const id = uid(); const again = { ...JSON.parse(JSON.stringify(item)), id };
  const book = await db.updateBook(bookId, (b) => { (b as unknown as Record<string, Item[]>)[kind] = [...(((b as unknown as Record<string, Item[] | undefined>)[kind]) ?? []), again]; });
  scheduleSync();
  return { book, id };
}
/** Take an item out of a book's list (tombstoned). */
export async function takeOut(bookId: string, kind: ListKind, id: string): Promise<Book | undefined> {
  void markDeleted(id);
  return db.updateBook(bookId, (b) => { (b as unknown as Record<string, Item[]>)[kind] = (((b as unknown as Record<string, Item[] | undefined>)[kind]) ?? []).filter((x) => x.id !== id); });
}

/** After an item was taken out of a book's list: the snackbar with Undo (and Redo). `shown(book)` redraws what shows
 *  it, with the book as now stored. */
export function offerPutBack(label: string, bookId: string, kind: ListKind, item: Item, shown: (book: Book | undefined) => void, alive?: () => boolean): void {
  let cur = item.id;
  offerUndo(label,
    async () => { const r = await putBack(bookId, kind, item); cur = r.id; shown(r.book); },
    async () => { shown(await takeOut(bookId, kind, cur)); },
    { alive });
}

/** After a note's text was cleared (a highlight's, a PDF highlight's): Undo writes it back as a newer edit. */
export function offerNoteBack(label: string, bookId: string, kind: 'highlights' | 'pdfHighlights', id: string, note: string, shown: (book: Book | undefined) => void, alive?: () => boolean): void {
  const write = async (v: string | undefined) => shown(await db.updateBook(bookId, (b) => { const x = ((b as unknown as Record<string, { id: string; note?: string; noteAt?: number }[] | undefined>)[kind] ?? []).find((y) => y.id === id); if (x) { x.note = v; x.noteAt = stampAfter(x.noteAt); } }));
  offerUndo(label, async () => { await write(note); scheduleSync(); }, async () => { await write(undefined); scheduleSync(); }, { alive });
}
