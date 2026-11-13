import DOMPurify from 'dompurify';
import type JSZip from 'jszip';
import type { ImageRef, RenderContext, TocItem } from './types';
import { isRtlText } from '../i18n';

export const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, figcaption, td, th, pre, div.kr-txt';

export function mimeFor(path: string): string {
  const ext = path.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return ({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
    css: 'text/css', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', mp4: 'video/mp4', xhtml: 'application/xhtml+xml', html: 'text/html',
  } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

/** Percent-decode a link's path or fragment without ever throwing: each run of valid escapes is decoded, and a
 *  bare "%" (a file named "50%.xhtml", written unescaped as books often do) is kept as it is. */
export function safeDecode(s: string): string {
  if (!s.includes('%')) return s;
  return s.replace(/(?:%[0-9a-f]{2})+/gi, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
}

/** Resolve `href` relative to `base` inside a zip (POSIX-style paths). */
export function resolveZipPath(base: string, href: string): string {
  href = safeDecode(href.split('#')[0].split('?')[0]);
  if (!href) return base;
  if (href.startsWith('/')) return href.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of href.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

/** Case-insensitive file lookup in a zip (some EPUBs have inconsistent case). */
export function zipFile(zip: JSZip, path: string): JSZip.JSZipObject | null {
  const direct = zip.file(path);
  if (direct) return direct;
  const lower = path.toLowerCase();
  for (const name of Object.keys(zip.files)) if (name.toLowerCase() === lower) return zip.file(name);
  return null;
}

/** The element the reader scrolls in: pictures are read from the book two screens before they come into it
 *  (watched against the window instead, the margin is cut off by the scrolling element and a picture was read
 *  only once on the screen — an empty space, then the picture). Set by the reader before a book renders. */
let lazyRoot: Element | null = null;
export function setLazyRoot(el: Element | null): void { lazyRoot = el; }

export class UrlPool {
  private urls = new Map<string, string>();
  private root = lazyRoot;
  async fromZip(zip: JSZip, path: string): Promise<string | null> {
    if (this.urls.has(path)) return this.urls.get(path)!;
    const f = zipFile(zip, path);
    if (!f) return null;
    const blob = await f.async('blob');
    const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: mimeFor(path) }));
    this.urls.set(path, url);
    return url;
  }
  /**
   * Point `attr` at the zip entry only when the element nears the viewport, so
   * opening a picture-heavy book does not decompress every image up front.
   */
  lazy(zip: JSZip, path: string, el: Element, attr: string): void {
    const cached = this.urls.get(path);
    if (cached) { el.setAttribute(attr, cached); return; }
    el.setAttribute('data-kr-lazy', path);
    el.removeAttribute(attr);
    this.pending.set(el, { zip, path, attr });
    this.observer().observe(el);
  }
  /** Load every lazy picture under `root` now (e.g. before printing or exporting). */
  async resolveAll(root: ParentNode): Promise<void> {
    await Promise.all([...root.querySelectorAll('[data-kr-lazy]')].map((el) => this.resolveEl(el)));
  }
  private pending = new Map<Element, { zip: JSZip; path: string; attr: string }>();
  private io: IntersectionObserver | null = null;
  private observer(): IntersectionObserver {
    this.io ??= new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) void this.resolveEl(e.target); }, { root: this.root, rootMargin: '200% 0px' });
    return this.io;
  }
  private async resolveEl(el: Element): Promise<void> {
    const p = this.pending.get(el);
    if (!p) return;
    this.pending.delete(el); this.io?.unobserve(el);
    const url = await this.fromZip(p.zip, p.path);
    if (url) el.setAttribute(p.attr, url);
    el.removeAttribute('data-kr-lazy');
    if (url && p.attr === 'src' && el instanceof HTMLImageElement && this.root) { this.live.set(el, p); this.farObserver().observe(el); }
  }
  /**
   * A picture shown once keeps its decoded pixels (megabytes each) for as long as it holds its source — a book of
   * hundreds of pictures read through grew the page's memory by the size of every picture passed until the system
   * ended it (the renderer killed: the app "crashed", or since 0.61.0 started again). So a picture far from the place
   * read (beyond FAR screens, or in a chapter not shown) is let go: its source swapped for an empty picture of the same
   * size (its box does not change — the text does not move) and made lazy again; near again, it is read back from the
   * pool (the book's bytes are kept: no unzipping again). Only where the pictures are read near a scroller (the reader).
   */
  private live = new Map<Element, { zip: JSZip; path: string; attr: string }>();
  private far: IntersectionObserver | null = null;
  private farObserver(): IntersectionObserver {
    this.far ??= new IntersectionObserver((entries) => { for (const e of entries) if (!e.isIntersecting) this.park(e.target); }, { root: this.root, rootMargin: `${UrlPool.FAR * 100}% 0px` });
    return this.far;
  }
  static FAR = 5;
  private park(el: Element): void {
    const p = this.live.get(el); const img = el as HTMLImageElement;
    // (Not yet decoded — its size unknown —: kept; it is looked at again when it next leaves.)
    if (!p || !img.isConnected || !img.complete || !img.naturalWidth) return;
    this.live.delete(el); this.far?.unobserve(el);
    const w = img.naturalWidth, h = img.naturalHeight;
    img.setAttribute('src', `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'/%3E`);
    img.setAttribute('data-kr-lazy', p.path); img.dataset.krParked = '1';
    this.pending.set(el, p); this.observer().observe(el);
  }
  fromBlob(key: string, blob: Blob): string {
    if (this.urls.has(key)) return this.urls.get(key)!;
    const url = URL.createObjectURL(blob);
    this.urls.set(key, url);
    return url;
  }
  dispose(): void {
    this.io?.disconnect(); this.io = null; this.pending.clear();
    this.far?.disconnect(); this.far = null; this.live.clear();
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
  }
}

