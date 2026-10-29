// A book on a server looked into without fetching it whole. An EPUB is a zip: its directory is read from the
// end of the file and the little files every EPUB puts first (the container, often the package) from its start
// — both at once — then only the pieces still wanted — the cover, the contents — each a range of the file, all
// at once. A PDF is opened by pdf.js over ranges too, for its first page and its outline.
//
// The covers are kept the way Mihon keeps its own: a small picture (a blob, WebP where the platform writes it)
// on the device, found again by the file's address and size, and a few hundred of them at hand in memory for
// the session; the ones on the screen are fetched first, those scrolled past are dropped from the queue.
import { request, bytesOf, bytesOfAsync } from './http';
import { db } from '../db';
import { SourceError } from './types';

export interface Peek { title?: string; author?: string; cover?: string; toc?: { label: string; depth: number }[]; at: number; count?: number; description?: string; publisher?: string; noCover?: boolean; /** a folder's: the file whose cover it shows */ ref?: string; /** a file that could not be read (for a minute) */ failed?: boolean }
/** A peek as kept on the device: its cover a picture of its own (a data URL in what older versions kept). */
type Stored = Omit<Peek, 'cover'> & { cover?: string; coverBlob?: Blob };

const h32 = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

/* ---------- ranges ---------- */
/** Hosts that answered a range with the whole file: their big files are not looked into. Hosts that answered
 *  one with a range: their files' start and end are asked for at once. */
const HOSTS = 'kr.rangeHosts';
const hostsKept = (() => { try { return JSON.parse(localStorage.getItem(HOSTS) ?? '{}') as { whole?: string[]; range?: string[] }; } catch { return {}; } })();
const wholeHosts = new Set<string>(hostsKept.whole ?? []);
const rangeHosts = new Set<string>(hostsKept.range ?? []);
/** (What a host does with ranges — its last answer — kept: the next session asks a host known to answer them
 *  for both ends of a file at once.) */
