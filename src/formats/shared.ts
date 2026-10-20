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

/** Resolve `href` relative to `base` inside a zip (POSIX-style paths). */
export function resolveZipPath(base: string, href: string): string {
  href = decodeURIComponent(href.split('#')[0].split('?')[0]);
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

export class UrlPool {
  private urls = new Map<string, string>();
  async fromZip(zip: JSZip, path: string): Promise<string | null> {
    if (this.urls.has(path)) return this.urls.get(path)!;
    const f = zipFile(zip, path);
    if (!f) return null;
    const blob = await f.async('blob');
    const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: mimeFor(path) }));
    this.urls.set(path, url);
    return url;
  }
  fromBlob(key: string, blob: Blob): string {
    if (this.urls.has(key)) return this.urls.get(key)!;
    const url = URL.createObjectURL(blob);
    this.urls.set(key, url);
    return url;
  }
  dispose(): void {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
  }
}

const purify = DOMPurify;
purify.addHook('uponSanitizeAttribute', (_node, data) => {
  // Keep the `epub:type` style namespaced attributes out, allow data-* and blob: image sources.
  if (data.attrName === 'src' || data.attrName === 'href' || data.attrName === 'xlink:href') {
    if (/^(blob:|data:image\/|#|[^:]*$)/i.test(data.attrValue)) data.forceKeepAttr = true;
  }
});

export function sanitize(root: Element, keepStyles: boolean): void {
  purify.sanitize(root, {
    IN_PLACE: true,
    WHOLE_DOCUMENT: false,
    ADD_TAGS: ['section', 'figure', 'figcaption', 'svg', 'image', 'use', 'nav', 'aside', 'ruby', 'rt', 'rp', 'wbr', 'mark'],
    ADD_ATTR: ['xlink:href', 'viewBox', 'preserveAspectRatio', 'dir', 'lang', 'epub:type', 'loading', 'decoding', 'data-kr-src', 'data-kr-anchor', 'colspan', 'rowspan'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'title', ...(keepStyles ? [] : ['style', 'font'])],
    FORBID_ATTR: keepStyles ? ['onload', 'onerror'] : ['style', 'color', 'bgcolor', 'background', 'face', 'align', 'width', 'height', 'border', 'cellpadding', 'cellspacing', 'onload', 'onerror'],
    ALLOW_UNKNOWN_PROTOCOLS: true,
  });
}

/** Give every block a direction of its own so mixed Arabic/English books read naturally,
 *  and set `lang` so the Arabic font stack is picked up. */
export function markDirections(root: Element): boolean {
  let rtlBlocks = 0, total = 0;
  root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR).forEach((el) => {
    const text = el.textContent ?? '';
    if (!text.trim()) return;
    total++;
    const rtl = isRtlText(text);
    if (rtl) rtlBlocks++;
    if (!el.getAttribute('dir')) el.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  });
  const rtl = total > 0 && rtlBlocks / total > 0.5;
  if (!root.getAttribute('dir')) root.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  return rtl;
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
export function collectImages(root: Element, ctx: RenderContext, prefix: string): ImageRef[] {
  const out: ImageRef[] = [];
  let i = 0;
  root.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
    if (!img.id) img.id = ctx.id(`${prefix}-img${i}`);
    i++;
    img.loading = 'lazy';
    img.decoding = 'async';
    tagLineArt(img);
    out.push({ src: img.src || img.getAttribute('src')!, alt: img.alt || undefined, anchor: img.id, bookId: ctx.bookId, bookTitle: ctx.bookTitle });
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

/** Decode text with a sensible fallback for legacy Arabic/Latin encodings. */
export async function decodeText(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
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
  for (const p of paras) {
    const t = p.replace(/\n+$/, '');
    if (!t.trim()) continue;
    const pe = el('p', 'kr-txt');
    pe.textContent = t;
    container.appendChild(pe);
  }
}
