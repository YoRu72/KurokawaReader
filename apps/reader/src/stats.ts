// Reading statistics: time spent with a book open and visible, words passed,
// pages, sessions, per-day history. Drives "Book information" and the library
// statistics sheet (hours, speed, history, time left, daily goal).
import { db, type Book, type ReadingStats, type ReadingDay, type StatsPart } from './db';
import { getSettings } from './settings';

const TICK_MS = 5000;
const SAVE_MS = 30000;
/** A gap longer than this starts a new reading session. */
const SESSION_GAP_MS = 30 * 60000;
const WORDS_PER_PAGE = 300;

/** Is the character at code `c` part of a word? Letters and digits of every script are; whitespace, ASCII
 *  symbols and the common punctuation blocks (Latin-1, general, CJK, Arabic, full-width) are not. Told apart
 *  by ranges rather than Unicode property lookups: a big book has millions of characters to go through. */
function isWordChar(c: number): boolean {
  if (c < 0x80) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  if (c < 0xC0) return c === 0xAA || c === 0xB5 || c === 0xBA || c === 0xB2 || c === 0xB3 || c === 0xB9;
  if (c === 0xD7 || c === 0xF7) return false;
  if (c >= 0x0300 && c <= 0x036F) return true;                                   // combining marks stay in the word
  if (c >= 0x064B && c <= 0x065F) return true;                                   // Arabic marks (harakat, shadda) too
  if (c === 0x060C || c === 0x061B || c === 0x061F || c === 0x06D4 || (c >= 0x066A && c <= 0x066D) || c === 0x0600 || c === 0x061E) return false;
  if (c >= 0x2000 && c <= 0x206F) return false;                                  // general punctuation
  if (c >= 0x2190 && c <= 0x2BFF) return false;                                  // arrows, maths, box drawing, dingbats
  if (c >= 0x2E00 && c <= 0x2E7F) return false;
  if (c >= 0x3000 && c <= 0x303F) return false;                                  // CJK punctuation
  if ((c >= 0xFF00 && c <= 0xFF0F) || (c >= 0xFF1A && c <= 0xFF20) || (c >= 0xFF3B && c <= 0xFF40) || (c >= 0xFF5B && c <= 0xFF65)) return false;
  return true;
}
/** Words and non-blank characters of `text`. A word is a run of word characters; an apostrophe or a tatweel
 *  between two of them keeps the run one word (it's, don’t, مـحـمد). A run of CJK characters counts as one. */
export function countWordsAndChars(text: string): [number, number] {
  let words = 0, chars = 0, inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0x3000 || c === 0x2028 || c === 0x2029) { inWord = false; continue; }
    chars++;
    if (isWordChar(c)) { if (!inWord) { words++; inWord = true; } }
    else if (inWord && (c === 0x27 || c === 0x2019 || c === 0x0640) && i + 1 < text.length && isWordChar(text.charCodeAt(i + 1))) { /* still the same word */ }
    else inWord = false;
  }
  return [words, chars];
}
export function countWords(text: string): number { return countWordsAndChars(text)[0]; }

export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

/** Statistics of books being read right now, so the library is current before the next save. */
const liveStats = new Map<string, ReadingStats>();
export function liveStatsOf(id: string): ReadingStats | undefined {
  return liveStats.get(id);
}

export class ReadingTracker {
  private stats: ReadingStats;
  /** The counters as last saved: a save adds what was read since to what is kept (which a sync may have changed). */
  private saved: StatsPart;
  private timer: number | undefined;
  private saveTimer: number | undefined;
  private lastTick = 0;
  private pendingWords = 0;
  private pendingPages = 0;
  private lastPct = 0;
  private totalPages = 0;
  private dirty = false;

  constructor(private book: Book, private isActive: () => boolean, bookWords?: number, bookChars?: number) {
    this.stats = book.stats ?? { ms: 0, words: 0, days: {} };
    this.saved = partOf(this.stats);
    if (bookWords != null) this.stats.bookWords = bookWords;
    if (bookChars != null) this.stats.bookChars = bookChars;
    this.totalPages = book.pageCount ?? (this.stats.bookWords ? Math.max(1, Math.round(this.stats.bookWords / WORDS_PER_PAGE)) : 0);
    this.lastPct = book.progress?.pct ?? 0;
  }

