// A book on a server looked into without fetching it whole. An EPUB is a zip: its directory is read from
// the end of the file, then only the pieces wanted — the package (title, author), the contents, the cover —
// each a range of the file. A PDF is opened by pdf.js over ranges too, for its first page and its outline.
// The cover becomes a small picture, kept with the rest on the device, so a folder seen again shows at once.
import { request, bytesOf } from './http';
import { db } from '../db';
import { SourceError } from './types';

export interface Peek { title?: string; author?: string; cover?: string; toc?: { label: string; depth: number }[]; at: number; count?: number }

const h32 = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

/* ---------- ranges ---------- */
/** Hosts that answered a range with the whole file: their big files are not looked into. */
const wholeHosts = new Set<string>();
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };

interface Got { bytes: Uint8Array; start: number; total?: number; whole: boolean }
/** Bytes `from`–`to` (inclusive) of a file, or its last `-from` bytes when `from` is negative. */
async function range(url: string, from: number, to?: number): Promise<Got> {
  const r = await request(url, { headers: { range: from < 0 ? `bytes=${from}` : `bytes=${from}-${to ?? ''}` }, binary: true, quiet: true, retries: 1 });
  if (r.status === 416) throw new SourceError('range', 'http', 416);
  if (r.status >= 400) throw new SourceError(`HTTP ${r.status}`, 'http', r.status);
  const bytes = bytesOf(r.body);
  if (r.status !== 206) { wholeHosts.add(hostOf(url)); return { bytes, start: 0, total: bytes.length, whole: true }; }
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(r.headers['content-range'] ?? '');
  return { bytes, start: m ? Number(m[1]) : Math.max(0, from), total: m && m[3] !== '*' ? Number(m[3]) : undefined, whole: false };
}

/* ---------- a zip read in pieces ---------- */
interface ZEntry { name: string; method: number; csize: number; usize: number; offset: number; crc: number; nameLen: number; extraLen: number }
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 0x100000000;
const utf8 = new TextDecoder();

class RemoteZip {
  entries = new Map<string, ZEntry>();
  /** The whole file, when the server sent it whole (or it was small enough to take at once). */
  private all: Uint8Array | null = null;
  constructor(readonly url: string) {}

  async open(): Promise<void> {
    // The end of the file (the whole of it from a server that ignores ranges): the end record, then the directory.
    const tail = await range(this.url, -65536);
    if (tail.whole) this.all = tail.bytes;
    const total = tail.total ?? tail.start + tail.bytes.length;
    let eocd = -1;
    for (let i = tail.bytes.length - 22; i >= Math.max(0, tail.bytes.length - 22 - 65557); i--) if (tail.bytes[i] === 0x50 && tail.bytes[i + 1] === 0x4b && tail.bytes[i + 2] === 5 && tail.bytes[i + 3] === 6) { eocd = i; break; }
    if (eocd < 0) throw new SourceError('notZip', 'parse');
    let cdSize = u32(tail.bytes, eocd + 12), cdOffset = u32(tail.bytes, eocd + 16);
    // (ZIP64: the real numbers are in the record the locator before the end points to.)
    if ((cdOffset === 0xffffffff || cdSize === 0xffffffff) && eocd >= 20 && u32(tail.bytes, eocd - 20) === 0x07064b50) {
      const recAt = u64(tail.bytes, eocd - 20 + 8) - tail.start;
      if (recAt >= 0 && u32(tail.bytes, recAt) === 0x06064b50) { cdSize = u64(tail.bytes, recAt + 40); cdOffset = u64(tail.bytes, recAt + 48); }
    }
    if (cdOffset >= tail.start) { this.readDirectory(tail.bytes, cdOffset - tail.start, cdOffset - tail.start + cdSize); return; }
    // (A long directory starts before the piece read: fetched by itself.)
    if (cdSize > 4 * 1024 * 1024 || cdOffset + cdSize > total) throw new SourceError('notZip', 'parse');
    const cd = await range(this.url, cdOffset, cdOffset + cdSize - 1);
    if (cd.whole) { this.all = cd.bytes; this.readDirectory(cd.bytes, cdOffset, cdOffset + cdSize); return; }
    this.readDirectory(cd.bytes, 0, cd.bytes.length);
  }

