// Reading statistics: time spent with a book open and visible, words passed,
// per-day history. Drives "Book information" (hours, speed, history, time left).
import { db, type Book, type ReadingStats } from './db';

const TICK_MS = 5000;
const SAVE_MS = 30000;

export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’ـ-ٟ][\p{L}\p{N}]+)*/gu) ?? []).length;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class ReadingTracker {
  private stats: ReadingStats;
  private timer: number | undefined;
  private saveTimer: number | undefined;
  private lastTick = 0;
  private pendingWords = 0;
  private lastPct = 0;
  private dirty = false;

  constructor(private book: Book, private isActive: () => boolean, bookWords?: number, bookChars?: number) {
    this.stats = book.stats ?? { ms: 0, words: 0, days: {} };
    if (bookWords != null) this.stats.bookWords = bookWords;
    if (bookChars != null) this.stats.bookChars = bookChars;
    this.lastPct = book.progress?.pct ?? 0;
  }

  start(): void {
    this.lastTick = performance.now();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.saveTimer = window.setInterval(() => void this.save(), SAVE_MS);
    document.addEventListener('visibilitychange', this.onVis);
  }

  private onVis = () => { this.lastTick = performance.now(); };

  private tick(): void {
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    if (document.visibilityState !== 'visible' || !this.isActive() || dt > 60000) return;
    const d = this.stats.days[today()] ?? { ms: 0, pct: this.lastPct, words: 0 };
    d.ms += dt; this.stats.ms += dt;
    d.words += this.pendingWords; this.stats.words += this.pendingWords; this.pendingWords = 0;
    d.pct = Math.max(d.pct, this.lastPct);
    this.stats.days[today()] = d;
    this.dirty = true;
  }

  /** Report words the reader scrolled past, and the new progress fraction. */
  advance(words: number, pct: number): void {
    if (words > 0) this.pendingWords += words;
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
    await db.updateBook(this.book.id, (b) => { b.stats = this.stats; });
  }

  async stop(): Promise<void> {
    window.clearInterval(this.timer); window.clearInterval(this.saveTimer);
    document.removeEventListener('visibilitychange', this.onVis);
    this.tick();
    await this.save();
  }
}
