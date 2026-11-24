// Details of several books at once (the library's selection bar → «Edit details», src/ui/bulkdetails.ts): one author
// and one series (with each volume's number) set on all of them, or only where the author is missing. What each book
// carried is kept first, so «Undo» puts every book back as it was. The author goes through src/booktitles.ts setAuthor
// (the file's own author kept in `origAuthor`: still searchable, restorable); the series is Book.series (src/series.ts).
import { db, stampAfter, type Book } from './db';
import { setAuthor } from './booktitles';
import { partOf, seriesOf } from './series';

export interface BulkInput {
  /** The author to set (empty: leave the authors alone). */
  author: string;
  /** Set it only on the books that have none. */
  onlyNoAuthor: boolean;
  /** The series name to set (empty: leave the series alone, unless the books share one and `byOrder` renumbers it). */
  series: string;
  /** Number the volumes in the order the books were chosen; else by the number each title carries. */
  byOrder: boolean;
  /** Take the books out of the series they were put in. */
  removeSeries: boolean;
}
/** What a book carried before: put back by `restore`. */
export interface Snap { id: string; author?: string; origAuthor?: string | null; namesAt?: number; series?: Book['series']; touched: boolean }
export interface BulkResult { snaps: Snap[]; changed: number; renamed: { id: string; from: string; to: string }[] }

const one = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** What a field holds across the books: its value when they agree, `null` when none has one, 'several' otherwise. */
export function commonOf(values: (string | undefined)[]): string | null | 'several' {
  const set = new Set(values.map((v) => one(v ?? '')));
  if (set.size === 1) return [...set][0] || null;
  return 'several';
}
/** The series name the books share now (none: they do not share one, or have none). */
export function commonSeries(books: Book[]): string | null {
  const names = books.map((b) => partOf(b)?.name ?? '');
  const c = commonOf(names);
  return c && c !== 'several' ? c : null;
}
/** The volume number each book would get, in the order given. By title: the number its title carries, else the one it
 *  already has; none (undefined) when it has neither. */
export function volumeNumbers(books: Book[], byOrder: boolean): (number | undefined)[] {
  return books.map((b, i) => byOrder ? i + 1 : (seriesOf(b.title)?.index ?? b.series?.index ?? undefined));
}
/** The series name that applies: the one typed, else — numbering in order — the one the books share. */
export function effectiveSeries(books: Book[], input: Pick<BulkInput, 'series' | 'byOrder' | 'removeSeries'>): string {
  if (input.removeSeries) return '';
  const typed = one(input.series); if (typed) return typed;
  return input.byOrder ? commonSeries(books) ?? '' : '';
}
/** Whether applying `input` would change anything for these books. */
export function hasWork(books: Book[], input: BulkInput): boolean {
  if (input.removeSeries) return books.some((b) => !!b.series);
  if (one(input.author) && books.some((b) => (!input.onlyNoAuthor || !b.author) && one(input.author) !== (b.author ?? ''))) return true;
  const name = effectiveSeries(books, input); if (!name) return false;
  const vol = volumeNumbers(books, input.byOrder);
  return books.some((b, i) => JSON.stringify(nextSeries(b.series, name, vol[i])) !== JSON.stringify(b.series));
}
/** The series record a book gets: the number given, else the one it had in this series; where it came from kept while
 *  the name stays the same. */
function nextSeries(prev: Book['series'], name: string, index: number | undefined): NonNullable<Book['series']> {
  const same = prev?.name === name;
  const out: NonNullable<Book['series']> = { name };
  const idx = index ?? (same ? prev?.index : undefined);
  if (idx !== undefined) out.index = idx;
  if (same && prev?.source !== undefined) out.source = prev.source;
  if (same && prev?.shelf !== undefined) out.shelf = prev.shelf;
  return out;
}

const view = (b: Book) => JSON.stringify([b.author ?? null, b.origAuthor ?? null, b.series ?? null]);

/** Applies `input` to the books `ids` (in the order they were chosen). Each book is read, changed and written in one
 *  transaction; what each carried is returned for `restore`. A glossary folder named after the series they had follows a
 *  new series name (only when the folder is used by these books alone). */
export async function applyBulk(ids: string[], input: BulkInput): Promise<BulkResult> {
  const au = one(input.author);
  const books = (await Promise.all(ids.map((id) => db.getBook(id)))).filter((b): b is Book => !!b);
  const name = effectiveSeries(books, input);
  const vol = volumeNumbers(books, input.byOrder);
  const snaps: Snap[] = []; let changed = 0;
  const was: { id: string; names: string[] }[] = [];
  const glossary = name ? await import('./glossary') : null;
  for (const b of books) { const old = partOf(b)?.name; if (name && old && old !== name) was.push({ id: b.id, names: [...new Set([old, glossary!.seriesOf(b.title)])] }); }
  for (let i = 0; i < books.length; i++) {
    const id = books[i].id; const hold: { snap?: Snap; before: string; after: string } = { before: '', after: '' };
    await db.updateBook(id, (b) => {
      hold.before = view(b);
      const snap: Snap = { id, author: b.author, origAuthor: b.origAuthor, namesAt: b.namesAt, series: b.series ? { ...b.series } : undefined, touched: false };
      hold.snap = snap;
      if (au && (!input.onlyNoAuthor || !b.author) && au !== (b.author ?? '')) { setAuthor(b, au); snap.touched = true; }
      if (input.removeSeries) delete b.series;
      else if (name) { const next = nextSeries(b.series, name, vol[i]); if (JSON.stringify(next) !== JSON.stringify(b.series)) b.series = next; }
      hold.after = view(b);
    });
    if (hold.snap) { snaps.push(hold.snap); if (hold.before !== hold.after) changed++; }
  }
  const renamed = name && was.length ? glossary!.followSeries(was, name) : [];
  return { snaps, changed, renamed };
}

/** Puts every book back as `snaps` say (the author and its original, the series). The names' stamp is made later than
 *  the change's, so another device that took the change takes the undoing too. */
export async function restore(snaps: Snap[], renamed: BulkResult['renamed'] = []): Promise<void> {
  for (const s of snaps) {
    await db.updateBook(s.id, (b) => {
      if (s.author === undefined) delete b.author; else b.author = s.author;
      if (s.origAuthor === undefined) delete b.origAuthor; else b.origAuthor = s.origAuthor;
      if (s.series === undefined) delete b.series; else b.series = { ...s.series };
      if (s.touched) b.namesAt = stampAfter(b.namesAt);
    });
  }
  if (renamed.length) (await import('./glossary')).unfollowSeries(renamed);
}
