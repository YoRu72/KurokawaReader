// Reading statistics: time spent with a book open and visible, words passed,
// pages, sessions, per-day history. Drives "Book information" and the library
// statistics sheet (hours, speed, history, time left, daily goal).
import { db, type Book, type ReadingStats } from './db';
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

/** Statistics of books being read right now, so the library is current before the next save. */
const liveStats = new Map<string, ReadingStats>();
export function liveStatsOf(id: string): ReadingStats | undefined {
  return liveStats.get(id);
}

export class ReadingTracker {
  private stats: ReadingStats;
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
    await db.updateBook(this.book.id, (b) => { b.stats = this.stats; });
  }

  async stop(): Promise<void> {
    window.clearInterval(this.timer); window.clearInterval(this.saveTimer);
    document.removeEventListener('visibilitychange', this.onVis);
    this.tick();
    await this.save();
  }
}
