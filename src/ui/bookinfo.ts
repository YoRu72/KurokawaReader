// "Book information" sheet — the Moon+-style summary: file facts, position,
// reading time and speed, per-day history, size of the text, time left.
import { h, openSheet, append } from './dom';
import { t, formatBytes, formatDate } from '../i18n';
import type { Book, ReadingStats } from '../db';
import { coverUrl } from '../library';

export interface BookInfoInput {
  book: Book;
  stats: ReadingStats;
  speed: number | null;
  chapters?: number;
  currentChapter?: string;
  currentChapterIndex?: number;
  pages?: number;
  currentPage?: number;
  pct: number;
  wordsLeftInChapter?: number;
  wordsLeftInBook?: number;
}

function hm(ms: number): string {
  const m = Math.round(ms / 60000);
  return t('hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
}
function mmss(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`;
}

export function showBookInfo(i: BookInfoInput): void {
  const { book, stats } = i;
  const sheet = openSheet(t('bookInfo'), t('close'));
  sheet.body.style.fontFamily = 'var(--font-ui)';
  sheet.body.style.fontSize = '14.5px';
  sheet.body.style.lineHeight = '1.75';
  const cover = coverUrl(book);
  const row = (k: string, v: string | number | undefined) => v === undefined || v === '' ? null : h('div', null, h('b', null, k + ': '), h('span', { dir: 'auto' }, String(v)));
  const days = Object.entries(stats.days).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 14);
  const speed = i.speed;
  const leftChapter = speed && i.wordsLeftInChapter != null ? Math.ceil(i.wordsLeftInChapter / speed) : undefined;
  const leftBook = speed && i.wordsLeftInBook != null ? Math.ceil(i.wordsLeftInBook / speed) : undefined;

  append(sheet.body, [
    cover ? h('img', { src: cover, alt: '', style: { width: '100%', maxHeight: '220px', objectFit: 'contain', borderRadius: '14px', marginBottom: '14px', background: 'var(--md-surface-container)' } }) : null,
    h('div', { style: { fontSize: '17px', fontWeight: '600', marginBottom: '10px' }, dir: 'auto' }, book.title, book.author ? h('span', { style: { fontWeight: '400', color: 'var(--md-on-surface-dim)' } }, ` — ${book.author}`) : null),
    row(t('format'), `${book.format.toUpperCase()} · ${book.fileName}`),
    row(t('size'), formatBytes(book.size)),
    row(t('added'), formatDate(book.addedAt)),
    i.pages != null ? row(t('pages'), i.pages) : null,
    i.currentPage != null ? row(t('currentPage'), i.currentPage) : null,
    i.chapters != null ? row(t('chapters'), i.chapters) : null,
    i.currentChapter ? row(t('currentChapter'), `${i.currentChapterIndex != null ? i.currentChapterIndex + 1 + ', ' : ''}${i.currentChapter}`) : null,
    row(t('progress'), `${Math.round(i.pct * 100)}%`),
    h('div', { style: { height: '12px' } }),
    row(t('readingHours'), hm(stats.ms)),
    row(t('readingSpeed'), speed ?? '—'),
    days.length ? h('div', null, h('b', null, t('readingHistory') + ':'), h('div', { style: { fontSize: '13px', color: 'var(--md-on-surface-variant)', fontVariantNumeric: 'tabular-nums', marginTop: '4px' } },
      ...days.map(([d, v]) => h('div', { dir: 'ltr' }, `${d}  ${mmss(v.ms)}  ${v.ms > 30000 && v.words > 20 ? Math.round(v.words / (v.ms / 60000)) + ' w/m' : ''}  ${Math.round(v.pct * 100)}%`)))) : null,
    h('div', { style: { height: '12px' } }),
    stats.bookChars != null ? row(t('charsInBook'), stats.bookChars.toLocaleString('en-US')) : null,
    stats.bookWords != null ? row(t('wordsInBook'), stats.bookWords.toLocaleString('en-US')) : null,
    leftChapter != null ? h('p', { style: { fontStyle: 'italic', color: 'var(--md-on-surface-dim)', margin: '12px 0 0' } }, t('minsLeftChapter', { n: leftChapter })) : null,
    leftBook != null ? h('p', { style: { fontStyle: 'italic', color: 'var(--md-on-surface-dim)', margin: '2px 0 0' } }, t('minsLeftBook', { n: leftBook })) : null,
  ]);
}
