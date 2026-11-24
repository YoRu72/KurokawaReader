// The goal for the year (src/ui/stats.ts): the books finished this year, counted from the app's own finished mark —
// the date the reader marked a book done, or, for a book read to its end and never marked, when it was last opened.
// A book is counted once, in the year of its mark (a book marked done again keeps one date: the latest).
import type { Book } from './db';

/** When the book was finished (none: it is not, or no date can be told). */
export function finishedAt(b: Pick<Book, 'done' | 'doneAt' | 'progress' | 'lastOpenedAt' | 'format'>): number | undefined {
  if (b.format === 'series') return undefined;
  if (b.done === true) return b.doneAt ?? b.lastOpenedAt;
  if (b.done === undefined && (b.progress?.pct ?? 0) >= 0.98) return b.lastOpenedAt;
  return undefined;
}
/** The books finished in `year`, the latest first. */
export function finishedIn<T extends Pick<Book, 'done' | 'doneAt' | 'progress' | 'lastOpenedAt' | 'format'>>(books: T[], year: number): { book: T; at: number }[] {
  const out: { book: T; at: number }[] = [];
  for (const book of books) { const at = finishedAt(book); if (at !== undefined && new Date(at).getFullYear() === year) out.push({ book, at }); }
  return out.sort((a, b) => b.at - a.at);
}
/** How many books a month still reach the goal: from this month to the year's end (this month counted), one decimal
 *  rounded up; 0 once it is reached. */
export function perMonth(done: number, goal: number, now: Date): number {
  const left = Math.max(0, goal - done); if (!left) return 0;
  const months = 12 - now.getMonth();
  return Math.ceil((left / months) * 10 - 1e-9) / 10;
}