  private readDirectory(b: Uint8Array, from: number, to: number): void {
    let p = from;
    while (p + 46 <= to && u32(b, p) === 0x02014b50) {
      const nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), commentLen = u16(b, p + 32);
      let csize = u32(b, p + 20), usize = u32(b, p + 24), offset = u32(b, p + 42);
      const name = utf8.decode(b.subarray(p + 46, p + 46 + nameLen));
      // (ZIP64 sizes and offset in the extra field, in that order, for the ones marked 0xffffffff.)
      if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) {
        let e = p + 46 + nameLen; const end = e + extraLen;
        while (e + 4 <= end) {
          const id = u16(b, e), len = u16(b, e + 2);
          if (id === 1) { let q = e + 4; if (usize === 0xffffffff) { usize = u64(b, q); q += 8; } if (csize === 0xffffffff) { csize = u64(b, q); q += 8; } if (offset === 0xffffffff) offset = u64(b, q); break; }
          e += 4 + len;
        }
      }
      this.entries.set(name, { name, method: u16(b, p + 10), csize, usize, offset, crc: u32(b, p + 16), nameLen, extraLen });
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (!this.entries.size) throw new SourceError('notZip', 'parse');
  }

  /** The named entries' bytes, uncompressed: neighbours fetched in one range. */
  async read(names: string[]): Promise<Map<string, Uint8Array>> {
    const want = [...new Set(names)].map((n) => this.entries.get(n)).filter((e): e is ZEntry => !!e).sort((a, b) => a.offset - b.offset);
    const out = new Map<string, Uint8Array>();
    if (!want.length) return out;
    // Groups of entries close to each other, each fetched as one range (with room for the local headers).
    const groups: ZEntry[][] = [];
    for (const e of want) {
      const g = groups[groups.length - 1];
      const end = (x: ZEntry) => x.offset + 30 + x.nameLen + x.extraLen + x.csize + 256;
      if (g && e.offset - end(g[g.length - 1]) < 96 * 1024 && end(e) - g[0].offset < 2 * 1024 * 1024) g.push(e); else groups.push([e]);
    }
    for (const g of groups) {
      const from = g[0].offset; const to = g[g.length - 1].offset + 30 + g[g.length - 1].nameLen + g[g.length - 1].extraLen + g[g.length - 1].csize + 1024;
      let buf: Uint8Array; let base: number;
      if (this.all) { buf = this.all; base = 0; }
      else { const got = await range(this.url, from, to); if (got.whole) { this.all = got.bytes; buf = got.bytes; base = 0; } else { buf = got.bytes; base = got.start; } }
      for (const e of g) {
        const at = e.offset - base;
        if (at < 0 || u32(buf, at) !== 0x04034b50) continue;
        const start = at + 30 + u16(buf, at + 26) + u16(buf, at + 28);
        const data = buf.subarray(start, start + e.csize);
        if (data.length < e.csize) continue;
        try { out.set(e.name, e.method === 0 ? data.slice() : e.method === 8 ? await inflateRaw(data, e) : data.slice()); } catch { /* left out */ }
      }
    }
    return out;
  }
}

/** Raw DEFLATE: the browser's own stream when it has one, else JSZip over a zip of that one entry. */
async function inflateRaw(data: Uint8Array, e: ZEntry): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const ds = new DecompressionStream('deflate-raw' as CompressionFormat);
      return new Uint8Array(await new Response(new Blob([data.slice().buffer as ArrayBuffer]).stream().pipeThrough(ds)).arrayBuffer());
    } catch { /* not this browser: below */ }
  }
  const JSZip = (await import('jszip')).default;
  const name = new TextEncoder().encode('x');
  const local = new Uint8Array(30 + name.length); const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, 8, true); lv.setUint32(14, e.crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, e.usize, true); lv.setUint16(26, name.length, true); local.set(name, 30);
  const central = new Uint8Array(46 + name.length); const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, 8, true); cv.setUint32(16, e.crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, e.usize, true); cv.setUint16(28, name.length, true); central.set(name, 46);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, central.length, true); ev.setUint32(16, local.length + data.length, true);
  const all = new Uint8Array(local.length + data.length + central.length + end.length);
  all.set(local, 0); all.set(data, local.length); all.set(central, local.length + data.length); all.set(end, local.length + data.length + central.length);
  const z = await JSZip.loadAsync(all);
  return z.file('x')!.async('uint8array');
}

