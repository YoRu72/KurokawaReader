import type { Format } from '../db';

export interface TocItem {
  label: string;
  depth: number;
  /** id of the element to scroll to inside the rendered content. */
  anchor: string;
  /** PDF: 1-based page number. */
  page?: number;
}

export interface ImageRef {
  /** Object URL (or data URL) of the image; '' until a lazily loaded picture is resolved — use load(). */
  src: string;
  /** Resolves the object URL (decompressing the picture on first use). */
  load?: () => Promise<string>;
  alt?: string;
  /** id of the <img> in the rendered content, for "show in text". */
  anchor: string;
  bookId: string;
  bookTitle: string;
}

export interface BookMeta {
  title: string;
  author?: string;
  language?: string;
  cover?: Blob;
  pageCount?: number;
  description?: string;
}

export interface RenderContext {
  bookId: string;
  /** Produce a unique element id with the given suffix. */
  id(suffix: string): string;
  publisherStyles: boolean;
  bookTitle: string;
}

export interface FlowRender {
  /** Root element carrying class `kr-content`. */
  element: HTMLElement;
  toc: TocItem[];
  images: ImageRef[];
  rtl: boolean;
  /** Release object URLs etc. */
  dispose(): void;
  /** Load every lazily resolved picture now (export / conversion). */
  resolveImages?(): Promise<void>;
}

export interface FlowHandler {
  kind: 'flow';
  format: Format;
  readMeta(file: Blob, fileName: string): Promise<BookMeta>;
  render(file: Blob, ctx: RenderContext): Promise<FlowRender>;
}

export interface PdfHandler {
  kind: 'pdf';
  format: 'pdf';
  readMeta(file: Blob, fileName: string): Promise<BookMeta>;
}

/** Formats with a view of their own (Anki decks, audiobooks): metadata only here. */
export interface OtherHandler {
  kind: 'deck' | 'audio';
  format: Format;
  readMeta(file: Blob, fileName: string): Promise<BookMeta>;
}

export type Handler = FlowHandler | PdfHandler | OtherHandler;

export function titleFromFileName(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() || name;
}

/** What one character becomes in search text, on its own: '' when it spells nothing (a haraka, a joiner, a
 *  lone hamza), itself when it stays, else its plain form (lower case, no accent, the Arabic letter it stands
 *  for, the digit it is). Context — a hyphen between letters, the space after it — is the caller's. */
function normChar(c: string, code: number): string {
  // Marks and joiners that spell nothing: Arabic harakat, shadda, sukun, superscript alef, Quranic marks and
  // tatweel; Hebrew points; the zero-width joiners, soft hyphen, direction marks, variation selectors.
  if ((code >= 0x064b && code <= 0x065f) || code === 0x0670 || code === 0x0640 || (code >= 0x06d6 && code <= 0x06ed) || (code >= 0x0591 && code <= 0x05c7) || code === 0x200b || code === 0x200c || code === 0x200d || code === 0x00ad || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff || (code >= 0xfe00 && code <= 0xfe0f)) return '';
  // Shaped and compatibility forms (Arabic presentation forms, Latin ligatures ﬁ ﬂ, vertical and full-width
  // forms, circled and superscript digits) match what they stand for.
  if ((code >= 0xfb00 && code <= 0xfb4f) || (code >= 0xfb50 && code <= 0xfdff) || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfefc) || (code >= 0xff01 && code <= 0xffee) || (code >= 0x2460 && code <= 0x24ff) || (code >= 0x2070 && code <= 0x209f) || (code >= 0x3000 && code <= 0x303f && c.normalize('NFKC') !== c)) {
    const k = c.normalize('NFKC');
    if (k !== c) return normalizeForSearch(k).text;
  }
  let n = c.toLowerCase();
  if (code === 0x0130) n = 'i'; // (Turkish İ lowercases to two characters)
  // Arabic: hamza seats, alef forms, final yeh/alef maqsura, teh marbuta; Persian/Urdu letters as their Arabic twins.
  if (n === 'أ' || n === 'إ' || n === 'آ' || n === 'ٱ' || n === 'ٲ' || n === 'ٳ') n = 'ا';
  else if (n === 'ى' || n === 'ی' || n === 'ئ' || n === 'ے' || n === 'ې') n = 'ي';
  else if (n === 'ة' || n === 'ہ' || n === 'ۀ' || n === 'ھ') n = 'ه';
  else if (n === 'ؤ' || n === 'ۇ' || n === 'ۆ') n = 'و';
  else if (n === 'ک' || n === 'ڪ') n = 'ك';
  else if (n === 'ء') return '';
  // Digits of any script read as the digits they are (search "١٤٣٥" and find "1435", and the other way).
  else if (code >= 0x0660 && code <= 0x0669) n = String(code - 0x0660);
  else if (code >= 0x06f0 && code <= 0x06f9) n = String(code - 0x06f0);
  else if (/\p{Nd}/u.test(n) && !(code >= 0x30 && code <= 0x39)) { const v = Number(n.normalize('NFKD')); n = Number.isInteger(v) ? String(v) : n; }
  // Latin, Greek, Cyrillic letters without their accents ("cafe" finds "café"; "ς" is "σ").
  else if (code >= 0x00c0 && code <= 0x024f || code >= 0x1e00 && code <= 0x1eff || code >= 0x0370 && code <= 0x03ff || code >= 0x0400 && code <= 0x04ff) {
    const d = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    n = d === 'ß' ? 'ss' : d === 'ς' ? 'σ' : d === 'ø' ? 'o' : d === 'đ' ? 'd' : d === 'ł' ? 'l' : d === 'æ' ? 'ae' : d === 'œ' ? 'oe' : d;
  }
  else if (code >= 0x0300 && code <= 0x036f) return ''; // (a combining accent written apart)
  // Quotation marks and dashes of every shape are one kind.
  else if (c === '\u2018' || c === '\u2019' || c === '\u201a' || c === '\u02bc') n = "'";
  else if (c === '\u201c' || c === '\u201d' || c === '\u201e' || c === '«' || c === '»') n = '"';
  else if (c === '\u2013' || c === '\u2014' || c === '\u2212' || c === '\u2010' || c === '\u2011') n = '-';
  else if (c === '\u00a0' || c === '\u2009' || c === '\u202f' || c === '\u3000') n = ' ';
  return n;
}
// (The first 0x700 code points — Latin, Greek, Cyrillic, Hebrew, Arabic and their marks — are looked up in a
// table made once, so a whole book is normalised at a few tens of nanoseconds a character.)
const NORM_TABLE: string[] = [];
function normTable(): string[] {
  if (!NORM_TABLE.length) for (let code = 0; code < 0x700; code++) NORM_TABLE.push(normChar(String.fromCharCode(code), code));
  return NORM_TABLE;
}
const isLetter = (c: string) => /\p{L}/u.test(c);
const isSpace = (code: number) => code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;