const purify = DOMPurify;
const keepLinks = (_node: Element, data: { attrName: string; attrValue: string; forceKeepAttr?: boolean }) => {
  // Keep the `epub:type` style namespaced attributes out, allow data-* and blob: image sources.
  if (data.attrName === 'src' || data.attrName === 'href' || data.attrName === 'xlink:href') {
    if (/^(blob:|data:image\/|#|[^:]*$)/i.test(data.attrValue)) data.forceKeepAttr = true;
  }
};
purify.addHook('uponSanitizeAttribute', keepLinks);

const purifyConfig = (keepStyles: boolean) => ({
  IN_PLACE: true,
  WHOLE_DOCUMENT: false,
  ADD_TAGS: ['section', 'figure', 'figcaption', 'svg', 'image', 'use', 'nav', 'aside', 'ruby', 'rt', 'rp', 'wbr', 'mark'],
  ADD_ATTR: ['xlink:href', 'viewBox', 'preserveAspectRatio', 'dir', 'lang', 'epub:type', 'loading', 'decoding', 'data-kr-src', 'data-kr-anchor', 'colspan', 'rowspan'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'title', ...(keepStyles ? [] : ['style', 'font'])],
  FORBID_ATTR: keepStyles ? ['onload', 'onerror'] : ['style', 'color', 'bgcolor', 'background', 'face', 'align', 'width', 'height', 'border', 'cellpadding', 'cellspacing', 'onload', 'onerror'],
  ALLOW_UNKNOWN_PROTOCOLS: true,
});
/** One sanitizer for each of the two settings, its settings read once: given with every call, they were read
 *  again for each chapter — a third of the time a book of hundreds of chapters spent being cleaned. */
const purifiers = new Map<boolean, typeof DOMPurify>();
function purifierFor(keepStyles: boolean): typeof DOMPurify {
  let p = purifiers.get(keepStyles);
  if (!p) { p = DOMPurify(window); p.addHook('uponSanitizeAttribute', keepLinks); p.setConfig(purifyConfig(keepStyles)); purifiers.set(keepStyles, p); }
  return p;
}

export function sanitize(root: Element, keepStyles: boolean): void {
  purifierFor(keepStyles).sanitize(root);
}

/** Give every block a direction of its own so mixed Arabic/English books read naturally,
 *  and set `lang` so the Arabic font stack is picked up. */
/** Number ordered-list items explicitly: some readers' WebViews render every marker as "0."
 *  when the publisher's counter styles are stripped; an explicit `value` always wins. */
export function numberLists(root: Element): void {
  root.querySelectorAll('ol').forEach((ol) => {
    const start = Number(ol.getAttribute('start') ?? '1') || 1;
    let n = start;
    for (const li of Array.from(ol.children)) {
      if (li.tagName !== 'LI') continue;
      const own = li.getAttribute('value');
      if (own && !Number.isNaN(Number(own))) n = Number(own);
      li.setAttribute('value', String(n));
      n++;
    }
  });
}

export function markDirections(root: Element): boolean {
  const [rtlBlocks, total] = markBlockDirections(root);
  const rtl = total > 0 && rtlBlocks / total > 0.5;
  if (!root.getAttribute('dir')) root.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  return rtl;
}
/** markDirections' work on the blocks inside `el` (and its lists numbered), `el` itself left as it is: how many of its
 *  blocks with text read right to left, and how many have text — so a book made a chapter at a time is weighed whole. */
export function markBlockDirections(el: Element): [number, number] {
  numberLists(el);
  let rtlBlocks = 0, total = 0;
  el.querySelectorAll<HTMLElement>(BLOCK_SELECTOR).forEach((b) => {
    const text = b.textContent ?? '';
    if (!text.trim()) return;
    total++;
    const rtl = isRtlText(text);
    if (rtl) rtlBlocks++;
    if (!b.getAttribute('dir')) b.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  });
  return [rtlBlocks, total];
}

/** A text file of a zip, read at once: its bytes inflated in one call and decoded natively — JSZip's own way passes
 *  them through its stream of small chunks and its own UTF-8 decoder, a breath between each, which was a third of the
 *  time a book of hundreds of chapters took to open on a phone. The same text (a byte-order mark kept, as JSZip keeps
 *  it); anything unusual — another compression, a size that does not match — is read JSZip's way. */
type Inflate = (d: Uint8Array) => Uint8Array;
let inflateP: Promise<Inflate | null> | null = null;
const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true }) : null;
export async function zipText(f: JSZip.JSZipObject): Promise<string> {
  const d = (f as unknown as { _data?: { compressedContent?: unknown; uncompressedSize?: number; compression?: { magic?: string } } })._data;
  const raw = d?.compressedContent, magic = d?.compression?.magic;
  if (utf8 && raw instanceof Uint8Array && (magic === '\x00\x00' || magic === '\x08\x00')) {
    try {
      let bytes: Uint8Array | null = raw;
      if (magic === '\x08\x00') { const inflate = await (inflateP ??= import('pako').then((m) => ((m.default ?? m) as { inflateRaw?: Inflate }).inflateRaw ?? null).catch(() => null)); bytes = inflate ? inflate(raw) : null; }
      if (bytes && bytes.length === d!.uncompressedSize) return utf8.decode(bytes);
    } catch { /* read JSZip's way */ }
  }
  return f.async('text');
}

