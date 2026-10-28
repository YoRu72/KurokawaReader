// Series: books of one story in numbered volumes, told from their titles — "Mushoku Tensei Vol. 15",
// "الجزء الثالث", "第3巻", a bare "Name 7" — so the book page can show the other volumes and the reader can
// offer the next one when a book ends.
import type { Book } from './db';

export interface SeriesPart { key: string; name: string; index: number }

const AR_DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20 };
const AR_ORD: Record<string, number> = { 'الأول': 1, 'الأولى': 1, 'الثاني': 2, 'الثانية': 2, 'الثالث': 3, 'الثالثة': 3, 'الرابع': 4, 'الرابعة': 4, 'الخامس': 5, 'الخامسة': 5, 'السادس': 6, 'السادسة': 6, 'السابع': 7, 'السابعة': 7, 'الثامن': 8, 'الثامنة': 8, 'التاسع': 9, 'التاسعة': 9, 'العاشر': 10, 'العاشرة': 10 };
const num = (s: string): number => {
  const d = s.replace(/[٠-٩]/g, (c) => AR_DIGITS[c]);
  if (/^\d+$/.test(d)) return Number(d);
  if (ROMAN[d.toLowerCase()]) return ROMAN[d.toLowerCase()];
  return AR_ORD[d] ?? 0;
};
const clean = (s: string) => s.replace(/[\s:：,،\-–—_|/·.]+$/u, '').replace(/^[\s:：,،\-–—_|/·.]+/u, '').trim();
const keyOf = (s: string) => s.toLowerCase().replace(/[ً-ْٰـ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const PATTERNS: RegExp[] = [
  // "Title Vol. 3", "Title, Volume III", "Title v3", "Title Book 2", "Title Part 2", "Title Tome 2", "Title Band 2", "Title #3"
  /^(.+?)[\s,:：\-–—(]+(?:vol(?:ume)?\.?|v\.?|book|part|tome|tomo|band|episode|ep\.?|season|#)\s*([0-9]+|[ivxlc]+)\b[)\s]*(?:[:：\-–—]\s*.*)?$/iu,
  // "Title الجزء الثالث", "Title المجلد ٢", "Title ج٣", "Title ح 2"
  /^(.+?)[\s،,:\-–—(]+(?:الجزء|المجلد|الحلقة|الكتاب|ج\.?|م\.?)\s*([0-9٠-٩]+|ال\S+)\s*\)?\s*(?:[:：\-–—]\s*.*)?$/u,
  // "Title 第3巻", "Title 3巻", "Title (3)", "Title 第3卷", "Title 3권"
  /^(.+?)\s*(?:第)?\s*([0-9０-９]+)\s*(?:巻|卷|권|集)\s*$/u,
  /^(.+?)\s*[（(]\s*([0-9]+)\s*[)）]\s*$/u,
  // a bare trailing number: "Title 7", "Title - 7" (not a year)
  /^(.+?)[\s\-–—:：]+([0-9]{1,3})$/u,
];

export function seriesOf(title: string): SeriesPart | null {
  const tt = title.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
  for (const re of PATTERNS) {
    const m = re.exec(tt); if (!m) continue;
    const name = clean(m[1]); const index = num(m[2]);
    if (!name || !index || index > 400) continue;
    if (name.length < 2) continue;
    return { key: keyOf(name), name, index };
  }
  return null;
}

/** The other volumes of a book's series in the library, in order (the book itself included). */
/** The series a book belongs to: what its source said, else what its title says. */
export function partOf(book: Book): SeriesPart | null {
  if (book.series?.name) return { key: keyOf(book.series.name), name: book.series.name, index: book.series.index ?? seriesOf(book.title)?.index ?? 0 };
  return seriesOf(book.title);
}

export function volumesOf(book: Book, all: Book[]): { part: SeriesPart; books: { book: Book; index: number }[] } | null {
  const part = partOf(book); if (!part) return null;
  const books = all.map((b) => ({ book: b, part: b.id === book.id ? part : partOf(b) })).filter((x): x is { book: Book; part: SeriesPart } => !!x.part && x.part.key === part.key)
    .map((x) => ({ book: x.book, index: x.part.index })).sort((a, b) => a.index - b.index || a.book.title.localeCompare(b.book.title));
  if (books.length < 2) return null;
  return { part, books };
}

/** The volume after this one in the library, if there is one. */
export function nextVolume(book: Book, all: Book[]): Book | null {
  const v = volumesOf(book, all); if (!v) return null;
  const i = v.books.findIndex((x) => x.book.id === book.id);
  return i >= 0 && i + 1 < v.books.length ? v.books[i + 1].book : null;
}