/* ---------- an EPUB ---------- */
const xml = (bytes: Uint8Array, type: DOMParserSupportedType = 'application/xml') => new DOMParser().parseFromString(utf8.decode(bytes).replace(/^﻿/, ''), type);
const byTag = (d: Document | Element, tag: string) => Array.from(d.getElementsByTagName('*')).filter((e) => e.localName === tag);
const textOf = (e: Element | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** A path inside the zip from an href in a file at `dir` (percent-decoded, `..` resolved). */
function resolve(dir: string, href: string): string {
  try { return decodeURIComponent(new URL(href.split('#')[0], `zip://x/${dir}`).pathname.slice(1)); } catch { return href; }
}

async function peekEpub(url: string): Promise<Peek> {
  const z = new RemoteZip(url);
  await z.open();
  const container = (await z.read(['META-INF/container.xml'])).get('META-INF/container.xml');
  let opfPath = container ? byTag(xml(container), 'rootfile')[0]?.getAttribute('full-path') ?? '' : '';
  if (!opfPath || !z.entries.has(opfPath)) opfPath = [...z.entries.keys()].find((n) => /\.opf$/i.test(n)) ?? '';
  if (!opfPath) throw new SourceError('notEpub', 'parse');
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  // (The package, with the likeliest contents files beside it in the same range when they are near.)
  const guessToc = [...z.entries.keys()].filter((n) => /(^|\/)(toc\.ncx|nav\.xhtml|toc\.xhtml|nav\.html)$/i.test(n));
  const first = await z.read([opfPath, ...guessToc]);
  const opfBytes = first.get(opfPath); if (!opfBytes) throw new SourceError('notEpub', 'parse');
  const opf = xml(opfBytes);
  const meta = byTag(opf, 'metadata')[0];
  const title = meta ? textOf(byTag(meta, 'title')[0]) : '';
  const author = meta ? byTag(meta, 'creator').map(textOf).filter(Boolean).slice(0, 2).join(', ') : '';
  const items = byTag(opf, 'item').map((i) => ({ id: i.getAttribute('id') ?? '', href: i.getAttribute('href') ?? '', type: i.getAttribute('media-type') ?? '', props: i.getAttribute('properties') ?? '' }));
  const isImg = (t: string) => /^image\//i.test(t);
  // The cover: the one the package names, else a picture called so, else the picture of the cover page.
  const coverId = byTag(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
  let cover = items.find((i) => /(^|\s)cover-image(\s|$)/.test(i.props)) ?? items.find((i) => i.id === coverId && isImg(i.type)) ?? items.find((i) => isImg(i.type) && /cover/i.test(`${i.id} ${i.href}`));
  let coverPath = cover ? resolve(dir, cover.href) : '';
  if (!coverPath) {
    const page = byTag(opf, 'reference').find((r) => r.getAttribute('type') === 'cover')?.getAttribute('href') ?? items.find((i) => /cover/i.test(i.id) && /html/.test(i.type))?.href;
    if (page) {
      const pagePath = resolve(dir, page);
      const html = (await z.read([pagePath])).get(pagePath);
      if (html) {
        const d = xml(html, 'text/html');
        const src = d.querySelector('img')?.getAttribute('src') ?? Array.from(d.getElementsByTagName('image'))[0]?.getAttribute('xlink:href') ?? Array.from(d.getElementsByTagName('image'))[0]?.getAttribute('href');
        if (src) { coverPath = resolve(pagePath.slice(0, pagePath.lastIndexOf('/') + 1), src); cover = { id: '', href: src, type: /\.png$/i.test(src) ? 'image/png' : 'image/jpeg', props: '' }; }
      }
    }
  }
  // The contents: the navigation document (EPUB 3), else the NCX (EPUB 2).
  const navItem = items.find((i) => /(^|\s)nav(\s|$)/.test(i.props));
  const ncxId = byTag(opf, 'spine')[0]?.getAttribute('toc');
  const ncxItem = items.find((i) => i.id === ncxId) ?? items.find((i) => /ncx/.test(i.type));
  const tocPath = navItem ? resolve(dir, navItem.href) : ncxItem ? resolve(dir, ncxItem.href) : '';
  // (A picture too big to be worth fetching for a thumbnail is left out.)
  if (coverPath && (z.entries.get(coverPath)?.csize ?? 0) > 6 * 1024 * 1024) coverPath = '';
  const later = [tocPath, coverPath].filter((p) => p && !first.has(p));
  const more = later.length ? await z.read(later) : new Map<string, Uint8Array>();
  const get = (p: string) => first.get(p) ?? more.get(p);
  const toc: { label: string; depth: number }[] = [];
  const tocBytes = tocPath ? get(tocPath) : undefined;
  if (tocBytes && navItem) {
    const d = xml(tocBytes, 'text/html');
    const nav = Array.from(d.querySelectorAll('nav')).find((n) => /toc/.test(n.getAttribute('epub:type') ?? n.getAttribute('type') ?? '')) ?? d.querySelector('nav');
    const walk = (ol: Element, depth: number) => { for (const li of Array.from(ol.children)) { if (li.tagName.toLowerCase() !== 'li') continue; const a = li.querySelector(':scope > a, :scope > span'); const label = textOf(a ?? undefined); if (label && toc.length < 400) toc.push({ label, depth }); const sub = li.querySelector(':scope > ol'); if (sub) walk(sub, depth + 1); } };
    const ol = nav?.querySelector('ol'); if (ol) walk(ol, 0);
  } else if (tocBytes) {
    const d = xml(tocBytes);
    const walk = (parent: Element, depth: number) => { for (const np of Array.from(parent.children)) { if (np.localName !== 'navPoint') continue; const label = textOf(byTag(np, 'text')[0]); if (label && toc.length < 400) toc.push({ label, depth }); walk(np, depth + 1); } };
    const map = byTag(d, 'navMap')[0]; if (map) walk(map, 0);
  }
  const coverBytes = coverPath ? get(coverPath) : undefined;
  const thumbUrl = coverBytes ? await thumb(coverBytes, cover?.type || 'image/jpeg').catch(() => undefined) : undefined;
  return { title: title || undefined, author: author || undefined, cover: thumbUrl, toc, at: Date.now() };
}

/* ---------- a PDF ---------- */
async function peekPdf(url: string, size?: number): Promise<Peek> {
  const head = await range(url, 0, 65535);
  const { loadPdfjs } = await import('../formats/pdf');
  const pdfjs = await loadPdfjs();
  let task: ReturnType<typeof pdfjs.getDocument>;
  const res = new URL('./pdfjs/', import.meta.url).href;
  const common = { cMapUrl: `${res}cmaps/`, cMapPacked: true, standardFontDataUrl: `${res}standard_fonts/`, wasmUrl: `${res}wasm/`, iccUrl: `${res}iccs/`, isEvalSupported: false, disableFontFace: false };
  if (head.whole) task = pdfjs.getDocument({ data: head.bytes, ...common });
  else {
    const total = head.total ?? size;
    if (!total) throw new SourceError('range', 'http');
    const transport = new pdfjs.PDFDataRangeTransport(total, head.bytes);
    transport.requestDataRange = (begin: number, end: number) => { void range(url, begin, end - 1).then((g) => transport.onDataRange(begin, g.whole ? g.bytes.subarray(begin, end) : g.bytes)).catch(() => undefined); };
    task = pdfjs.getDocument({ range: transport, disableAutoFetch: true, disableStream: true, rangeChunkSize: 65536, ...common });
  }
  const timer = setTimeout(() => void task.destroy(), 40000);
  try {
    const doc = await task.promise;
    const info = (await doc.getMetadata().catch(() => null))?.info as Record<string, string> | undefined;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 420 / vp.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    const cover = canvas.toDataURL('image/jpeg', 0.8);
    const toc: { label: string; depth: number }[] = [];
    const outline = await doc.getOutline().catch(() => null);
    const walk = (list: { title: string; items?: unknown[] }[] | null, depth: number) => { for (const o of list ?? []) { if (toc.length >= 400) return; const label = (o.title ?? '').replace(/\s+/g, ' ').trim(); if (label) toc.push({ label, depth }); walk((o.items ?? []) as { title: string; items?: unknown[] }[], depth + 1); } };
    walk(outline as { title: string; items?: unknown[] }[] | null, 0);
    const title = info?.Title?.trim();
    return { title: title && !/^(untitled|unknown|microsoft word|document)/i.test(title) ? title : undefined, author: info?.Author?.trim() || undefined, cover, toc, at: Date.now() };
  } finally { clearTimeout(timer); void task.destroy(); }
}

/* ---------- a picture made small ---------- */
async function thumb(bytes: Uint8Array, type: string, height = 420): Promise<string> {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: /svg/.test(type) ? 'image/svg+xml' : type });
  let src: CanvasImageSource; let w: number; let hgt: number; let free = () => {};
  try { const bmp = await createImageBitmap(blob); src = bmp; w = bmp.width; hgt = bmp.height; free = () => bmp.close(); }
  catch {
    const url = URL.createObjectURL(blob);
    const img = await new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('image')); i.src = url; });
    src = img; w = img.naturalWidth || 300; hgt = img.naturalHeight || 420; free = () => URL.revokeObjectURL(url);
  }
  try {
    const scale = Math.min(1, height / hgt);
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(hgt * scale));
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } finally { free(); }
}
/** A picture on a server (a folder's cover.jpg), made small. */
export async function thumbOf(url: string): Promise<string | undefined> {
  const key = `peek:img:${h32(url)}`;
  const had = mem.get(key) ?? (await db.getMeta<Peek>(key).catch(() => undefined));
  if (had) { mem.set(key, had); return had.cover; }
  const r = await request(url, { binary: true, quiet: true, retries: 1 });
  if (r.status >= 400) return undefined;
  const cover = await thumb(bytesOf(r.body), r.headers['content-type'] ?? 'image/jpeg').catch(() => undefined);
  const p: Peek = { cover, at: Date.now() }; mem.set(key, p); void keep(key, p);
  return cover;
}