/** A breath between two slices of work: the page draws a frame if one is due and answers a touch (a message to
 *  itself — a timer of 0 is held back 4 ms or more once timers nest). */
export function breath(): Promise<void> {
  return new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });
}
/** Until the next frame has been drawn (work done then has the rest of the frame); a page hidden — no frames — goes on
 *  after a second. */
export function afterFrame(): Promise<void> {
  return new Promise((r) => { let done = false; const go = () => { if (done) return; done = true; window.clearTimeout(t); void breath().then(r); }; const t = window.setTimeout(go, 1000); requestAnimationFrame(go); });
}

/** Detect dark line-art on a transparent background (so dark themes can invert it). */
export function tagLineArt(img: HTMLImageElement): void {
  const check = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 24; c.height = 24;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, 24, 24);
      const d = ctx.getImageData(0, 0, 24, 24).data;
      let transparent = 0, lum = 0, opaque = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 40) { transparent++; continue; }
        opaque++; lum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      }
      if (opaque && transparent > 24 * 24 * 0.08 && lum / opaque < 0.4) img.classList.add('kr-lineart');
    } catch { /* cross-origin or decode failure: leave as is */ }
  };
  if (img.complete && img.naturalWidth) check(); else img.addEventListener('load', check, { once: true });
}

/** Collect images with stable ids for the gallery. */
export function collectImages(root: Element, ctx: RenderContext, prefix: string, pool?: UrlPool, zip?: JSZip): ImageRef[] {
  const out: ImageRef[] = [];
  let i = 0;
  root.querySelectorAll<HTMLImageElement>('img[src], img[data-kr-lazy]').forEach((img) => {
    if (!img.id) img.id = ctx.id(`${prefix}-img${i}`);
    i++;
    img.loading = 'lazy';
    img.decoding = 'async';
    tagLineArt(img);
    const lazy = img.dataset.krLazy;
    const load = lazy && pool ? () => pool.fromZip(zip!, lazy).then((u) => u ?? '') : undefined;
    out.push({ src: img.src || img.getAttribute('src') || '', load, alt: img.alt || undefined, anchor: img.id, bookId: ctx.bookId, bookTitle: ctx.bookTitle });
  });
  return out;
}

