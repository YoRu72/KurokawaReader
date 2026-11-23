// A book's names are the reader's to set: the shown title (Book.title, always the first of `titles`), the other
// titles kept beside it, and the author. What the file itself carried stays in `origTitle` / `origAuthor`, so
// «back to the book's own» always works. Everything that shows Book.title or Book.author shows these.
import type { Book } from './db';
import { stampAfter, db as dbRef } from './db';
import { searchFormOf } from './formats/types';

type Names = Pick<Book, 'title' | 'titles' | 'origTitle' | 'author' | 'origAuthor' | 'namesAt'>;

/** The book's titles, the shown one first (an old record has only `title`). */
export function titlesOf(b: Pick<Book, 'title' | 'titles'>): string[] {
  const out: string[] = [];
  for (const x of [b.title, ...(b.titles ?? [])]) { const s = (x ?? '').trim(); if (s && !out.includes(s)) out.push(s); }
  return out;
}
/** The titles beside the shown one. */
export const otherTitles = (b: Pick<Book, 'title' | 'titles'>): string[] => titlesOf(b).slice(1);
/** The title the file came with. */
export const origTitleOf = (b: Pick<Book, 'title' | 'origTitle'>): string => b.origTitle ?? b.title;
/** The author the file came with (none: it had none). */
export const origAuthorOf = (b: Pick<Book, 'author' | 'origAuthor'>): string | undefined => (b.origAuthor === undefined ? b.author : b.origAuthor ?? undefined);
export const titleChanged = (b: Pick<Book, 'title' | 'origTitle'>): boolean => b.origTitle !== undefined && b.origTitle !== b.title;
export const authorChanged = (b: Pick<Book, 'author' | 'origAuthor'>): boolean => b.origAuthor !== undefined && (b.origAuthor ?? '') !== (b.author ?? '');

const clean = (list: string[]): string[] => { const out: string[] = []; for (const x of list) { const s = x.replace(/\s+/g, ' ').trim(); if (s && !out.includes(s)) out.push(s); } return out; };

/** Keeps what the file carried before the first change. */
function remember(b: Names): void { if (b.origTitle === undefined) b.origTitle = b.title; if (b.origAuthor === undefined) b.origAuthor = b.author ?? null; }

/** The whole list set (the first is shown). An empty list leaves the book as it was. */
export function setTitles(b: Names, list: string[]): void {
  const l = clean(list); if (!l.length) return;
  remember(b);
  b.title = l[0]; if (l.length > 1) b.titles = l; else delete b.titles;
  b.namesAt = stampAfter(b.namesAt);
}
/** A new shown title; the former one kept among the others when `keepOld`. */
export function renameTo(b: Names, title: string, keepOld: boolean): void {
  const t = title.replace(/\s+/g, ' ').trim(); if (!t) return;
  const all = titlesOf(b); const old = b.title;
  setTitles(b, [t, ...(keepOld ? [old] : []), ...all.slice(1)]);
}
/** One of the other titles made the shown one (the former shown one stays among the others). */
export function showTitle(b: Names, title: string): void { setTitles(b, [title, ...titlesOf(b).filter((x) => x !== title)]); }
/** The book's own title shown again; the others stay as they were (the one it replaced among them). */
export function restoreTitle(b: Names): void {
  if (b.origTitle === undefined) return;
  const o = b.origTitle; setTitles(b, [o, ...titlesOf(b).filter((x) => x !== o)]);
}
/** The author set (empty: none). */
export function setAuthor(b: Names, author: string): void {
  remember(b);
  const a = author.replace(/\s+/g, ' ').trim(); if (a) b.author = a; else delete b.author;
  b.namesAt = stampAfter(b.namesAt);
}
export function restoreAuthor(b: Names): void {
  if (b.origAuthor === undefined) return;
  if (b.origAuthor) b.author = b.origAuthor; else delete b.author;
  b.namesAt = stampAfter(b.namesAt);
}

/** What a book is searched by: every title, the file's own title, the author, the file's own author — folded. */
export function nameKeys(b: Book): { titles: string[]; extra: string } {
  const all = titlesOf(b); const o = origTitleOf(b); if (o && !all.includes(o)) all.push(o);
  return { titles: all, extra: [b.author, origAuthorOf(b)].filter(Boolean).join(' ') };
}
export function namesSearchForm(b: Book): string { const k = nameKeys(b); return searchFormOf(`${k.titles.join(' ')} ${k.extra}`); }
/** The title (not the shown one) through which a search matched: every word found in it, the shown title and the
 *  author not being enough alone. */
export function matchedOther(b: Book, words: string[]): string | null {
  if (!words.length) return null;
  const shown = searchFormOf(`${b.title} ${b.author ?? ''}`);
  if (words.every((w) => shown.includes(w))) return null;
  const k = nameKeys(b);
  for (const t of k.titles.slice(1)) { const f = searchFormOf(`${t} ${b.title} ${b.author ?? ''}`); if (words.every((w) => f.includes(w)) && words.some((w) => searchFormOf(t).includes(w))) return t; }
  return null;
}

/** The fields that travel (sync, backup). */
export interface NamesRecord { titles?: string[]; origTitle?: string; author?: string; origAuthor?: string | null; namesAt?: number }
export const namesOf = (b: Book): NamesRecord => ({ titles: b.titles, origTitle: b.origTitle, author: b.author, origAuthor: b.origAuthor, namesAt: b.namesAt });
/** Takes a record's names when it is the later (or this book has none set). Returns whether anything changed. */
export function takeNames(b: Book, r: NamesRecord & { title?: string }): boolean {
  if (r.namesAt === undefined || r.namesAt <= (b.namesAt ?? 0)) return false;
  if (r.title) b.title = r.title;
  if (r.titles?.length) b.titles = r.titles; else delete b.titles;
  if (r.origTitle !== undefined) b.origTitle = r.origTitle;
  if (r.origAuthor !== undefined) b.origAuthor = r.origAuthor;
  if (r.author) b.author = r.author; else delete b.author;
  b.namesAt = r.namesAt;
  return true;
}

/** The «Text as image» card's lines for a book: `opts` is what the card is drawn from (its title and author are
 *  changed as the reader types); the author is kept with the book, the title made the book's on request. */
export function snapNames(book: Book, opts: { title: string; author?: string }): import('./ui/textcard').SnapNames {
  const { db } = deps();
  return {
    title: book.title, author: book.author ?? '',
    change(t, a) { opts.title = t; opts.author = a || undefined; },
    async remember(a) { const out = await db.updateBook(book.id, (b) => { if (a !== (b.author ?? '')) setAuthor(b, a); }); if (out) { book.author = out.author; book.origAuthor = out.origAuthor; book.namesAt = out.namesAt; } void import('./sync').then((m) => m.scheduleSync()).catch(() => undefined); },
    async useTitle(v) { const was = book.title; const out = await db.updateBook(book.id, (b) => renameTo(b, v, true)); if (out) { book.title = out.title; book.titles = out.titles; book.origTitle = out.origTitle; book.namesAt = out.namesAt; void import('./glossary').then((g) => g.followRename(book.id, was, out.title)); } void import('./sync').then((m) => m.scheduleSync()).catch(() => undefined); },
  };
}
function deps() { return { db: dbRef }; }