/* ---------- kept on the device ---------- */
const mem = new Map<string, Peek>();
const running = new Map<string, Promise<Peek | null>>();
const INDEX = 'peek:index'; const LIMIT = 900;
let index: [string, number][] | null = null; let saving = 0;
async function keep(key: string, p: Peek): Promise<void> {
  try {
    await db.setMeta(key, p);
    index ??= (await db.getMeta<[string, number][]>(INDEX)) ?? [];
    index = index.filter(([k]) => k !== key); index.push([key, p.at]);
    if (index.length > LIMIT) { const drop = index.splice(0, index.length - LIMIT); for (const [k] of drop) void db.deleteMeta(k); }
    clearTimeout(saving); saving = window.setTimeout(() => void db.setMeta(INDEX, index), 1500);
  } catch { /* the cover is kept for this session only */ }
}

/** Something kept under `key` (on the device, and in memory for the session), when younger than `maxAge`. */
export async function recall(key: string, maxAge = Infinity): Promise<Peek | undefined> {
  const p = mem.get(key) ?? (await db.getMeta<Peek>(key).catch(() => undefined));
  if (!p || Date.now() - p.at > maxAge) return undefined;
  mem.set(key, p); return p;
}
export function remember(key: string, p: Peek): void { mem.set(key, p); void keep(key, p); }
/** What is already known in this session, at once (a page drawn again shows it without waiting). */
export const known = (key: string): Peek | undefined => mem.get(key);
export const peekKnown = (url: string, size?: number): Peek | undefined => mem.get(`peek:${h32(`${url}|${size ?? ''}`)}`);
export const keyOf = (s: string) => h32(s);