  /** The book's size, counted after it is open (a big book's words take a while to count). */
  setTotals(bookWords: number, bookChars: number): void {
    this.stats.bookWords = bookWords; this.stats.bookChars = bookChars;
    this.totalPages = this.book.pageCount ?? Math.max(1, Math.round(bookWords / WORDS_PER_PAGE));
  }

  start(): void {
    // (Incognito: no time or words counted.)
    if (getSettings().incognito) return;
    this.ensureSession();
    liveStats.set(this.book.id, this.stats);
    this.lastTick = performance.now();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.saveTimer = window.setInterval(() => void this.save(), SAVE_MS);
    document.addEventListener('visibilitychange', this.onVis);
  }

  private onVis = () => { this.lastTick = performance.now(); };

  /** Count a session when reading resumes after a long pause (or on the first tick). */
  private ensureSession(): void {
    const now = Date.now();
    if (!this.stats.sessionAt || now - this.stats.sessionAt > SESSION_GAP_MS) {
      this.stats.sessions = (this.stats.sessions ?? 0) + 1;
      const d = this.stats.days[todayKey()] ?? { ms: 0, pct: this.lastPct, words: 0 };
      d.sessions = (d.sessions ?? 0) + 1;
      this.stats.days[todayKey()] = d;
      this.dirty = true;
    }
    this.stats.sessionAt = now;
  }

  private tick(): void {
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    if (document.visibilityState !== 'visible' || !this.isActive() || dt > 60000) return;
    this.ensureSession();
    const d = this.stats.days[todayKey()] ?? { ms: 0, pct: this.lastPct, words: 0 };
    d.ms += dt; this.stats.ms += dt;
    d.words += this.pendingWords; this.stats.words += this.pendingWords; this.pendingWords = 0;
    if (this.pendingPages > 0) {
      d.pages = (d.pages ?? 0) + this.pendingPages; this.stats.pages = (this.stats.pages ?? 0) + this.pendingPages; this.pendingPages = 0;
    }
    d.pct = Math.max(d.pct, this.lastPct);
    this.stats.days[todayKey()] = d;
    this.dirty = true;
    liveStats.set(this.book.id, this.stats);
  }

  /** Report words the reader scrolled past, and the new progress fraction. */
  advance(words: number, pct: number): void {
    if (words > 0) this.pendingWords += words;
    // Pages only follow steady progress — a jump from the table of contents is not reading.
    if (this.totalPages > 0 && pct > this.lastPct && pct - this.lastPct <= 0.1) this.pendingPages += (pct - this.lastPct) * this.totalPages;
    this.lastPct = Math.max(this.lastPct, pct);
  }

  get current(): ReadingStats { return this.stats; }

  /** Words per minute over all recorded time (null until there is enough data). */
  speed(): number | null {
    const min = this.stats.ms / 60000;
    if (min < 0.5 || this.stats.words < 50) return null;
    return Math.round(this.stats.words / min);
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.book.stats = this.stats;
    liveStats.set(this.book.id, this.stats);
    // (What was read since the last save, added to what is kept — not the whole written over it: a sync in between
    // may have added another device's reading, and this device's own part is counted apart for the next one.)
    const snap = partOf(this.stats); const delta = combineStats(snap, this.saved, 'sub');
    const { sessionAt, bookWords, bookChars } = this.stats;
    const kept = await db.updateBook(this.book.id, (b) => {
      const next = withCounters(b.stats, combineStats(b.stats, delta, 'add'));
      next.sessionAt = Math.max(next.sessionAt ?? 0, sessionAt ?? 0) || undefined;
      if (bookWords != null) next.bookWords = bookWords;
      if (bookChars != null) next.bookChars = bookChars;
      b.stats = next;
      if (b.statsSync) b.statsSync.own = combineStats(b.statsSync.own, delta, 'add');
    });
    if (!kept?.stats) return;
    // (Ticks counted while it was being written are kept on top.)
    const extra = combineStats(partOf(this.stats), snap, 'sub');
    this.saved = partOf(kept.stats);
    this.stats = withCounters({ ...kept.stats, sessionAt: this.stats.sessionAt }, combineStats(kept.stats, extra, 'add'));
    this.book.stats = this.stats;
    liveStats.set(this.book.id, this.stats);
  }

  async stop(): Promise<void> {
    // (Never started — incognito: nothing counted. A last tick from lastTick 0 counted the whole page's age.)
    if (this.timer === undefined) return;
    window.clearInterval(this.timer); window.clearInterval(this.saveTimer);
    document.removeEventListener('visibilitychange', this.onVis);
    this.tick();
    await this.save();
  }
}
