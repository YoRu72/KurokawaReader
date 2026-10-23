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

export type Handler = FlowHandler | PdfHandler;

export function titleFromFileName(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() || name;
}

/** Normalise text for search: case-fold, strip Arabic diacritics and tatweel,
 *  unify alef/yaa/taa-marbuta variants. Returns the string and a map from
 *  normalised index → original index. */
export function normalizeForSearch(s: string): { text: string; map: Int32Array } {
  const out: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = c.charCodeAt(0);
    // Arabic diacritics (harakat, shadda, sukun, superscript alef) and tatweel
    if ((code >= 0x064b && code <= 0x0652) || code === 0x0670 || code === 0x0640 || code === 0x0653 || code === 0x0654 || code === 0x0655) continue;
    let n = c.toLowerCase();
    if (n === 'أ' || n === 'إ' || n === 'آ' || n === 'ٱ') n = 'ا';
    else if (n === 'ى') n = 'ي';
    else if (n === 'ة') n = 'ه';
    else if (n === 'ؤ') n = 'و';
    else if (n === 'ئ') n = 'ي';
    out.push(n);
    map.push(i);
  }
  map.push(s.length);
  return { text: out.join(''), map: Int32Array.from(map) };
}