/** What a file on a server holds — cover, title, contents — for an EPUB or a PDF; kept once found. A file is
 *  known by its address and size (a new upload under the same name is looked at again). */
export function peekFile(url: string, ext: string, size?: number): Promise<Peek | null> {
  const key = `peek:${h32(`${url}|${size ?? ''}`)}`;
  const had = mem.get(key); if (had) return Promise.resolve(had);
  const run = running.get(key); if (run) return run;
  const p = (async (): Promise<Peek | null> => {
    const stored = await db.getMeta<Peek>(key).catch(() => undefined);
    if (stored) { mem.set(key, stored); return stored; }
    // (A server that sends whole files for ranges is not asked for its big ones.)
    if (wholeHosts.has(hostOf(url)) && (size ?? Infinity) > 6 * 1024 * 1024) return null;
    try {
      const peek = ext === 'epub' ? await peekEpub(url) : ext === 'pdf' ? await peekPdf(url, size) : null;
      if (!peek) return null;
      mem.set(key, peek); void keep(key, peek);
      return peek;
    } catch (e) {
      // (What cannot be read is remembered as such for this session, not retried on every scroll.)
      if ((e as SourceError).kind !== 'offline' && (e as SourceError).kind !== 'cloudflare') mem.set(key, { at: Date.now() });
      return null;
    }
  })();
  running.set(key, p); void p.finally(() => running.delete(key));
  return p;
}

/* ---------- a queue for what is on the screen ---------- */
type Job = { run: () => Promise<void>; started: boolean };
const queue: Job[] = []; let active = 0;
/** Run `fn` when a turn comes (three at a time, in the order asked); the returned function takes it back
 *  out of the queue if it has not started (an element scrolled away). */
export function schedule(fn: () => Promise<void>): () => void {
  const job: Job = { run: fn, started: false };
  queue.push(job); pump();
  return () => { if (!job.started) { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); } };
}
function pump(): void {
  while (active < 3 && queue.length) {
    const job = queue.shift()!; job.started = true; active++;
    void job.run().catch(() => undefined).finally(() => { active--; pump(); });
  }
}
