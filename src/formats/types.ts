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

/** Normalise text for search: case-fold, strip Arabic diacritics and tatweel,
 *  unify alef/yaa/taa-marbuta variants. Returns the string and a map from
 *  normalised index → original index. */
export function normalizeForSearch(s: string): { text: string; map: Int32Array } {
  const out: string[] = [];
  const map: number[] = [];
  const push = (n: string, i: number) => { out.push(n); map.push(i); };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = c.charCodeAt(0);
    // Marks and joiners that spell nothing: Arabic harakat, shadda, sukun, superscript alef, Quranic marks and
    // tatweel; Hebrew points; the zero-width joiners, soft hyphen, direction marks, variation selectors.
    if ((code >= 0x064b && code <= 0x065f) || code === 0x0670 || code === 0x0640 || (code >= 0x06d6 && code <= 0x06ed) || (code >= 0x0591 && code <= 0x05c7) || code === 0x200b || code === 0x200c || code === 0x200d || code === 0x00ad || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff || (code >= 0xfe00 && code <= 0xfe0f)) continue;
    // Shaped and compatibility forms (Arabic presentation forms, Latin ligatures ﬁ ﬂ, vertical and full-width
    // forms, circled and superscript digits) match what they stand for.
    if ((code >= 0xfb00 && code <= 0xfb4f) || (code >= 0xfb50 && code <= 0xfdff) || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfefc) || (code >= 0xff01 && code <= 0xffee) || (code >= 0x2460 && code <= 0x24ff) || (code >= 0x2070 && code <= 0x209f) || (code >= 0x3000 && code <= 0x303f && c.normalize('NFKC') !== c)) {
      const k = c.normalize('NFKC');
      if (k !== c) { for (const ch of normalizeForSearch(k).text) push(ch, i); continue; }
    }
    let n = c.toLowerCase();
    if (code === 0x0130) n = 'i'; // (Turkish İ lowercases to two characters)
    // Arabic: hamza seats, alef forms, final yeh/alef maqsura, teh marbuta; Persian/Urdu letters as their Arabic twins.
    if (n === 'أ' || n === 'إ' || n === 'آ' || n === 'ٱ' || n === 'ٲ' || n === 'ٳ') n = 'ا';
    else if (n === 'ى' || n === 'ی' || n === 'ئ' || n === 'ے' || n === 'ې') n = 'ي';
    else if (n === 'ة' || n === 'ہ' || n === 'ۀ' || n === 'ھ') n = 'ه';
    else if (n === 'ؤ' || n === 'ۇ' || n === 'ۆ') n = 'و';
    else if (n === 'ک' || n === 'ڪ') n = 'ك';
    else if (n === 'ء') continue;
    // Digits of any script read as the digits they are (search "١٤٣٥" and find "1435", and the other way).
    else if (code >= 0x0660 && code <= 0x0669) n = String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) n = String(code - 0x06f0);
    else if (/\p{Nd}/u.test(n) && !(code >= 0x30 && code <= 0x39)) { const v = Number(n.normalize('NFKD')); n = Number.isInteger(v) ? String(v) : n; }
    // Latin, Greek, Cyrillic letters without their accents ("cafe" finds "café"; "ς" is "σ").
    else if (code >= 0x00c0 && code <= 0x024f || code >= 0x1e00 && code <= 0x1eff || code >= 0x0370 && code <= 0x03ff || code >= 0x0400 && code <= 0x04ff) {
      const d = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      n = d === 'ß' ? 'ss' : d === 'ς' ? 'σ' : d === 'ø' ? 'o' : d === 'đ' ? 'd' : d === 'ł' ? 'l' : d === 'æ' ? 'ae' : d === 'œ' ? 'oe' : d;
    }
    else if (code >= 0x0300 && code <= 0x036f) continue; // (a combining accent written apart)
    // Quotation marks and dashes of every shape are one kind.
    else if (c === '\u2018' || c === '\u2019' || c === '\u201a' || c === '\u02bc') n = "'";
    else if (c === '\u201c' || c === '\u201d' || c === '\u201e' || c === '«' || c === '»') n = '"';
    else if (c === '\u2013' || c === '\u2014' || c === '\u2212' || c === '\u2010' || c === '\u2011') n = '-';
    else if (c === '\u00a0' || c === '\u2009' || c === '\u202f' || c === '\u3000') n = ' ';
    for (const ch of n) push(ch, i);
  }
  map.push(s.length);
  return { text: out.join(''), map: Int32Array.from(map) };
}
