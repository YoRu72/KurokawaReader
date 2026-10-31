// What is on its way into the library, for the library to show as it comes: a file being downloaded (a card of
// its own, dimmed, until the book is there) and a novel's chapters being fetched (its card dimmed under the
// progress until they are all here).

export interface Busy {
  key: string;
  title: string;
  /** 0–100; -1 while the size is not known yet. */
  pct: number;
  /** The library's book it is for, when it is already there (a novel, a file fetched again). */
  bookId?: string;
}

const items = new Map<string, Busy>();
const subs = new Set<() => void>();
let raf = 0;
const tell = () => {
  if (raf) return;
  const run = () => { raf = 0; for (const fn of subs) { try { fn(); } catch { /* a view gone */ } } };
  raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
};

export function setBusy(b: Busy): void {
  const had = items.get(b.key);
  if (had && had.pct === b.pct && had.title === b.title && had.bookId === b.bookId) return;
  items.set(b.key, b); tell();
}
export function clearBusy(key: string): void { if (items.delete(key)) tell(); }
export const busyNow = (): Busy[] => [...items.values()];
/** Told (at most once a frame) when anything on its way moves; returns the way to stop being told. */
export function onBusy(fn: () => void): () => void { subs.add(fn); return () => subs.delete(fn); }