/** Build a TOC from headings when a document has none of its own. */
export function tocFromHeadings(root: Element, ctx: RenderContext, prefix: string, maxDepth = 3): TocItem[] {
  const items: TocItem[] = [];
  root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6').forEach((hd, i) => {
    const level = Number(hd.tagName[1]);
    if (level > maxDepth) return;
    const label = (hd.textContent ?? '').trim();
    if (!label) return;
    if (!hd.id) hd.id = ctx.id(`${prefix}-h${i}`);
    items.push({ label, depth: level - 1, anchor: hd.id });
  });
  // Normalise depths so the shallowest heading is depth 0.
  const min = Math.min(...items.map((t) => t.depth), 0);
  items.forEach((t) => (t.depth -= min));
  return items;
}

export function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'application/xml');
}

/** Decode text with a sensible fallback for legacy Arabic/Latin encodings. `partial`: the bytes are the head of a
 *  longer file (a title read from its start), so a character cut in two at the end is dropped, not taken for a
 *  sign that the file is not UTF-8 — Arabic, Japanese, Chinese and Korean letters take two to four bytes each. */
export async function decodeText(blob: Blob, opts: { partial?: boolean } = {}): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    // (Streaming, the decoder keeps an unfinished last character back instead of failing on it.)
    return opts.partial ? new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true }) : new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Not valid UTF-8. Guess between windows-1256 (Arabic) and windows-1252 by
    // counting high bytes that land in Arabic letter ranges.
    const sample = bytes.subarray(0, 4000);
    let high = 0;
    for (const b of sample) if (b >= 0xc1 && b <= 0xfe) high++;
    const enc = high > sample.length * 0.15 ? 'windows-1256' : 'windows-1252';
    try { return new TextDecoder(enc).decode(buf); } catch { return new TextDecoder().decode(buf); }
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function textToParagraphs(text: string, container: HTMLElement): void {
  // Blank-line separated paragraphs; single newlines are kept as soft breaks.
  const paras = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  // A long text in runs of paragraphs (div.kr-run), each laid out only when near the screen (content-visibility in
  // reader.css): a novel of several megabytes was laid out whole before its first line showed — seconds on a phone.
  // Until a run is laid out its height is reckoned from its characters and paragraphs (--kr-run-c, --kr-run-p; the
  // reader measures one run for the rest — sizeRuns in views/reader.ts). A short text stays as it was.
  const long = text.length > RUN_TEXT * 3;
  let run: HTMLElement | null = null, chars = 0, count = 0;
  const close = () => { if (run) { run.style.setProperty('--kr-run-c', String(chars)); run.style.setProperty('--kr-run-p', String(count)); } };
  for (const p of paras) {
    const t = p.replace(/\n+$/, '');
    if (!t.trim()) continue;
    const pe = el('p', 'kr-txt');
    pe.textContent = t;
    if (!long) { container.appendChild(pe); continue; }
    if (!run || chars >= RUN_TEXT || count >= 64) { close(); run = el('div', 'kr-run'); container.appendChild(run); chars = 0; count = 0; }
    run.appendChild(pe); chars += t.length; count++;
  }
  close();
}
/** About how much text a run of a long plain text holds (characters). */
const RUN_TEXT = 12_000;