/** Normalise text for search: case-fold, strip Arabic diacritics and tatweel,
 *  unify alef/yaa/taa-marbuta variants. Returns the string and a map from
 *  normalised index → original index. */
export function normalizeForSearch(s: string): { text: string; map: Int32Array } { return normalize(s, true) as { text: string; map: Int32Array }; }
/** The search form alone, with no map back: what a book's text is kept as between searches. */
export function searchFormOf(s: string): string { return (normalize(s, false) as { text: string }).text; }
function normalize(s: string, withMap: boolean): { text: string; map?: Int32Array } {
  const table = normTable();
  const out: string[] = [];
  let map = withMap ? new Int32Array(s.length + 16) : EMPTY_MAP; let m = 0;
  let skipSpace = false, run = -1;   // run: where the current stretch of unchanged characters began
  const flush = (i: number) => { if (run >= 0) { out.push(s.slice(run, i)); run = -1; } };
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (skipSpace) { if (isSpace(code)) { flush(i); continue; } skipSpace = false; }
    const n = code < 0x700 ? table[code] : normChar(s[i], code);
    // Most characters are their own search form: whole stretches of them are copied at once.
    if (n.length === 1 && n.charCodeAt(0) === code && code !== 45) { if (run < 0) run = i; if (withMap) map[m++] = i; continue; }
    flush(i);
    if (!n) continue;
    // (A hyphen between letters — a word broken at a line's end, or a compound — is no letter: "Saint-Honoré"
    // and "extraordi-narily" are found written either way.)
    if (n === '-' && i > 0 && i + 1 < s.length && isLetter(s[i - 1]) && (isSpace(s.charCodeAt(i + 1)) || isLetter(s[i + 1]))) { if (isSpace(s.charCodeAt(i + 1))) { /* the break after it goes too */ skipSpace = true; } continue; }
    if (!withMap) { out.push(n); continue; }
    if (m + n.length >= map.length) { const bigger = new Int32Array(map.length * 2 + n.length); bigger.set(map); map = bigger; }
    if (n.length === 1) { out.push(n); map[m++] = i; }
    else for (const ch of n) { out.push(ch); map[m++] = i; }
  }
  flush(s.length);
  if (!withMap) return { text: out.join('') };
  map[m++] = s.length;
  return { text: out.join(''), map: map.subarray(0, m) };
}
const EMPTY_MAP = new Int32Array(0);