function learned(set: Set<string>, host: string): void {
  const other = set === wholeHosts ? rangeHosts : wholeHosts;
  if (set.has(host) && !other.has(host)) return;
  set.add(host); other.delete(host);
  try { localStorage.setItem(HOSTS, JSON.stringify({ whole: [...wholeHosts].slice(-50), range: [...rangeHosts].slice(-50) })); } catch { /* kept for the session */ }
}
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };
/** What went wrong lately when looking into files (for the reader to show when covers stay away). */
export const peekLog: string[] = [];
(globalThis as { krPeekLog?: string[] }).krPeekLog = peekLog; // (read by the tests)
export function logPeek(line: string): void { peekLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`); if (peekLog.length > 60) peekLog.shift(); }
/** A host whose files a static web server serves (an h5ai folder's): taken to answer ranges until it says
 *  otherwise — its very first files asked for both ends at once. */
export function assumeRanges(url: string): void { const h = hostOf(url); if (!wholeHosts.has(h)) rangeHosts.add(h); }

interface Got { bytes: Uint8Array; start: number; total?: number; whole: boolean }
/** Bytes `from`–`to` (inclusive) of a file, or its last `-from` bytes when `from` is negative. */
const extra = new Map<string, Record<string, string>>();
async function range(url: string, from: number, to?: number): Promise<Got> {
  const r = await request(url, { headers: { ...(extra.get(hostOf(url)) ?? {}), range: from < 0 ? `bytes=${from}` : `bytes=${from}-${to ?? ''}` }, binary: true, quiet: true, retries: 1 });
  if (r.status === 416) throw new SourceError('range', 'http', 416);
  if (r.status >= 400) throw new SourceError(`HTTP ${r.status}`, 'http', r.status);
  const bytes = await bytesOfAsync(r);
  if (r.status !== 206) {
    // (Whole: counted against the host only when the answer was really more than the piece asked for — a small
    // file answered whole for a range beyond its size is no sign.)
    const asked = from < 0 ? -from : to === undefined ? Infinity : to - from + 1;
    if (bytes.length > asked * 1.5 + 4096) learned(wholeHosts, hostOf(url));
    logPeek(`whole ${r.status} ${bytes.length}B for ${from}-${to ?? ''} ${url.split('/').pop()?.slice(0, 50)}`);
    return { bytes, start: 0, total: bytes.length, whole: true };
  }
  learned(rangeHosts, hostOf(url));
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(r.headers['content-range'] ?? '');
  return { bytes, start: m ? Number(m[1]) : Math.max(0, from), total: m && m[3] !== '*' ? Number(m[3]) : undefined, whole: false };
}

/* ---------- a zip read in pieces ---------- */
interface ZEntry { name: string; method: number; csize: number; usize: number; offset: number; crc: number; nameLen: number; extraLen: number }
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 0x100000000;
const utf8 = new TextDecoder();
const HEAD = 96 * 1024; const TAIL = 64 * 1024;

class RemoteZip {
  entries = new Map<string, ZEntry>();
  /** The whole file, when the server sent it whole (or it was small enough to come in the two ends). */
  private all: Uint8Array | null = null;
  /** The file's start, read with its end: the small files an EPUB puts first are taken from it. */
  private head: Uint8Array | null = null;
  /** The file's end (its directory, and the files just before it — where some makers put the package). */
  private tail: { bytes: Uint8Array; start: number } | null = null;
  constructor(readonly url: string) {}

  async open(): Promise<void> {
    // The end of the file (its directory) and its start, at once on a server known to answer ranges; the end
    // first on one not known yet (a server sending whole files would otherwise send this one twice).
    const both = rangeHosts.has(hostOf(this.url));
    const [tail, head] = both ? await Promise.all([range(this.url, -TAIL), range(this.url, 0, HEAD - 1).catch(() => null)]) : [await range(this.url, -TAIL), null];
    if (tail.whole) this.all = tail.bytes;
    else if (head?.whole) this.all = head.bytes;
    else { this.head = head?.bytes ?? (tail.start === 0 ? tail.bytes : null); this.tail = { bytes: tail.bytes, start: tail.start }; }
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

  /** An entry's bytes out of a buffer holding the file from `base` on, when it is all there. */
  private static take(buf: Uint8Array, base: number, e: ZEntry): Uint8Array | null {
    const at = e.offset - base;
    if (at < 0 || at + 30 > buf.length || u32(buf, at) !== 0x04034b50) return null;
    const start = at + 30 + u16(buf, at + 26) + u16(buf, at + 28);
    return start + e.csize <= buf.length ? buf.subarray(start, start + e.csize) : null;
  }
  private static async unpack(e: ZEntry, data: Uint8Array): Promise<Uint8Array> { return e.method === 8 ? inflateRaw(data, e) : data.slice(); }

  /** An entry's bytes from what is already here (the whole file, its start, its end), compressed as stored. */
  private here(e: ZEntry): Uint8Array | null {
    if (this.all) return RemoteZip.take(this.all, 0, e);
    return (this.head ? RemoteZip.take(this.head, 0, e) : null) ?? (this.tail ? RemoteZip.take(this.tail.bytes, this.tail.start, e) : null);
  }
  /** Whether an entry can be read without asking the server. */
  isHere(name: string): boolean { const e = this.entries.get(name); return !!e && !!this.here(e); }

  /** The named entries' bytes, uncompressed: those in the parts already read taken from them, the others
   *  fetched in ranges (neighbours together), all the ranges at once. */
  async read(names: string[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    const want: ZEntry[] = [];
    for (const n of new Set(names)) {
      const e = this.entries.get(n); if (!e) continue;
      const data = this.here(e);
      if (data) { try { out.set(n, await RemoteZip.unpack(e, data)); } catch { /* left out */ } }
      else if (!this.all) want.push(e);
    }
    if (!want.length) return out;
    want.sort((a, b) => a.offset - b.offset);
    // Groups of entries close to each other, each fetched as one range (with room for the local headers).
    const groups: ZEntry[][] = [];
    const end = (x: ZEntry) => x.offset + 30 + x.nameLen + x.extraLen + x.csize + 256;
    for (const e of want) {
      const g = groups[groups.length - 1];
      if (g && e.offset - end(g[g.length - 1]) < 96 * 1024 && end(e) - g[0].offset < 2 * 1024 * 1024) g.push(e); else groups.push([e]);
    }
    await Promise.all(groups.map(async (g) => {
      const from = g[0].offset; const to = g[g.length - 1].offset + 30 + g[g.length - 1].nameLen + g[g.length - 1].extraLen + g[g.length - 1].csize + 1024;
      const got = await range(this.url, from, to).catch(() => null); if (!got) return;
      if (got.whole) this.all = got.bytes;
      for (const e of g) {
        const data = RemoteZip.take(got.bytes, got.whole ? 0 : got.start, e);
        if (data) { try { out.set(e.name, await RemoteZip.unpack(e, data)); } catch { /* left out */ } }
      }
    }));
    return out;
  }
}

/** Raw DEFLATE: the browser's own stream when it has one, else JSZip over a zip of that one entry. */
async function inflateRaw(data: Uint8Array, e: ZEntry): Promise<Uint8Array> {
  if (data.length > 64 * 1024) {
    const copy = data.slice().buffer as ArrayBuffer;
    const job = inWorker({ op: 'inflate', bytes: copy }, [copy]);
    if (job) { try { const r = await job; if (r.bytes) return new Uint8Array(r.bytes); } catch { /* below */ } }
  }
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

interface Read { title?: string; author?: string; cover?: Blob; toc: { label: string; depth: number }[]; description?: string; publisher?: string }
async function peekEpub(url: string, noCover = false): Promise<Read> {
  const z = new RemoteZip(url);
  await z.open();
  // The container and the package (the one the directory has, read with it when it is not in the start
  // already), with the likeliest contents files beside it.
  const names = [...z.entries.keys()];
  const opfGuess = names.filter((n) => /\.opf$/i.test(n));
  const guessToc = names.filter((n) => /(^|\/)(toc\.ncx|nav\.xhtml|toc\.xhtml|nav\.html)$/i.test(n));
  const firstNames = ['META-INF/container.xml', ...(opfGuess.length === 1 ? opfGuess : []), ...guessToc];
  // (When the server must be asked for these anyway, the picture called the cover comes with them: the package
  // nearly always names that one, and a round trip is saved.)
  const asking = firstNames.some((n) => z.entries.has(n) && !z.isHere(n));
  // (Of several pictures called the cover, the smallest that is still a picture — not an icon — is read: a
  // thumbnail is what is wanted, and the big one costs a reader on mobile data a megabyte or two a book.)
  const coverGuess = asking && !noCover ? pickCover(names.filter((n) => /\.(jpe?g|png|webp|gif)$/i.test(n) && /cover/i.test(n.split('/').pop() ?? '')).map((n) => [n, z.entries.get(n)?.csize ?? 0] as [string, number])) : undefined;
  const first = await z.read([...firstNames, ...(coverGuess ? [coverGuess] : [])]);
  const container = first.get('META-INF/container.xml');
  let opfPath = container ? byTag(xml(container), 'rootfile')[0]?.getAttribute('full-path') ?? '' : '';
  if (!opfPath || !z.entries.has(opfPath)) opfPath = opfGuess[0] ?? '';
  if (!opfPath) throw new SourceError('notEpub', 'parse');
  if (!first.has(opfPath)) for (const [k, v] of await z.read([opfPath])) first.set(k, v);
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opfBytes = first.get(opfPath); if (!opfBytes) throw new SourceError('notEpub', 'parse');
  const opf = xml(opfBytes);
  const meta = byTag(opf, 'metadata')[0];
  const title = meta ? textOf(byTag(meta, 'title')[0]) : '';
  const author = meta ? byTag(meta, 'creator').map(textOf).filter(Boolean).slice(0, 2).join(', ') : '';
  // (The publisher's blurb, kept as plain text: the series' page shows it.)
  const blurb = meta ? (byTag(meta, 'description')[0]?.textContent ?? '') : '';
  const description = blurb ? new DOMParser().parseFromString(blurb, 'text/html').body.textContent?.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, 2000) : '';
  const publisher = meta ? textOf(byTag(meta, 'publisher')[0]) : '';
  const items = byTag(opf, 'item').map((i) => ({ id: i.getAttribute('id') ?? '', href: i.getAttribute('href') ?? '', type: i.getAttribute('media-type') ?? '', props: i.getAttribute('properties') ?? '' }));
  const isImg = (t: string) => /^image\//i.test(t);
  // The cover: the one the package names, else a picture called so, else the picture of the cover page.
  const coverId = byTag(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
  let cover = items.find((i) => /(^|\s)cover-image(\s|$)/.test(i.props)) ?? items.find((i) => i.id === coverId && isImg(i.type)) ?? items.find((i) => isImg(i.type) && /cover/i.test(`${i.id} ${i.href}`));
  let coverPath = cover ? resolve(dir, cover.href) : '';
  // The contents: the navigation document (EPUB 3), else the NCX (EPUB 2).
  const navItem = items.find((i) => /(^|\s)nav(\s|$)/.test(i.props));
  const ncxId = byTag(opf, 'spine')[0]?.getAttribute('toc');
  const ncxItem = items.find((i) => i.id === ncxId) ?? items.find((i) => /ncx/.test(i.type));
  const tocPath = navItem ? resolve(dir, navItem.href) : ncxItem ? resolve(dir, ncxItem.href) : '';
  // (No picture named the cover: the cover page's, read with the contents.)
  const coverPage = !coverPath && !noCover ? byTag(opf, 'reference').find((r) => r.getAttribute('type') === 'cover')?.getAttribute('href') ?? items.find((i) => /cover/i.test(i.id) && /html/.test(i.type))?.href : undefined;
  const pagePath = coverPage ? resolve(dir, coverPage) : '';
  // (A picture too big to be worth fetching for a thumbnail is left out; none at all when covers are off.)
  // (The package's cover too big for the connection: a smaller picture called the cover when there is one, else none.)
  if (coverPath && (z.entries.get(coverPath)?.csize ?? 0) > coverCap()) { const alt = pickCover(names.filter((n) => n !== coverPath && /\.(jpe?g|png|webp)$/i.test(n) && /cover/i.test(n.split('/').pop() ?? '')).map((n) => [n, z.entries.get(n)?.csize ?? 0] as [string, number])); if (alt) coverPath = alt; else logPeek(`skip cover: ${Math.round((z.entries.get(coverPath)?.csize ?? 0) / 1024)} KB over the cap · ${url.split('/').pop()?.slice(0, 60)}`); }
  if (noCover || (coverPath && (z.entries.get(coverPath)?.csize ?? 0) > coverCap())) coverPath = '';
  const later = [tocPath, coverPath, pagePath].filter((p) => p && !first.has(p));
  const more = later.length ? await z.read(later) : new Map<string, Uint8Array>();
  const get = (p: string) => first.get(p) ?? more.get(p);
  if (pagePath && !coverPath) {
    const html = get(pagePath);
    if (html) {
      const d = xml(html, 'text/html');
      const src = d.querySelector('img')?.getAttribute('src') ?? Array.from(d.getElementsByTagName('image'))[0]?.getAttribute('xlink:href') ?? Array.from(d.getElementsByTagName('image'))[0]?.getAttribute('href');
      if (src) {
        coverPath = resolve(pagePath.slice(0, pagePath.lastIndexOf('/') + 1), src); cover = { id: '', href: src, type: /\.png$/i.test(src) ? 'image/png' : 'image/jpeg', props: '' };
        if ((z.entries.get(coverPath)?.csize ?? 0) > coverCap()) coverPath = '';
        else if (coverPath) for (const [k, v] of await z.read([coverPath])) more.set(k, v);
      }
    }
  }
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
  const coverBlob = coverBytes ? await thumb(coverBytes, cover?.type || 'image/jpeg').catch(() => null) : null;
  return { title: title || undefined, author: author || undefined, cover: coverBlob ?? undefined, toc, description: description || undefined, publisher: publisher || undefined };
}

/* ---------- a PDF ---------- */
async function peekPdf(url: string, size?: number): Promise<Read> {
  const head = await range(url, 0, 65535);
  const { loadPdfjs, offscreen } = await import('../formats/pdf');
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
    // (The first page, or the second when the first is blank — a PDF made from a book often opens on one.)
    let cover: Blob | undefined;
    for (let n = 1; n <= Math.min(2, doc.numPages) && !cover; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, THUMB_H / vp.height) });
      const canvas = offscreen(document.createElement('canvas')); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      if (n < Math.min(2, doc.numPages) && blank(ctx, canvas.width, canvas.height)) continue;
      cover = (await toBlob(canvas)) ?? undefined;
    }
    const toc: { label: string; depth: number }[] = [];
    const outline = await doc.getOutline().catch(() => null);
    const walk = (list: { title: string; items?: unknown[] }[] | null, depth: number) => { for (const o of list ?? []) { if (toc.length >= 400) return; const label = (o.title ?? '').replace(/\s+/g, ' ').trim(); if (label) toc.push({ label, depth }); walk((o.items ?? []) as { title: string; items?: unknown[] }[], depth + 1); } };
    walk(outline as { title: string; items?: unknown[] }[] | null, 0);
    const title = info?.Title?.trim();
    return { title: title && !/^(untitled|unknown|microsoft word|document)/i.test(title) ? title : undefined, author: info?.Author?.trim() || undefined, cover, toc };
  } finally { clearTimeout(timer); void task.destroy(); }
}
/** A page drawn all (or nearly all) white. */
function blank(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    const d = ctx.getImageData(0, 0, w, h).data; let ink = 0; const step = 4 * 7;
    for (let i = 0; i < d.length; i += step) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) ink++;
    return ink / (d.length / step) < 0.01;
  } catch { return false; }
}

/** How big a cover picture may be before it is left unread: smaller on mobile data (or when the system asks
 *  to save data), so a shelf of covers does not eat the plan — Mihon's thumbnails are a few tens of kilobytes. */
export function coverCap(): number {
  const c = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean; effectiveType?: string } }).connection;
  if (c?.saveData || c?.type === 'cellular' || /^(slow-)?2g$/.test(c?.effectiveType ?? '')) return 700 * 1024;
  return 4 * 1024 * 1024;
}
/** Of the pictures called the cover, the one to read: the smallest that is a real picture (over 24 KB), else
 *  the biggest under the cap. */
function pickCover(list: [string, number][]): string | undefined {
  const cap = coverCap();
  const real = list.filter(([, n]) => n >= 24 * 1024 && n <= cap).sort((a, b) => a[1] - b[1]);
  if (real.length) return real[0][0];
  const under = list.filter(([, n]) => n <= cap).sort((a, b) => b[1] - a[1]);
  return under[0]?.[0];
}

/* ---------- a picture made small ---------- */
// (Sharp on a phone's screen at the largest a cover is drawn — 140 points wide, at three pixels a point — and
// a JPEG: written four times faster than a WebP, for a tenth more bytes.)
const THUMB_H = 540;
function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((ok) => canvas.toBlob((b) => ok(b), 'image/jpeg', 0.82));
}
/** The worker that makes covers small (and inflates zip entries) off the main thread, when the platform has
 *  pictures in workers (OffscreenCanvas); the shelf keeps scrolling smoothly while covers are decoded. */
// (Two or three of them on a phone with the cores for it: a shelf asks for six covers at once, and one worker
// decoding them one after another is what made the covers come slower and slower as a shelf was scrolled.)
let workers: { w: Worker; busy: number }[] | null | undefined;
let workSeq = 0; const workWaiting = new Map<number, { ok: (v: { blob?: Blob; bytes?: ArrayBuffer }) => void; fail: (e: Error) => void; at: { busy: number } }>();
function thumbWorker(): { w: Worker; busy: number } | null {
  if (workers === undefined) {
    workers = null;
    try {
      if (typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined') {
        const n = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency ?? 2) / 2)));
        workers = [];
        for (let i = 0; i < n; i++) {
          const w = new Worker(new URL('./thumbworker.js', import.meta.url), { type: 'module' });
          const slot = { w, busy: 0 };
          w.onmessage = (e: MessageEvent<{ id: number; blob?: Blob; bytes?: ArrayBuffer; error?: string }>) => { const x = workWaiting.get(e.data.id); if (!x) return; workWaiting.delete(e.data.id); x.at.busy--; if (e.data.error) x.fail(new Error(e.data.error)); else x.ok(e.data); };
          w.onerror = () => { for (const [id, x] of workWaiting) if (x.at === slot) { workWaiting.delete(id); x.fail(new Error('worker')); } w.terminate(); if (workers) workers = workers.filter((s) => s !== slot); if (!workers?.length) workers = null; };
          workers.push(slot);
        }
      }
    } catch { workers = null; }
  }
  if (!workers?.length) return null;
  return workers.reduce((a, b) => (b.busy < a.busy ? b : a));
}
function inWorker(msg: Record<string, unknown>, transfer: ArrayBuffer[]): Promise<{ blob?: Blob; bytes?: ArrayBuffer }> | null {
  const slot = thumbWorker(); if (!slot) return null;
  const id = ++workSeq; slot.busy++;
  return new Promise((ok, fail) => { workWaiting.set(id, { ok, fail, at: slot }); slot.w.postMessage({ id, ...msg }, transfer); });
}
async function thumb(bytes: Uint8Array, type: string, height = THUMB_H): Promise<Blob | null> {
  const mime = /svg/.test(type) ? 'image/svg+xml' : type;
  // Off the main thread where possible (not an SVG: workers draw no SVG).
  if (!/svg/.test(mime)) {
    const copy = bytes.slice().buffer as ArrayBuffer;
    const job = inWorker({ op: 'thumb', bytes: copy, type: mime, height, quality: 0.82 }, [copy]);
    if (job) { try { const r = await job; if (r.blob) return r.blob; } catch { /* drawn here below */ } }
  }
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
  let src: CanvasImageSource; let w: number; let hgt: number; let free = () => {};
  try {
    // (A very big picture decoded straight to the size shown — the memory a phone has; the others whole, which
    // decodes faster.)
    const bmp = bytes.length > 1536 * 1024 ? await createImageBitmap(blob, { resizeHeight: height, resizeQuality: 'high' }) : await createImageBitmap(blob);
    src = bmp; w = bmp.width; hgt = bmp.height; free = () => bmp.close();
  } catch {
    const url = URL.createObjectURL(blob);
    const img = await new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('image')); i.src = url; });
    src = img; w = img.naturalWidth || 300; hgt = img.naturalHeight || 420; free = () => URL.revokeObjectURL(url);
  }
  try {
    const scale = Math.min(1, height / hgt);
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(hgt * scale));
    const ctx = canvas.getContext('2d')!; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return await toBlob(canvas);
  } finally { free(); }
}
/** The key a picture on a server is kept under (a folder's peek points to it). */
export const imageKeyOf = (url: string) => `peek:img:${h32(url)}`;
/** A picture on a server (a folder's cover.jpg), made small. */
export async function thumbOf(url: string): Promise<string | undefined> {
  const key = imageKeyOf(url);
  const had = await recall(key); if (had) return had.cover;
  const r = await request(url, { binary: true, quiet: true, retries: 1 });
  if (r.status >= 400) return undefined;
  const blob = await thumb(await bytesOfAsync(r), r.headers['content-type'] ?? 'image/jpeg').catch(() => null);
  if (!blob) return undefined;
  return store(key, { at: Date.now() }, blob).cover;
}

/* ---------- kept: in memory for the session, on the device ---------- */
/** In memory: the last few hundred, the oldest let go (its picture's address with it). */
const MEM_MAX = 400;
const mem = new Map<string, Peek>();
const urls = new Map<string, string>();   // key → the address of its picture made from a blob, while in memory
function memGet(key: string): Peek | undefined { const p = mem.get(key); if (p) { mem.delete(key); mem.set(key, p); } return p; }
function memSet(key: string, p: Peek): void {
  mem.delete(key); mem.set(key, p);
  while (mem.size > MEM_MAX) {
    const old = mem.keys().next().value as string; mem.delete(old);
    const u = urls.get(old); if (u) { urls.delete(old); setTimeout(() => URL.revokeObjectURL(u), 60000); }
  }
}
/** A stored peek as used: its picture an address (one made for its blob, kept while it is in memory). */
function live(key: string, s: Stored): Peek {
  const { coverBlob, ...rest } = s;
  if (coverBlob) { let u = urls.get(key); if (!u) { u = URL.createObjectURL(coverBlob); urls.set(key, u); } return { ...rest, cover: u }; }
  return rest;
}
/** Keep a peek (its picture as a blob) on the device and in memory; returns it as used. */
function store(key: string, p: Omit<Peek, 'cover'>, cover?: Blob | null): Peek {
  const s: Stored = { ...p, ...(cover ? { coverBlob: cover } : {}) };
  const shown = live(key, s); memSet(key, shown); void keep(key, s);
  return shown;
}
const running = new Map<string, Promise<Peek | null>>();
const INDEX = 'peek:index'; const LIMIT = 4000;
let index: [string, number][] | null = null; let saving = 0;
async function keep(key: string, s: Stored): Promise<void> {
  try {
    try { await db.setMeta(key, s); }
    catch { if (!s.coverBlob) throw new Error('kept'); await db.setMeta(key, { ...s, coverBlob: undefined, cover: await dataUrl(s.coverBlob) }); }
    index ??= (await db.getMeta<[string, number][]>(INDEX)) ?? [];
    index = index.filter(([k]) => k !== key); index.push([key, s.at]);
    if (index.length > LIMIT) { const drop = index.splice(0, index.length - LIMIT); for (const [k] of drop) void db.deleteMeta(k); }
    clearTimeout(saving); saving = window.setTimeout(() => void db.setMeta(INDEX, index), 1500);
  } catch { /* the cover is kept for this session only */ }
}
const dataUrl = (b: Blob) => new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => fail(r.error); r.readAsDataURL(b); });

/** Something kept under `key` (in memory, else on the device), when younger than `maxAge`. A folder's peek
 *  that points at a file's gives that file's picture. */
export async function recall(key: string, maxAge = Infinity): Promise<Peek | undefined> {
  let p = memGet(key);
  if (!p) { const s = await db.getMeta<Stored>(key).catch(() => undefined); if (s) { p = live(key, s); memSet(key, p); } }
  if (!p || Date.now() - p.at > maxAge) return undefined;
  if (p.ref && !p.cover) { const f = await recall(p.ref); if (f?.cover) return { ...p, cover: f.cover, description: p.description ?? f.description }; }
  return p;
}
/** Keep `p` under `key`; a folder's that shows a file's cover (or a picture's) keeps only which (`ref`). A
 *  picture's address made for this session (blob:) is never kept on the device. */
export function remember(key: string, p: Peek): void {
  const { cover, ...rest } = p;
  memSet(key, rest.ref ? { ...rest } : p);
  void keep(key, rest.ref || !cover || cover.startsWith('blob:') ? rest : { ...rest, cover });
}
/** What is already known in this session, at once (a page drawn again shows it without waiting). */
export const known = (key: string): Peek | undefined => {
  const p = memGet(key); if (!p) return undefined;
  if (p.ref && !p.cover) { const f = memGet(p.ref); return f?.cover ? { ...p, cover: f.cover, description: p.description ?? f.description } : undefined; }
  return p;
};
const fileKey = (url: string, size?: number) => `peek:${h32(`${url}|${size ?? ''}`)}`;
export const peekKnown = (url: string, size?: number, noCover = false): Peek | undefined => { const p = memGet(fileKey(url, size)); return p && !p.failed && (!p.noCover || noCover) ? p : undefined; };
export const keyOf = (s: string) => h32(s);
export const peekKeyOf = fileKey;

/** What a file on a server holds — cover, title, contents — for an EPUB or a PDF; kept once found. A file is
 *  known by its address and size (a new upload under the same name is looked at again). */
export function peekFile(url: string, ext: string, size?: number, opts: { noCover?: boolean; headers?: Record<string, string> } = {}): Promise<Peek | null> {
  const key = fileKey(url, size);
  if (opts.headers) extra.set(hostOf(url), opts.headers);
  // (One read without its cover — covers were off — is read again when they are on.)
  const usable = (p: Peek | undefined) => !!p && (!p.noCover || !!opts.noCover) && !p.failed;
  const had = memGet(key); if (usable(had)) return Promise.resolve(had!);
  if (had?.failed) return Promise.resolve(null);
  const run = running.get(key); if (run) return run;
  const p = (async (): Promise<Peek | null> => {
    const stored = await recall(key);
    if (usable(stored)) return stored!;
    // (A server that sends whole files for ranges is not asked for its big ones.)
    if (wholeHosts.has(hostOf(url)) && (size ?? Infinity) > 6 * 1024 * 1024) { logPeek(`skip: host sends whole files · ${url.split('/').pop()?.slice(0, 60)}`); return null; }
    try {
      const got = ext === 'epub' ? await peekEpub(url, !!opts.noCover) : ext === 'pdf' ? (opts.noCover ? null : await peekPdf(url, size)) : null;
      if (!got) return null;
      const { cover, ...rest } = got;
      logPeek(`ok ${ext} cover=${cover ? 'y' : 'n'} toc=${rest.toc?.length ?? 0} desc=${rest.description?.length ?? 0} title=${rest.title ? 'y' : 'n'} · ${url.split('/').pop()?.slice(0, 60)}`);
      return store(key, { ...rest, at: Date.now(), noCover: opts.noCover || undefined }, cover);
    } catch (e) {
      const err = e as SourceError;
      logPeek(`fail ${err.kind ?? ''} ${err.status ?? ''} ${err.message?.slice(0, 80)} · ${url.split('/').pop()?.slice(0, 60)}`);
      // (What cannot be read is set aside for a minute, not asked again on every scroll — and then tried once more.)
      if (err.kind !== 'offline' && err.kind !== 'cloudflare' && err.kind !== 'blocked') { memSet(key, { at: Date.now(), failed: true } as Peek); setTimeout(() => { if (mem.get(key)?.failed) mem.delete(key); }, 60000); }
      return null;
    }
  })();
  running.set(key, p); void p.finally(() => running.delete(key));
  return p;
}

/* ---------- a queue for what is on the screen ---------- */
type Job = { run: () => Promise<void>; started: boolean };
const queue: Job[] = []; let active = 0;
const AT_ONCE = 6;
/** How long a job keeps its turn: one still waiting after that (a slow server, a check on the way) goes on, but
 *  out of the count, so the covers behind it do not all wait for it. */
const HOLD = 12000;
/** Run `fn` when a turn comes (six at a time; one on the screen now before those only near it); the returned
 *  function takes it back out of the queue if it has not started (an element scrolled away), and its `now()`
 *  moves it to the front (an element come onto the screen while it waited). */
export function schedule(fn: () => Promise<void>, now = false): (() => void) & { now(): void } {
  const job: Job = { run: fn, started: false };
  if (now) queue.unshift(job); else queue.push(job);
  pump();
  const cancel = (() => { if (!job.started) { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); } }) as (() => void) & { now(): void };
  cancel.now = () => { if (job.started) return; const i = queue.indexOf(job); if (i > 0) { queue.splice(i, 1); queue.unshift(job); } };
  return cancel;
}
function pump(): void {
  while (active < AT_ONCE && queue.length) {
    const job = queue.shift()!; job.started = true; active++;
    let released = false;
    const release = () => { if (released) return; released = true; active--; pump(); };
    const timer = setTimeout(release, HOLD);
    void job.run().catch(() => undefined).finally(() => { clearTimeout(timer); release(); });
  }
}
