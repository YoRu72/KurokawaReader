// What the library's first screen and sync read of the reading statistics (src/stats.ts keeps the rest — the tracker,
// the word counts —, loaded with a book or the statistics sheet): today's key, the counters of a book being read right
// now (ReadingTracker keeps them here), and the counters added and compared.
import type { ReadingStats, ReadingDay, StatsPart } from './db';

export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Statistics of books being read right now, so the library is current before the next save. */
export const liveStats = new Map<string, ReadingStats>();
export function liveStatsOf(id: string): ReadingStats | undefined {
  return liveStats.get(id);
}

/* ---------- counters, added and compared (sync keeps each device's apart: src/sync.ts) ---------- */
const COUNTERS = ['ms', 'words', 'pages', 'sessions'] as const;
export const emptyPart = (): StatsPart => ({ ms: 0, words: 0, days: {} });
/** The counters of `a` and `b` put together day by day: `add` (the sum), `max` (the larger), `sub` (a less b, not
 *  below 0). A day's `pct` (how far the book was that day) is the larger, or a's for `sub`. */
export function combineStats(a: StatsPart | undefined, b: StatsPart | undefined, op: 'add' | 'max' | 'sub'): StatsPart {
  const f = (x = 0, y = 0) => (op === 'add' ? x + y : op === 'max' ? Math.max(x, y) : Math.max(0, x - y));
  const out: StatsPart = { ms: 0, words: 0, days: {} };
  for (const k of COUNTERS) { const v = f(a?.[k], b?.[k]); if (v || k === 'ms' || k === 'words') out[k] = v; }
  const days = new Set([...Object.keys(a?.days ?? {}), ...Object.keys(b?.days ?? {})]);
  for (const d of days) {
    const x = a?.days?.[d], y = b?.days?.[d];
    if (op === 'sub' && !x) continue;
    const day: ReadingDay = { ms: f(x?.ms, y?.ms), words: f(x?.words, y?.words), pct: op === 'sub' ? x?.pct ?? 0 : Math.max(x?.pct ?? 0, y?.pct ?? 0) };
    for (const k of ['sessions', 'pages'] as const) { const v = f(x?.[k], y?.[k]); if (v) day[k] = v; }
    if (op === 'sub' && !day.ms && !day.words && !day.sessions && !day.pages && day.pct <= (y?.pct ?? 0)) continue;
    out.days[d] = day;
  }
  return out;
}
/** The counters of a book's statistics (a copy). */
export const partOf = (s?: StatsPart): StatsPart => combineStats(s, undefined, 'add');
/** Statistics with their counters replaced (the book's word counts and last session time kept). */
export const withCounters = (s: ReadingStats | undefined, part: StatsPart): ReadingStats => {
  const out: ReadingStats = { ...(s ?? { ms: 0, words: 0, days: {} }) };
  delete out.pages; delete out.sessions;
  return Object.assign(out, part);
};
