// Searching the notes page (src/views/notes.ts): every bookmark, note and page note of every book, found by what was
// highlighted, what was written, the book's shown and other titles and its author, and the name a bookmark carries for
// its chapter — folded as the glossary's search folds (src/glossary.ts foldKey: case, width, Arabic marks and hamza
// forms, katakana as hiragana, spaces and punctuation loosened). The text of each entry is folded ONCE (`buildIndex`);
// a query is then only a substring test per entry (`filterIndex`: milliseconds for thousands of notes).
import type { Book } from './db';
import { foldKey, foldMap } from './glossary';
import { titlesOf } from './booktitles';

/** What an entry is: a bookmark, a highlight's note, a PDF highlight's note, a pin on a PDF page. */
export type EntryKind = 'bm' | 'hl' | 'pdf' | 'pin';
export interface Entry {
  kind: EntryKind; id: string; createdAt: number;
  /** the highlighted text · the bookmark's chapter name */
  text: string;
  /** the note written · the bookmark's excerpt */
  note: string;
  /** both, folded, with the chapter name */
  key: string;
}
export interface BookEntries { book: Book; /** titles and author, folded */ head: string; entries: Entry[] }

/** Whether the filter chip («Bookmarks», «Notes») lets this kind through. */
export const inGroup = (kind: EntryKind, group: 'all' | 'bookmarks' | 'notes'): boolean => group === 'all' || (group === 'bookmarks') === (kind === 'bm');

/** The entries of the books that have any (the same ones the page lists), each folded once. */
export function buildIndex(books: Book[]): BookEntries[] {
  const out: BookEntries[] = [];
  for (const book of books) {
    const entries: Entry[] = [];
    const add = (kind: EntryKind, id: string, createdAt: number, text: string, note: string) => entries.push({ kind, id, createdAt, text, note, key: foldKey(`${text} ${note}`, true) });
    for (const x of book.bookmarks) add('bm', x.id, x.createdAt, x.label ?? '', x.excerpt ?? '');
    for (const x of book.highlights) if (x.note) add('hl', x.id, x.createdAt, x.text, x.note);
    for (const x of book.pdfHighlights ?? []) if (x.note) add('pdf', x.id, x.createdAt, x.text, x.note);
    for (const x of book.pins ?? []) add('pin', x.id, x.createdAt, '', x.note);
    if (!entries.length) continue;
    out.push({ book, head: foldKey(`${titlesOf(book).join(' ')} ${book.origTitle ?? ''} ${book.author ?? ''} ${book.origAuthor ?? ''}`, true), entries });
  }
  return out;
}

/** The books' entries matching `q` (folded as `foldKey(q, true)`) through the chip `group`: for each book that has any,
 *  the ids matching; a query found in the book's titles or author lets all of the book's entries through. Without a
 *  query: every entry of the group. */
export function filterIndex(ix: BookEntries[], q: string, group: 'all' | 'bookmarks' | 'notes'): Map<string, Set<string>> {
  const qf = q ? foldKey(q, true) : '';
  const out = new Map<string, Set<string>>();
  for (const b of ix) {
    const viaBook = !!qf && b.head.includes(qf); const ids = new Set<string>();
    for (const e of b.entries) if (inGroup(e.kind, group) && (!qf || viaBook || e.key.includes(qf))) ids.add(e.id);
    if (ids.size) out.set(b.book.id, ids);
  }
  return out;
}

/** `text` with the part matching `qf` marked. */
export function marked(text: string, qf: string, mark: (s: string) => Node): (string | Node)[] {
  if (!qf) return [text];
  const m = foldMap(text); const i = m.f.indexOf(qf); if (i < 0) return [text];
  const a = m.from[i], b = m.to[i + qf.length - 1];
  return [text.slice(0, a), mark(text.slice(a, b)), text.slice(b)];
}
/** Where in `text` the folded query `qf` is found (-1: not). */
export function matchStart(text: string, qf: string): number { if (!qf) return -1; const m = foldMap(text); const i = m.f.indexOf(qf); return i < 0 ? -1 : m.from[i]; }
/** The other titles of a book (not the shown one) that hold the query: shown on a line of their own. */
export function otherTitleHits(book: Book, qf: string): string[] {
  if (!qf) return [];
  const shown = foldKey(book.title, true); if (shown.includes(qf)) return [];
  const all = [...titlesOf(book).slice(1), ...(book.origTitle && book.origTitle !== book.title ? [book.origTitle] : [])];
  return [...new Set(all)].filter((x) => foldKey(x, true).includes(qf));
}
export { foldKey };
