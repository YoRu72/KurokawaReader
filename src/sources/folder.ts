// A web folder as a source: the page a server makes for a folder that has no page of its own — the "Index
// of" listings of Apache, nginx, lighttpd, Caddy, Python's http.server, h5ai and the like, or their JSON
// form — with files and folders in it. The reader adds one by its address; its folders are browsed like
// shelves. A folder of series (OTL's 761) is a shelf of covers, each its first volume's; a series' folder
// is the series' page — its blurb, then a row per volume with its cover and contents, the editions of one
// volume (a store's EPUB, a premium one, a scan) together in one row, fetched one at a time or all at once.
// An index of every file, made once (one request to an h5ai server, else a walk through the folders) and
// kept, lets the whole folder be searched at once, filtered by publisher, and shows what is new.
import { request, fetchBytes, pool, useBrowserFor } from './http';
import type { HttpResult } from '../net';
import { t, formatBytes, countVolumes, countSeries, daysAgo, localDigits } from '../i18n';
import { SourceError, type Source, type SourceBook, type SourceDetails, type SourceFile, type SourcePage, type FilterValues, type SourceFilter, type SourceTag } from './types';
import { peekFile, peekKnown, thumbOf, recall, remember, known, keyOf, peekKeyOf, imageKeyOf, assumeRanges, type Peek } from './peek';
import { db } from '../db';
import type { Repo } from './repos';

export interface DirEntry { name: string; url: string; dir: boolean; size?: number; date?: string; ext?: string; time?: number }

/** The files the reader opens, by extension: the label shown and the MIME type the library is given. */
const BOOK_EXT: Record<string, [string, string]> = {
  epub: ['EPUB', 'application/epub+zip'], pdf: ['PDF', 'application/pdf'],
  mobi: ['Kindle', 'application/x-mobipocket-ebook'], azw: ['Kindle', 'application/x-mobipocket-ebook'], azw3: ['Kindle', 'application/x-mobipocket-ebook'], kf8: ['Kindle', 'application/x-mobipocket-ebook'], prc: ['Kindle', 'application/x-mobipocket-ebook'],
  fb2: ['FB2', 'application/x-fictionbook+xml'], cbz: ['CBZ', 'application/vnd.comicbook+zip'], djvu: ['DjVu', 'image/vnd.djvu'],
  txt: ['Text', 'text/plain'], md: ['Markdown', 'text/markdown'], html: ['HTML', 'text/html'], htm: ['HTML', 'text/html'], xhtml: ['HTML', 'application/xhtml+xml'],
  docx: ['Word', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], odt: ['ODT', 'application/vnd.oasis.opendocument.text'], rtf: ['RTF', 'application/rtf'],
  pptx: ['PowerPoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'], xlsx: ['Excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], csv: ['CSV', 'text/csv'],
  m4b: ['M4B (audiobook)', 'audio/mp4'], mp3: ['MP3 (audio)', 'audio/mpeg'], m4a: ['M4A (audio)', 'audio/mp4'], ogg: ['OGG (audio)', 'audio/ogg'], opus: ['Opus (audio)', 'audio/ogg'], flac: ['FLAC (audio)', 'audio/flac'],
};
export const isBook = (e: { dir?: boolean; ext?: string }): boolean => !e.dir && !!e.ext && e.ext in BOOK_EXT;
const isImage = (e: DirEntry): boolean => !e.dir && /^(jpe?g|png|webp|gif)$/.test(e.ext ?? '');
const withSlash = (u: string) => (u.endsWith('/') ? u : u + '/');
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const num = (v: unknown): number | undefined => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 ? n : undefined; };
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const stamp = (ms: number) => { const d = new Date(ms); return Number.isNaN(d.getTime()) ? undefined : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const msOf = (d?: string): number | undefined => { if (!d) return undefined; const x = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(d) ? d.replace(' ', 'T') : d); return Number.isNaN(x) ? undefined : x; };
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** A size as a listing writes it: "1.2M", "345K", "12 MB", "1073741824", "12345 bytes"; "-" is none. */
export function sizeIn(s: string): number | undefined {
  const x = s.replace(/\s+/g, ' ').trim(); if (!x) return undefined;
  const m = /(\d+(?:[.,]\d+)?)\s*([KMGT])(?:i?B)?(?![\w-])/i.exec(x);
  if (m) return Math.round(Number(m[1].replace(',', '.')) * 1024 ** ('KMGT'.indexOf(m[2].toUpperCase()) + 1));
  const b = /(\d+)\s*(?:bytes?|B)(?![\w-])/.exec(x); if (b) return Number(b[1]);
  // (nginx and Caddy write bytes as a bare number; a year is followed by a dash or a slash, a time by a colon.)
  const bare = /(?:^|\s)(\d{1,15})(?=\s|$)/g; let last: string | null = null; let y: RegExpExecArray | null;
  while ((y = bare.exec(x))) last = y[1];
  return last ? Number(last) : undefined;
}
/** A date as a listing writes it, kept as written. */
export function dateIn(s: string): string | undefined {
  const m = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|\d{1,2}-[A-Za-z]{3}-\d{4}(?: \d{2}:\d{2})?|\d{1,2}\/\d{1,2}\/\d{4}(?: \d{1,2}:\d{2}(?: ?[AP]M)?)?/.exec(s);
  return m ? m[0] : undefined;
}

/** The entries of a folder's listing page (or JSON): the folder's direct children only, each once; the
 *  parent, the sort links, anything on another site or deeper down left out. */
export function parseListing(base: string, body: string, type = ''): DirEntry[] {
  let root: URL; try { root = new URL(base); } catch { return []; }
  root.pathname = withSlash(root.pathname); root.search = ''; root.hash = '';
  const rootPath = dec(root.pathname);
  const out: DirEntry[] = []; const seen = new Set<string>();
  const push = (href: string, dirHint: boolean, size?: number, date?: string, time?: number) => {
    let u: URL; try { u = new URL(href, root); } catch { return; }
    if (u.origin !== root.origin || u.search) return;
    const path = dec(u.pathname);
    if (!path.startsWith(rootPath)) return;
    const rest = path.slice(rootPath.length); if (!rest) return;
    const segs = rest.split('/').filter(Boolean); if (segs.length !== 1) return;
    const dir = dirHint || rest.endsWith('/');
    const name = segs[0];
    if (!name || name === '.' || name === '..' || /^[?#]/.test(name) || /^_h5ai$/i.test(name)) return;
    const key = `${dir ? 'd' : 'f'}:${name}`; if (seen.has(key)) return; seen.add(key);
    // (The child's address keeps the server's own spelling of its name.)
    const enc = u.pathname.replace(/\/+$/, '').split('/').pop() ?? encodeURIComponent(name);
    const ext = dir ? undefined : (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? '').toLowerCase();
    out.push({ name, url: `${root.origin}${root.pathname}${enc}${dir ? '/' : ''}`, dir, size: dir ? undefined : size, date, ext, time: time ?? msOf(date) });
  };
  const text = body.trim();
  // The JSON forms: nginx's autoindex_format json ([{name,type,mtime,size}]), Caddy's ([{name,size,url,mod_time,is_dir}]),
  // h5ai's API ({items:[{href,time,size}]}, the folders above it included), a few others.
  if (/json/i.test(type) || /^[[{]/.test(text)) {
    try {
      const j = JSON.parse(text) as unknown;
      const arr = Array.isArray(j) ? j : j && typeof j === 'object' ? ((j as Record<string, unknown>).items ?? (j as Record<string, unknown>).search ?? (j as Record<string, unknown>).files ?? (j as Record<string, unknown>).entries) : null;
      if (Array.isArray(arr)) {
        for (const e of arr as Record<string, unknown>[]) {
          const href = str(e.href);
          if (href) { const ms = typeof e.time === 'number' ? e.time : undefined; push(href, href.endsWith('/'), num(e.size), ms ? stamp(ms) : str(e.time), ms); continue; }
          const name = str(e.name) ?? str(e.path) ?? ''; if (!name) continue;
          const dir = e.type === 'directory' || e.type === 'dir' || e.type === 'folder' || e.is_dir === true || e.isDir === true || e.dir === true || e.directory === true || name.endsWith('/');
          push(encodeURIComponent(name.replace(/\/$/, '')) + (dir ? '/' : ''), dir, num(e.size), str(e.mtime) ?? str(e.mod_time) ?? str(e.modified) ?? str(e.date) ?? str(e.time));
        }
        return out;
      }
    } catch { /* a page, then */ }
  }
  const doc = new DOMParser().parseFromString(body, 'text/html');
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? ''; if (/^(mailto:|javascript:|tel:|#|\?)/i.test(href)) continue;
    const label = (a.textContent ?? '').trim();
    // The size and the date, from the row the link sits in: a table's other cells, or what follows the link on its line.
    let tail = ''; let size: number | undefined;
    const row = a.closest('tr');
    if (row) {
      tail = Array.from(row.cells).filter((c) => !c.contains(a)).map((c) => c.textContent ?? '').join(' ');
      // (h5ai's table writes sizes in thousands of bytes: "1234 KB".)
      const fb = row.querySelector('td.fb-s')?.textContent?.trim(); if (fb) { const k = /^(\d+)\s*KB$/i.exec(fb); if (k) size = Number(k[1]) * 1000; }
    } else {
      let n: Node | null = a.nextSibling;
      while (n && n.nodeName !== 'A' && n.nodeName !== 'BR' && n.nodeName !== 'LI' && n.nodeName !== 'TR' && n.nodeName !== 'DIV' && n.nodeName !== 'P') { tail += n.textContent ?? ''; if (tail.includes('\n')) break; n = n.nextSibling; }
      tail = tail.split('\n')[0];
    }
    push(href, label.endsWith('/'), size ?? sizeIn(tail), dateIn(tail));
  }
  return out;
}

/** Whether a page is a folder's listing rather than a site's page: it is h5ai's, or it has a book among
 *  its direct children, or calls itself an index, or is made mostly of links to its own direct children. */
export function isListing(url: string, body: string, type = ''): boolean {
  if (isH5ai(body)) return true;
  const entries = parseListing(url, body, type);
  if (!entries.length) return false;
  if (entries.some(isBook)) return true;
  if (/json/i.test(type)) return entries.length > 0;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1] ?? '';
  if (/index of|directory listing|directory of|listing of|فهرس|محتويات المجلد/i.test(title) || /<h1[^>]*>\s*index of/i.test(body)) return true;
  const links = (body.match(/<a\s[^>]*href=/gi) ?? []).length;
  return entries.length >= 3 && entries.length >= links * 0.6;
}
/** h5ai's page: its scripts and styles under /_h5ai/, its name in the title or the footer. */
export const isH5ai = (body: string): boolean => /\/_h5ai\/|powered by h5ai|larsjung\.de\/h5ai/i.test(body);

/** The last part of a folder's address as its name ("Novels" for …/Novels/), else its host. */
export function folderName(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) return dec(seg).replace(/[_+]/g, ' ').trim() || u.host;
    return u.host;
  } catch { return url; }
}

/* ---------- a volume's name read ---------- */
/** What a file's name says: "Spice and Wolf - Volume 14 [Yen Press]{v2}[Kobo].epub" is the series "Spice and
 *  Wolf", volume 14, published by Yen Press, the Kobo edition, its second version. The tags in brackets are
 *  the publisher (the first that is not a store or a scan) and the edition (the store, "Premium", a scan
 *  and its scanner). */
export interface VolName { series: string; num?: number; sub?: string; publisher?: string; editions: string[]; version: number; ext: string; base: string; /** the number said to be a volume's ("Volume", "Vol.", "v01", "#", "المجلد"), not just a number at the end */ marked?: boolean }
const EDITION_TAG = /^(kobo|premium|kindle(?:[- ]?(?:kobo|hq))?|kindlehq|google(?: ?play)?|bookwalker|ibooks|apple(?: books)?|nook|prepub|pre-?pub|ocr(?:[_ -].*)?|anon|retail|hq|lq|scans?|fan[- ]?tl|mtl|web|digital|epub|pdf|v\d+)$/i;
export function parseName(name: string): VolName {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? '').toLowerCase();
  const raw = ext ? name.slice(0, -(ext.length + 1)) : name;
  const tags = [...raw.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim()).filter(Boolean);
  const version = Number(/\{v(\d+)\}/i.exec(raw)?.[1] ?? 1);
  const base = raw.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim().replace(/[\s\-–—:,]+$/, '');
  let publisher: string | undefined; const editions: string[] = [];
  for (const tg of tags) { if (!EDITION_TAG.test(tg) && !publisher) publisher = tg; else editions.push(tg.replace(/_/g, ' ')); }
  let series = base; let n: number | undefined; let sub: string | undefined; let marked = false;
  const vm = /^(.*?)[\s\-–—:,]*(?:\b(?:volume|vol\.?|v|book|tome)|#)\s*(\d+(?:\.\d+)?)(?!\d)(?:\s*[-–—:]\s*(.+))?$/i.exec(base)
    ?? /^(.*?)[\s\-–—:,]*\bpart\s*(\d+(?:\.\d+)?)(?!\d)(?:\s*[-–—:]\s*(.+))?$/i.exec(base);
  const m = vm ?? /^(.*?)[\s\-–—:,]+(\d{1,3}(?:\.\d)?)(?:\s*[-–—:]\s*(.+))?$/.exec(base);
  if (m && m[1].trim()) { series = m[1].trim(); n = Number(m[2]); sub = m[3]?.trim() || undefined; marked = !!vm; }
  else {
    const a = /^(.*?)[\s\-–—:،]*(?:المجلد|الجزء|مجلد|جزء)\s*([0-9٠-٩]+)/.exec(base);
    if (a && a[1].trim()) { series = a[1].trim(); n = Number(a[2].replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))); marked = true; }
  }
  return { series, num: n, sub, publisher, editions, version, ext, base, marked };
}
/** The number of a volume in its name (see parseName), for any file. */
export function volumeNumber(name: string): number | undefined { return parseName(name).num; }
/** How good an edition is to read, lowest first: J-Novel Club's premium EPUBs, then the stores', a scan last. */
export function editionRank(v: VolName, storeFirst = false): number {
  const e = v.editions.join(' ').toLowerCase();
  if (/\bocr\b|\banon\b|scan/.test(e)) return 12;
  if (/pre-?pub/.test(e)) return 11;
  if (/premium/.test(e)) return storeFirst ? 1.5 : 0;
  if (/kindle[- ]?kobo/.test(e)) return 2;
  if (/kobo/.test(e)) return 1;
  if (/kindle ?hq/.test(e)) return 3;
  if (/google/.test(e)) return 4;
  if (/kindle/.test(e)) return 5;
  if (/bookwalker/.test(e)) return 6;
  if (/ibooks|apple/.test(e)) return 7;
  return v.editions.length ? 9 : 8;
}
const isScan = (v: VolName) => editionRank(v) === 12;
/** An edition's short name: its tags ("Premium", "Kobo", "OCR · Ozymandias"), else its publisher, else the format. */
const editionLabel = (v: VolName, withExt: boolean) => [v.editions.join(' · ') || v.publisher || '', v.version > 1 ? `v${v.version}` : '', withExt ? v.ext.toUpperCase() : ''].filter(Boolean).join(' · ') || v.ext.toUpperCase();
/** Volumes in reading order: by their number where both have one, else by name. */
export function volumeOrder(a: DirEntry, b: DirEntry): number {
  const x = volumeNumber(a.name), y = volumeNumber(b.name);
  if (x !== undefined && y !== undefined && x !== y) return x - y;
  if ((x === undefined) !== (y === undefined)) return x === undefined ? 1 : -1;
  return natural(a.name, b.name);
}

/** The volumes of a folder: a group per volume (its editions together), in reading order. In a group the
 *  edition the reader would rather read comes first: not a scan, in the format preferred (EPUB, unless PDF
 *  was chosen), the better edition (editionRank), the newer version. */
interface Vol { e: DirEntry; v: VolName; rel: string }
interface VolGroup { key: string; num?: number; items: Vol[] }
const formatRank = (ext: string, first: string) => (ext === first ? 0 : ext === 'epub' ? 1 : ext === 'pdf' ? 2 : 3);
function groupVolumes(list: Vol[], storeFirst: boolean, scans: boolean, format = 'epub'): VolGroup[] {
  const groups = new Map<string, VolGroup>();
  for (const it of list) {
    const key = it.v.num !== undefined ? `n${it.v.num}|${(it.v.sub ?? '').toLowerCase().replace(/\W+/g, '')}` : `t${it.v.base.toLowerCase().replace(/\W+/g, '')}`;
    let g = groups.get(key); if (!g) { g = { key, num: it.v.num, items: [] }; groups.set(key, g); }
    g.items.push(it);
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.items.sort((a, b) => Number(isScan(a.v)) - Number(isScan(b.v)) || formatRank(a.v.ext, format) - formatRank(b.v.ext, format) || editionRank(a.v, storeFirst) - editionRank(b.v, storeFirst) || b.v.version - a.v.version || natural(a.e.name, b.e.name));
    // (Scans hidden unless a volume has nothing else.)
    if (!scans && g.items.some((x) => !isScan(x.v))) g.items = g.items.filter((x) => !isScan(x.v));
  }
  // (Volumes with the same number but different subtitles — "Volume 01.5 - Part 1/2" — keep their order by name.)
  return out.sort((a, b) => (a.num !== undefined && b.num !== undefined ? a.num - b.num || natural(a.items[0].e.name, b.items[0].e.name) : a.num !== undefined ? -1 : b.num !== undefined ? 1 : natural(a.items[0].e.name, b.items[0].e.name)));
}

/** The edition whose cover a volume shows: its first EPUB (a cover picture of its own), else its first PDF
 *  (the first page drawn). */
const coverItem = (g: VolGroup): Vol | undefined => g.items.find((x) => x.v.ext === 'epub') ?? g.items.find((x) => x.v.ext === 'pdf');
/** The cover of a run of volumes: the first volume's (the next one's only when the first has neither). */
const firstCover = (groups: VolGroup[]): Vol | undefined => { for (const g of groups) { const c = coverItem(g); if (c) return c; } return undefined; };

/* ---------- listings, fetched and kept a while ---------- */
const listings = new Map<string, { at: number; entries: DirEntry[] }>();
const KEEP = 15 * 60000;
export function forgetListings(prefix?: string): void { for (const k of [...listings.keys()]) if (!prefix || k.startsWith(prefix)) listings.delete(k); }
const originOf = (u: string) => { try { return new URL(u).origin; } catch { return u; } };
/** What no other way round will mend: a check, a refusal, the network gone, a web page barred from the site. */
const fatal = (e: unknown): boolean => ['cloudflare', 'blocked', 'offline', 'cors', 'rate'].includes((e as SourceError)?.kind ?? '');
const extOf = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? '').toLowerCase();

/** Why a folder could not be read, said plainly: the status, the server, what the page was instead. */
function notAListing(url: string, r: HttpResult): SourceError {
  const title = /<title[^>]*>([^<]{0,80})/i.exec(r.body)?.[1]?.trim();
  return new SourceError(t('folderNotListing', { status: String(r.status), where: dec(url.replace(/^https?:\/\//, '')).slice(0, 90), what: title ? t('folderPageTitled', { title }) : t('folderEmptyPage') }), 'parse', r.status);
}
/** A folder h5ai leaves to a page of its own (its index.html): no list of files, the site's page instead. */
function ownPage(url: string, r: HttpResult): SourceError {
  const title = /<title[^>]*>([^<]{0,80})/i.exec(r.body)?.[1]?.trim();
  return new SourceError(t('folderOwnPage', { what: title ? ` (“${title}”)` : '' }), 'parse', r.status, url);
}
function refusal(r: HttpResult): SourceError {
  const title = /<title[^>]*>([^<]{0,80})/i.exec(r.body)?.[1]?.trim();
  const server = r.headers.server ? ` · ${r.headers.server}` : '';
  return new SourceError(t('folderRefused', { status: String(r.status), what: `${server}${title ? ` · “${title}”` : ''}` }), 'auth', r.status);
}

/** A question to h5ai's API: JSON POSTed to the folder's own address — as h5ai's own page asks it — else to
 *  the site's root (as its downloaders do). The answer's JSON, or null when the site gave none (`why` then
 *  says what it gave instead). A check, a refusal or a lost network is thrown. */
async function h5aiApi<T>(folder: string, body: Record<string, unknown>, quiet: boolean, why: { error?: SourceError } = {}): Promise<T | null> {
  const page = withSlash(folder.replace(/[?#].*$/, ''));
  for (const target of [...new Set([`${page}?`, `${originOf(page)}/?`])]) {
    let r: HttpResult;
    try { r = await request(target, { method: 'POST', headers: { 'content-type': 'application/json;charset=utf-8', accept: 'application/json, text/javascript, */*; q=0.01', referer: page, 'x-requested-with': 'XMLHttpRequest' }, body: JSON.stringify(body), quiet, retries: 1 }); }
    catch (e) { if (fatal(e)) throw e; why.error = e as SourceError; continue; }
    if (r.status === 429) throw new SourceError('rate', 'rate', 429);
    if (r.status < 400 && /^\s*[{[]/.test(r.body)) { try { return JSON.parse(r.body) as T; } catch { /* not JSON after all */ } }
    why.error = r.status === 401 || r.status === 403 ? refusal(r) : notAListing(target, r);
  }
  return null;
}

/** The entries of a folder, from the site (or from a listing fetched a few minutes ago): h5ai's API first on an
 *  h5ai server (sizes to the byte, times to the second), else the page's table, else the API after all; folders
 *  first, then the names in order. A folder h5ai answers nothing for — one with a page of its own (index.html),
 *  which h5ai leaves alone — is read from that page; one whose page lists nothing says so. */
export async function listFolder(url: string, quiet = false, h5ai = false): Promise<DirEntry[]> {
  const key = withSlash(url);
  const had = listings.get(key); if (had && Date.now() - had.at < KEEP) return had.entries;
  let entries: DirEntry[] | null = null; let failure: SourceError | null = null; let apiEmpty = false;
  const fromApi = async (): Promise<DirEntry[] | null> => {
    const why: { error?: SourceError } = {};
    const j = await h5aiApi<{ items?: unknown }>(key, { action: 'get', items: { href: new URL(key).pathname, what: 1 } }, quiet, why);
    if (j && Array.isArray(j.items)) return parseListing(key, JSON.stringify({ items: j.items }), 'application/json');
    if (why.error) failure = why.error;
    return null;
  };
  if (h5ai) { entries = await fromApi(); if (entries && !entries.length) { entries = null; apiEmpty = true; } }
  if (!entries) {
    const r = await request(key, { headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }, quiet, retries: 1 });
    if (r.status === 429) throw new SourceError('rate', 'rate', 429);
    if (r.status < 400) {
      const base = r.url && /^https?:/.test(r.url) ? withSlash(r.url.replace(/[?#].*$/, '')) : key;
      const type = r.headers['content-type'] ?? '';
      const found = parseListing(base, r.body, type);
      const byH5ai = isH5ai(r.body);
      if (found.length) { entries = found; failure = null; }
      // (An h5ai page drawing its list by script, with no table: its API, once more, for a server not known as h5ai.)
      else if (byH5ai && !h5ai) { const api = await fromApi(); if (api) { entries = api; failure = null; } }
      if (!entries) {
        if (byH5ai) { if (apiEmpty || !failure) { entries = []; failure = null; } }   // h5ai's own page, nothing in it: empty indeed (else its API's error)
        else if (apiEmpty) failure = ownPage(key, r);                                 // h5ai left it to a page of its own
        else if (isListing(base, r.body, type)) { entries = []; failure = null; }
        else failure = failure ?? notAListing(key, r);
      }
    } else failure = r.status === 401 || r.status === 403 ? refusal(r) : apiEmpty ? ownPage(key, r) : notAListing(key, r);
  }
  if (!entries) throw failure ?? new SourceError('parse', 'parse');
  entries.sort((a, b) => (a.dir === b.dir ? natural(a.name, b.name) : a.dir ? -1 : 1));
  listings.set(key, { at: Date.now(), entries });
  return entries;
}

/* ---------- the index of every file ---------- */
interface IndexFile { p: string; s?: number; t?: number }
/** The index: every book file under the folder (its path from the root, size, time) and every folder; the
 *  folders h5ai leaves to a page of their own (`unmanaged`), whose files it does not list. */
interface FolderIndex { v: 2; at: number; how: 'search' | 'tree' | 'walk'; complete: boolean; files: IndexFile[]; dirs: string[]; unmanaged?: string[] }
/** A series as the index knows it. */
interface SeriesInfo { rel: string; name: string; time?: number; files: { rel: string; name: string; v: VolName; size?: number; time?: number; sub: string }[]; volumes: number; publishers: string[] }
const indexes = new Map<string, FolderIndex>();
const derived = new WeakMap<FolderIndex, Map<string, SeriesInfo>>();
const INDEX_KEY = (repo: Repo) => `dir:index:${repo.key}`;
/** The index kept for a folder, if any — one with nothing in it (a site that could not be read when it was made,
 *  in an earlier version) counts as none, and is dropped. */
export async function loadIndex(repo: Repo): Promise<FolderIndex | null> {
  const had = indexes.get(repo.key); if (had) return had;
  const stored = await db.getMeta<FolderIndex>(INDEX_KEY(repo)).catch(() => undefined);
  if (stored?.v === 2 && (stored.files.length || stored.dirs.length)) { indexes.set(repo.key, stored); return stored; }
  if (stored) await db.deleteMeta(INDEX_KEY(repo)).catch(() => undefined);
  return null;
}
/** The index's files by series (the root's folders), each with its volumes counted and its publishers. */
function seriesOf(idx: FolderIndex): Map<string, SeriesInfo> {
  const had = derived.get(idx); if (had) return had;
  const out = new Map<string, SeriesInfo>();
  const add = (rel: string) => { let s = out.get(rel); if (!s) { s = { rel, name: dec(rel), files: [], volumes: 0, publishers: [] }; out.set(rel, s); } return s; };
  for (const d of idx.dirs) { const top = d.split('/')[0]; if (top) add(top); }
  for (const f of idx.files) {
    const parts = f.p.split('/'); if (parts.length < 2) continue;
    const s = add(parts[0]);
    const name = dec(parts[parts.length - 1]);
    s.files.push({ rel: f.p, name, v: parseName(name), size: f.s, time: f.t, sub: parts.slice(1, -1).map(dec).join(' / ') });
    if (f.t && (!s.time || f.t > s.time)) s.time = f.t;
  }
  for (const s of out.values()) {
    const own = s.files.filter((f) => !f.sub);
    s.volumes = new Set(own.map((f) => (f.v.num !== undefined ? `n${f.v.num}|${f.v.sub ?? ''}` : f.v.base))).size;
    const pubs = new Map<string, number>(); for (const f of s.files) if (f.v.publisher) pubs.set(f.v.publisher, (pubs.get(f.v.publisher) ?? 0) + 1);
    s.publishers = [...pubs.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }
  derived.set(idx, out);
  return out;
}

type Hit = { href?: string; size?: unknown; time?: unknown; managed?: boolean };

/** The index's entries by folder, made once per index. */
const byFolder = new WeakMap<FolderIndex, Map<string, { files: IndexFile[]; dirs: string[] }>>();
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
function folderMap(idx: FolderIndex): Map<string, { files: IndexFile[]; dirs: string[] }> {
  const had = byFolder.get(idx); if (had) return had;
  const m = new Map<string, { files: IndexFile[]; dirs: string[] }>();
  const at = (k: string) => { let x = m.get(k); if (!x) { x = { files: [], dirs: [] }; m.set(k, x); } return x; };
  for (const d of idx.dirs) { at(parentOf(d)).dirs.push(d); at(d); }
  for (const f of idx.files) at(parentOf(f.p)).files.push(f);
  byFolder.set(idx, m);
  return m;
}
/** A folder's entries as the index knows them — at once, without a request — or null when the index does not
 *  know the folder whole: a folder h5ai leaves to a page of its own (or one inside such), an index not made
 *  to the end, a folder it has nothing in (asked of the site, to be sure). */
function entriesFromIndex(idx: FolderIndex, rel: string, root: string): DirEntry[] | null {
  if (!idx.complete && idx.how !== 'search') return null;
  if (idx.unmanaged?.some((u) => rel === u || rel.startsWith(`${u}/`))) return null;
  const here = folderMap(idx).get(rel);
  if (!here || (!here.files.length && !here.dirs.length)) return null;
  const out: DirEntry[] = [];
  for (const d of here.dirs) { const seg = d.slice(d.lastIndexOf('/') + 1); out.push({ name: dec(seg), url: `${root}${d}/`, dir: true }); }
  for (const f of here.files) { const seg = f.p.slice(f.p.lastIndexOf('/') + 1); out.push({ name: dec(seg), url: `${root}${f.p}`, dir: false, size: f.s, time: f.t, date: f.t ? stamp(f.t) : undefined, ext: extOf(seg) }); }
  return out.sort((a, b) => (a.dir === b.dir ? natural(a.name, b.name) : a.dir ? -1 : 1));
}
/** A folder's entries as the site lists them now, put into the index in place of what it had for the folder
 *  (volumes added or taken away since it was made); whether anything changed. */
function mergeFolder(repo: Repo, idx: FolderIndex, rel: string, live: DirEntry[]): boolean {
  const prefix = rel ? `${rel}/` : '';
  const here = (p: string) => parentOf(p) === rel;
  const seg = (e: DirEntry) => e.url.replace(/\/+$/, '').split('/').pop() ?? encodeURIComponent(e.name);
  const liveFiles = new Map(live.filter(isBook).map((e) => [prefix + seg(e), e]));
  const liveDirs = new Set(live.filter((e) => e.dir).map((e) => prefix + seg(e)));
  let changed = false;
  const files = idx.files.filter((f) => { if (!here(f.p)) return true; if (!liveFiles.has(f.p)) { changed = true; return false; } liveFiles.delete(f.p); return true; });
  for (const [p, e] of liveFiles) { files.push({ p, s: e.size, t: e.time }); changed = true; }
  const dirs = idx.dirs.filter((d) => { if (!here(d)) return true; if (!liveDirs.has(d)) { changed = true; return false; } liveDirs.delete(d); return true; });
  for (const d of liveDirs) { dirs.push(d); changed = true; }
  if (!changed) return false;
  idx.files = files; idx.dirs = dirs; derived.delete(idx); byFolder.delete(idx);
  void db.setMeta(INDEX_KEY(repo), idx).catch(() => undefined);
  return true;
}
/** Every file under the folder from h5ai's "items" asked with what=2 — a folder's content and its subfolders'
 *  — two levels a request: a folder of series and all their volumes in one answer; then each series that has
 *  folders of its own, asked the same way (its side folders' contents in one answer), three at a time. (A
 *  server that leaves the subfolders out is asked folder by folder.) */
async function h5aiTree(root: string, progress: (text: string) => void, live: () => boolean, quiet: boolean): Promise<{ files: IndexFile[]; dirs: string[]; complete: boolean; unmanaged: string[] } | null> {
  const rootPath = new URL(root).pathname;
  const relOf = (href: string) => { try { const p = new URL(href, root).pathname; return p.startsWith(rootPath) ? p.slice(rootPath.length).replace(/\/$/, '') : null; } catch { return null; } };
  const files: IndexFile[] = []; const dirs = new Set<string>(); const seen = new Set<string>(); const unmanaged = new Set<string>();
  let queue: string[] = ['']; let complete = true; let asked = 0;
  while (queue.length) {
    if (!live()) { complete = false; break; }
    const next = new Set<string>();
    let rootFailed: SourceError | null = null;
    await pool(queue, 3, async (rel) => {
      const folder = rel ? `${root}${rel}/` : root;
      const why: { error?: SourceError } = {};
      const j = await h5aiApi<{ items?: Hit[] }>(folder, { action: 'get', items: { href: new URL(folder).pathname, what: 2 } }, quiet, why).catch((e) => { if (!rel) throw e; complete = false; return null; });
      if (!j || !Array.isArray(j.items)) { if (!rel) rootFailed = why.error ?? new SourceError('parse', 'parse'); complete = false; return; }
      asked++;
      let deep = false; const subdirs: string[] = [];
      for (const it of j.items) {
        const href = str(it.href); if (!href) continue;
        const r = relOf(href); if (!r) continue;
        if (rel && !r.startsWith(`${rel}/`)) continue;   // (the folders above it and their other content)
        const depth = (rel ? r.slice(rel.length + 1) : r).split('/').length;
        if (depth >= 2) deep = true;
        // (A folder two levels down: its parent asked next, which gives the contents of all its folders at once.)
        if (href.endsWith('/')) { dirs.add(r); if (it.managed === false) { unmanaged.add(r); continue; } if (depth === 1) subdirs.push(r); else if (depth === 2) next.add(r.split('/').slice(0, -1).join('/')); }
        else if (!seen.has(r) && isBook({ ext: extOf(r) })) { seen.add(r); files.push({ p: r, s: num(it.size), t: typeof it.time === 'number' ? it.time : undefined }); }
      }
      if (!deep) for (const d of subdirs) next.add(d);
      progress(t('indexWalking', { n: localDigits(asked), files: localDigits(files.length) }));
    }, live);
    if (rootFailed) { if (!files.length) return null; }
    queue = [...next];
    if (asked > 4000) { complete = false; break; }
  }
  return { files, dirs: [...dirs], complete, unmanaged: [...unmanaged] };
}

/** Make the index: h5ai's search asked once for every file under the folder; else h5ai's items, two levels a
 *  request; else — a server without an API — a walk through the folders, four at a time, as far as `live`
 *  allows (only when asked for: a request per folder). An index with nothing in it is never kept: the reason
 *  the site gave is thrown instead. */
export async function buildIndex(repo: Repo, progress: (text: string) => void, live: () => boolean = () => true, opts: { walk?: boolean; quiet?: boolean } = {}): Promise<FolderIndex> {
  const root = withSlash(repo.folder ?? repo.url);
  const before = await loadIndex(repo);
  const rootPath = new URL(root).pathname;
  const quiet = !!opts.quiet;
  let files: IndexFile[] = []; let dirs: string[] = []; let unmanaged: string[] = [];
  const relOf = (u: string) => { const p = new URL(u, root).pathname; return p.startsWith(rootPath) ? p.slice(rootPath.length).replace(/\/$/, '') : ''; };
  progress(t('indexAsking'));
  let how: FolderIndex['how'] = 'search'; let complete = true;
  let failure: SourceError | null = null;
  // h5ai's search: every name with a character in it (everything), folders and all, in one answer.
  const why: { error?: SourceError } = {};
  const j = await h5aiApi<{ search?: unknown }>(root, { action: 'get', search: { href: rootPath, pattern: '.', ignorecase: true } }, quiet, why);
  const isApi = !!j || repo.flavor === 'h5ai';
  if (j && Array.isArray(j.search) && j.search.length) {
    for (const it of j.search as Hit[]) {
      const href = str(it.href); if (!href) continue;
      const rel = relOf(href); if (!rel) continue;
      if (href.endsWith('/')) { dirs.push(rel); if (it.managed === false) unmanaged.push(rel); }
      else if (isBook({ ext: extOf(rel) })) files.push({ p: rel, s: num(it.size), t: typeof it.time === 'number' ? it.time : undefined });
    }
  } else {
    failure = why.error ?? null;
    // h5ai's items, two levels a request (its search turned off, or not answering).
    const tree = isApi ? await h5aiTree(root, progress, live, quiet) : null;
    if (tree && (tree.files.length || tree.dirs.length)) { how = 'tree'; files = tree.files; dirs = tree.dirs; complete = tree.complete; unmanaged = tree.unmanaged; }
    else {
      // The walk: the folders, a layer at a time — only when asked for.
      if (!opts.walk) throw isApi && failure ? failure : new SourceError('noSearch', 'parse');
      how = 'walk';
      let layer = ['']; let walked = 0;
      while (layer.length) {
        if (!live()) { complete = false; break; }
        const next: string[] = [];
        await pool(layer, 4, async (rel) => {
          let entries: DirEntry[];
          try { entries = await listFolder(rel ? `${root}${rel}/` : root, true, repo.flavor === 'h5ai'); }
          catch (e) { complete = false; if (!rel || (fatal(e) && !failure)) failure = e as SourceError; return; }
          walked++; progress(t('indexWalking', { n: localDigits(walked), files: localDigits(files.length) }));
          for (const e of entries) {
            const seg = e.url.replace(/\/+$/, '').split('/').pop() ?? encodeURIComponent(e.name);
            const p = rel ? `${rel}/${seg}` : seg;
            if (e.dir) { dirs.push(p); next.push(p); }
            else if (isBook(e)) files.push({ p, s: e.size, t: e.time });
          }
        }, live);
        layer = next;
        if (walked > 6000) { complete = false; break; }
      }
    }
  }
  // (Nothing at all: the site's own answer said why — a check, a refusal, a page that is not a listing.)
  if (!files.length && !dirs.length) throw failure ?? new SourceError(t('indexEmptyAnswer'), 'parse');
  const idx: FolderIndex = { v: 2, at: Date.now(), how, complete, files, dirs, ...(unmanaged.length ? { unmanaged } : {}) };
  indexes.set(repo.key, idx);
  await db.setMeta(INDEX_KEY(repo), idx).catch(() => undefined);
  // (Listings read before the index was made again are read again: a series' page shows what is new.)
  forgetListings(root);
  // What arrived since the index before, for the series the reader follows (has a volume of in the library).
  if (before) {
    const had = new Set(before.files.map((f) => f.p));
    const fresh = files.filter((f) => !had.has(f.p));
    if (fresh.length) {
      const followed = await inLibrary(`dir:${repo.key}`);
      const news = await newsOf(repo);
      for (const f of fresh) {
        const series = f.p.split('/')[0]; if (!followed.has(series) || !f.p.includes('/')) continue;
        const n = news[series] ?? (news[series] = { n: 0, names: [], at: 0 });
        n.n++; n.at = Date.now(); if (n.names.length < 5) n.names.push(dec(f.p.split('/').pop() ?? ''));
      }
      await db.setMeta(NEWS_KEY(repo), news).catch(() => undefined);
      newsMem.set(repo.key, news);
    }
  }
  return idx;
}
/** New volumes of the series the reader follows, by series, until the series' page is opened. */
export interface SeriesNews { n: number; names: string[]; at: number }
const NEWS_KEY = (repo: Repo) => `dir:news:${repo.key}`;
const newsMem = new Map<string, Record<string, SeriesNews>>();
export async function newsOf(repo: Repo): Promise<Record<string, SeriesNews>> { const news = (await db.getMeta<Record<string, SeriesNews>>(NEWS_KEY(repo)).catch(() => undefined)) ?? {}; newsMem.set(repo.key, news); return news; }
async function seen(repo: Repo, series: string): Promise<void> { const news = await newsOf(repo); if (!news[series]) return; delete news[series]; newsMem.set(repo.key, news); await db.setMeta(NEWS_KEY(repo), news).catch(() => undefined); }
/** Forget what a folder source kept (its index, its news) when it is removed. */
export async function forgetFolder(repoKey: string): Promise<void> { indexes.delete(repoKey); await db.deleteMeta(`dir:index:${repoKey}`).catch(() => undefined); await db.deleteMeta(`dir:news:${repoKey}`).catch(() => undefined); }
/** The index made again in the background (an h5ai server, one request) when older than `age`: the new
 *  volumes of the series followed, by series name. */
export async function refreshIndex(repo: Repo, age: number): Promise<{ series: string; name: string; n: number }[]> {
  const idx = await loadIndex(repo);
  if (!idx || repo.flavor !== 'h5ai' || Date.now() - idx.at < age) return [];
  const old = await newsOf(repo);
  await buildIndex(repo, () => undefined, () => true, { quiet: true });
  const news = await newsOf(repo);
  return Object.entries(news).filter(([k, v]) => v.n > (old[k]?.n ?? 0)).map(([k, v]) => ({ series: k, name: dec(k), n: v.n - (old[k]?.n ?? 0) }));
}
/** The whole folder searched by h5ai itself (without an index): every name with the longest word in it. */
async function h5aiSearch(repo: Repo, rel: string, words: string[]): Promise<{ rel: string; dir: boolean; size?: number; time?: number }[] | null> {
  const root = withSlash(repo.folder ?? repo.url);
  const word = [...words].sort((a, b) => b.length - a.length)[0]?.replace(/[^\p{L}\p{N}]+/gu, '');
  if (!word) return null;
  try {
    const folder = rel ? `${root}${rel}/` : root;
    const j = await h5aiApi<{ search?: Hit[] }>(folder, { action: 'get', search: { href: new URL(folder).pathname, pattern: word, ignorecase: true } }, true);
    if (!j || !Array.isArray(j.search)) return null;
    const rootPath = new URL(root).pathname;
    return j.search.map((it) => { const p = new URL(it.href ?? '', root).pathname; return { rel: p.startsWith(rootPath) ? p.slice(rootPath.length).replace(/\/$/, '') : '', dir: (it.href ?? '').endsWith('/'), size: num(it.size), time: typeof it.time === 'number' ? it.time : undefined }; }).filter((x) => x.rel);
  } catch (e) { if (fatal(e)) throw e; return null; }
}

/* ---------- the source ---------- */
/** A folder inside the root is known by its path from the root: its segments as the server spells them,
 *  joined by "/"; "" is the root. Shelves of the root's own are "::recent", "::new", "::mine". */
const urlOf = (root: string, rel: string) => withSlash(root) + (rel ? withSlash(rel) : '');
const crumbsOf = (rel: string) => rel.split('/').filter(Boolean).map(dec);
const noExt = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/i, '');
const segOf = (e: DirEntry) => e.url.replace(/\/+$/, '').split('/').pop() ?? encodeURIComponent(e.name);
const childRel = (rel: string, e: DirEntry) => (rel ? `${rel}/${segOf(e)}` : segOf(e));
const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[ً-ْٰـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/[-_.+,:;!?'"()[\]{}]+/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim();
/** A side folder's name as shown: "!Side Stories" is "Side Stories". */
const shownName = (name: string) => name.replace(/^!+\s*/, '');

/** The kinds of file a search or a folder can be narrowed to. */
const KINDS: [string, string[]][] = [['EPUB', ['epub']], ['PDF', ['pdf']], ['Kindle', ['mobi', 'azw', 'azw3', 'kf8', 'prc']], ['Text', ['txt', 'md', 'html', 'htm', 'xhtml', 'fb2', 'docx', 'odt', 'rtf']], ['Audio', ['m4b', 'mp3', 'm4a', 'ogg', 'opus', 'flac']]];

export function fileOf(e: { name: string; url: string; size?: number; ext?: string }, rel: string): SourceFile {
  const ext = e.ext ?? ''; const [label, mime] = BOOK_EXT[ext] ?? [ext.toUpperCase(), ''];
  return { id: rel, label, ext, size: e.size, url: e.url, mime, name: e.name };
}

export function folderSource(repo: Repo): Source {
  const root = withSlash(repo.folder ?? repo.url);
  // (A site its manifest says answers only a browser: the app's own browser from the first request.)
  if (repo.browser) { try { useBrowserFor(new URL(root).host, 30); } catch { /* an address without a host */ } }
  const srcId = `dir:${repo.key}`;
  const h5ai = repo.flavor === 'h5ai';
  if (h5ai) assumeRanges(root);
  const headers = { referer: `${originOf(root)}/` };
  const saved = (): FilterValues => { try { return JSON.parse(localStorage.getItem(`kr.src.${srcId}.filters`) ?? '{}') as FilterValues; } catch { return {}; } };
  // (Covers cost a piece of every file: off, or only on Wi-Fi, as the reader chose.)
  const noCover = () => { const c = String(saved().covers ?? 'always'); if (c === 'off') return true; if (c === 'wifi') { const n = (navigator as Navigator & { connection?: { type?: string } }).connection; return n?.type === 'cellular'; } return false; };
  const wanted = (f: FilterValues) => { const kinds = Array.isArray(f.kinds) ? f.kinds : []; if (!kinds.length) return () => true; const exts = new Set(KINDS.filter(([k]) => kinds.includes(k)).flatMap(([, e]) => e)); return (e: { dir?: boolean; ext?: string }) => !!e.dir || (!!e.ext && exts.has(e.ext)); };
  const storeFirst = (f: FilterValues) => f.edition === 'store';
  const scans = (f: FilterValues) => f.scans !== false;
  const format = (f: FilterValues) => (f.format === 'pdf' ? 'pdf' : 'epub');
  const groupsOf = (list: Vol[], f: FilterValues, withScans = scans(f)) => groupVolumes(list, storeFirst(f), withScans, format(f));
  const folderCard = (name: string, rel: string, extra: Partial<SourceBook> = {}): SourceBook => ({ id: `d:${rel}`, title: shownName(name), openShelf: rel, look: 'folder', ...extra });
  const fileFor = (rel: string, name: string, size?: number): SourceFile => fileOf({ name, url: `${root}${rel}`, size, ext: (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? '').toLowerCase() }, rel);
  /** A row for a group of editions: the best one shown, the others offered beside it. */
  const volumeRow = (g: VolGroup, opts: { full?: boolean; where?: string } = {}): SourceBook => {
    const first = g.items[0];
    const mixed = new Set(g.items.map((x) => x.v.ext)).size > 1;
    // ("Volume 14 — The Subtitle" in a series' page when the name says it is a volume; else the file's own name.)
    const title = opts.full || g.num === undefined || !first.v.marked ? first.v.base : `${t('volumeN', { n: localDigits(String(g.num), 'prose') })}${first.v.sub ? ` — ${first.v.sub}` : ''}`;
    const c = coverItem(g);
    return {
      id: `f:${first.rel}`, title, look: 'volume', badge: BOOK_EXT[first.v.ext]?.[0] ?? first.v.ext.toUpperCase(), author: opts.where, year: first.e.date,
      file: fileOf(first.e, first.rel), coverFile: c ? fileOf(c.e, c.rel) : undefined,
      alts: g.items.length > 1 ? g.items.map((x) => ({ label: editionLabel(x.v, mixed), id: `f:${x.rel}`, file: fileOf(x.e, x.rel) })) : undefined,
      description: g.items.length === 1 && (first.v.editions.length || first.v.publisher) ? editionLabel(first.v, false) : undefined,
    };
  };
  /** The index's files of a series as listing entries (for a cover, a count, a search). */
  const entryOf = (f: SeriesInfo['files'][number]): DirEntry => ({ name: f.name, url: `${root}${f.rel}`, dir: false, size: f.size, time: f.time, date: f.time ? stamp(f.time) : undefined, ext: f.v.ext });
  const sortSeries = (list: SeriesInfo[], f: FilterValues) => {
    const by = String(f.sort ?? 'name');
    return list.sort((a, b) => by === 'newest' ? (b.time ?? 0) - (a.time ?? 0) || natural(a.name, b.name) : by === 'biggest' ? b.volumes - a.volumes || natural(a.name, b.name) : natural(a.name, b.name));
  };
  const seriesCard = (s: SeriesInfo, f: FilterValues, news?: Record<string, SeriesNews>): SourceBook => folderCard(s.name, s.rel, { author: s.publishers.slice(0, 2).join(' · ') || undefined, badge: s.volumes ? countVolumes(s.volumes) : undefined, year: s.time && String(f.sort) === 'newest' ? stamp(s.time)?.slice(0, 10) : undefined, fresh: news?.[s.rel]?.n });
  const byPublisher = (f: FilterValues) => { const ps = Array.isArray(f.publisher) ? f.publisher : []; return (s: SeriesInfo) => !ps.length || s.publishers.some((p) => ps.includes(p)); };
  /** A series' card: its name, its place, how many volumes and how big, its publishers and formats, the
   *  files "Download all" fetches (the chosen edition of each volume). */
  const seriesHeadOf = (rel: string, groups: VolGroup[], books: DirEntry[]): SourceBook => {
    const crumbs = crumbsOf(rel);
    const total = groups.reduce((n, g) => n + (g.items[0].e.size ?? 0), 0);
    const pubs = [...new Set(books.map((e) => parseName(e.name).publisher).filter(Boolean))] as string[];
    // (Its cover is the first volume's — the same file as its card's on the shelf, read once for both.)
    const c = firstCover(groups);
    return { id: `a:${rel}`, title: crumbs.length ? shownName(crumbs[crumbs.length - 1]) : repo.name, look: 'series', coverFile: c ? fileOf(c.e, c.rel) : undefined, author: crumbs.length > 1 ? crumbs.slice(0, -1).map(shownName).join(' / ') : undefined, badge: countVolumes(groups.length), description: total ? formatBytes(total) : undefined, files: groups.map((g) => fileOf(g.items[0].e, g.items[0].rel)), volumeIds: groups.map((g) => g.items.map((x) => `f:${x.rel}`)), formats: [...pubs.slice(0, 2), ...new Set(books.map((e) => BOOK_EXT[e.ext!]?.[0] ?? ''))].filter(Boolean) };
  };
  // A search's matches are gathered once and paged from memory.
  const searches = new Map<string, { items: SourceBook[]; partial: boolean }>();
  const search = async (q: string, rel: string, f: FilterValues): Promise<{ items: SourceBook[]; partial: boolean }> => {
    const key = `${rel}\u0000${q}\u0000${JSON.stringify([f.kinds, f.publisher, f.edition, f.scans, f.format])}`;
    const had = searches.get(key); if (had) return had;
    const words = norm(q).split(' ').filter(Boolean);
    const keep = wanted(f);
    const match = (own: string, where: string) => { const o = norm(own); const hay = `${norm(where)} ${o}`; return words.every((w) => hay.includes(w)) && words.some((w) => o.includes(w)); };
    const idx = await loadIndex(repo);
    // With the index: the series whose names match, then every matching volume, its editions together.
    if (idx) {
      const all = seriesOf(idx); const pub = byPublisher(f);
      const inside = (s: SeriesInfo) => !rel || s.rel === rel.split('/')[0];
      const series = [...all.values()].filter((s) => inside(s) && pub(s) && words.every((w) => norm(`${s.name} ${s.publishers.join(' ')}`).includes(w)));
      const items: SourceBook[] = sortSeries(series, f).map((s) => seriesCard(s, f));
      const vols: Vol[] = [];
      for (const s of all.values()) {
        if (!inside(s) || !pub(s)) continue;
        for (const fl of s.files) if (keep({ ext: fl.v.ext }) && match(fl.name, `${s.name} ${fl.sub} ${fl.v.publisher ?? ''}`)) vols.push({ e: entryOf(fl), v: fl.v, rel: fl.rel });
      }
      // (Grouped by series and volume, the editions of one volume in one row.)
      const bySeries = new Map<string, Vol[]>(); for (const v of vols) { const s = v.rel.split('/')[0]; const l = bySeries.get(s); if (l) l.push(v); else bySeries.set(s, [v]); }
      for (const [s, list] of [...bySeries.entries()].sort((a, b) => natural(dec(a[0]), dec(b[0])))) for (const g of groupsOf(list, f)) items.push({ ...volumeRow(g, { full: true, where: dec(s) }), group: shownName(dec(s)) });
      const res = { items, partial: !idx.complete };
      searches.set(key, res); return res;
    }
    // Without it: h5ai's own search, else the folders walked (as far as a budget allows).
    const found = h5ai ? await h5aiSearch(repo, rel, words) : null;
    if (found) {
      const items: SourceBook[] = []; const vols: Vol[] = [];
      for (const x of found) {
        const parts = x.rel.split('/'); const name = dec(parts[parts.length - 1]); const where = parts.slice(0, -1).map(dec).join(' / ');
        if (x.dir) { if (match(name, where)) items.push(folderCard(name, x.rel, { author: where || undefined })); continue; }
        const e: DirEntry = { name, url: `${root}${x.rel}`, dir: false, size: x.size, time: x.time, date: x.time ? stamp(x.time) : undefined, ext: (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? '').toLowerCase() };
        if (isBook(e) && keep(e) && match(name, where)) vols.push({ e, v: parseName(name), rel: x.rel });
      }
      const bySeries = new Map<string, Vol[]>(); for (const v of vols) { const s = v.rel.split('/').slice(0, -1).join('/'); const l = bySeries.get(s); if (l) l.push(v); else bySeries.set(s, [v]); }
      for (const [s, list] of [...bySeries.entries()].sort((a, b) => natural(a[0], b[0]))) for (const g of groupsOf(list, f)) items.push(volumeRow(g, { full: true, where: crumbsOf(s).join(' / ') }));
      const res = { items, partial: false }; searches.set(key, res); return res;
    }
    const foundWalk: { e: DirEntry; rel: string; where: string }[] = [];
    const started = Date.now(); let fetched = 0; let partial = false;
    let layer = [rel];
    while (layer.length) {
      if (fetched >= 200 || Date.now() - started > 20000) { partial = true; break; }
      const take = layer.slice(0, Math.max(1, Math.min(layer.length, 200 - fetched))); layer = layer.slice(take.length);
      const next: string[] = [];
      await pool(take, 4, async (r) => {
        let entries: DirEntry[];
        try { entries = await listFolder(urlOf(root, r), true, h5ai); fetched++; } catch { partial = true; return; }
        const where = crumbsOf(r).join(' / ');
        for (const e of entries) {
          const cr = childRel(r, e);
          if (e.dir) next.push(cr);
          if (!e.dir && (!isBook(e) || !keep(e))) continue;
          if (match(e.name, where)) foundWalk.push({ e, rel: cr, where });
        }
      });
      layer.push(...next);
    }
    const items: SourceBook[] = foundWalk.filter((x) => x.e.dir).sort((a, b) => natural(a.e.name, b.e.name)).map((x) => folderCard(x.e.name, x.rel, { author: x.where || undefined }));
    const bySeries = new Map<string, Vol[]>(); for (const x of foundWalk) { if (x.e.dir) continue; const l = bySeries.get(x.where); const v = { e: x.e, v: parseName(x.e.name), rel: x.rel }; if (l) l.push(v); else bySeries.set(x.where, [v]); }
    for (const [where, list] of [...bySeries.entries()].sort((a, b) => natural(a[0], b[0]))) for (const g of groupsOf(list, f)) items.push(volumeRow(g, { full: true, where }));
    const res = { items, partial }; searches.set(key, res); return res;
  };

  /** A folder's entries: from the index at once when it knows the folder whole, else from the site. */
  const entriesOf = async (rel: string, quiet = false): Promise<{ entries: DirEntry[]; fromIndex: boolean }> => {
    const idx = await loadIndex(repo);
    const got = idx ? entriesFromIndex(idx, rel, root) : null;
    if (got) return { entries: got, fromIndex: true };
    return { entries: await listFolder(urlOf(root, rel), quiet, h5ai), fromIndex: false };
  };
  /** A folder shown from an index some minutes old, asked of the site out of sight: what changed since goes into
   *  the index, and the page is told to draw itself again. */
  const checking = new Set<string>();
  const checkLater = (rel: string, idx: FolderIndex) => {
    if (Date.now() - idx.at < KEEP || checking.has(rel)) return;
    checking.add(rel);
    void listFolder(urlOf(root, rel), true, h5ai).then((live) => {
      if (!mergeFolder(repo, idx, rel, live)) return;
      searches.clear();
      window.dispatchEvent(new CustomEvent('kr:shelf-changed', { detail: { source: srcId, shelf: rel } }));
    }).catch(() => undefined).finally(() => setTimeout(() => checking.delete(rel), KEEP));
  };

  const src: Source = {
    id: srcId, name: repo.name, lang: '', description: t('folderSourceDesc'), site: root,
    filters(): SourceFilter[] {
      const idx = indexes.get(repo.key);
      const pubs = idx ? (() => { const n = new Map<string, number>(); for (const s of seriesOf(idx).values()) for (const p of s.publishers.slice(0, 1)) n.set(p, (n.get(p) ?? 0) + 1); return [...n.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([p]) => ({ value: p, label: p })); })() : [];
      const list: SourceFilter[] = [
        { id: 'sort', label: t('sortBy'), kind: 'sort', options: [{ value: 'name', label: t('sortName') }, { value: 'newest', label: t('sortUpdated') }, { value: 'biggest', label: t('sortMostVolumes') }], value: 'name' },
      ];
      if (pubs.length) list.push({ id: 'publisher', label: t('publishersFilter'), kind: 'multi', options: pubs, value: [] });
      list.push(
        { id: 'format', label: t('preferredFormat'), kind: 'select', options: [{ value: 'epub', label: 'EPUB' }, { value: 'pdf', label: 'PDF' }], value: 'epub' },
        { id: 'edition', label: t('preferredEdition'), kind: 'select', options: [{ value: 'premium', label: t('editionPremiumFirst') }, { value: 'store', label: t('editionStoreFirst') }], value: 'premium' },
        { id: 'scans', label: t('showScans'), kind: 'toggle', value: true },
        { id: 'covers', label: t('coversPref'), kind: 'select', options: [{ value: 'always', label: t('coversAlways') }, { value: 'wifi', label: t('coversWifi') }, { value: 'off', label: t('coversOff') }], value: 'always' },
        { id: 'kinds', label: t('fileKinds'), kind: 'multi', options: KINDS.map(([k]) => ({ value: k, label: k })), value: [] },
      );
      return list;
    },
    async shelves(current?: string): Promise<SourceTag[]> {
      // (At the top only: inside a series the shelf is the series.)
      if (current && !current.startsWith('::')) return [];
      const idx = await loadIndex(repo);
      return [{ id: '::recent', label: t('shelfRecentSeries') }, ...(idx ? [{ id: '::new', label: t('shelfNewVolumes') }] : []), { id: '::mine', label: t('shelfInMyLibrary') }];
    },
    async status() {
      const idx = await loadIndex(repo);
      // (Whether the index made again differs from the one before: the page is drawn again only then.)
      const run = async (progress: (text: string) => void, live: () => boolean, auto = false): Promise<boolean> => {
        const before = await loadIndex(repo);
        const made = await buildIndex(repo, progress, live, { walk: !auto });
        searches.clear();
        progress(t('indexMade', { series: countSeries(seriesOf(made).size), n: countVolumes(made.files.length) }));
        if (!before || before.files.length !== made.files.length || before.dirs.length !== made.dirs.length) return true;
        const had = new Set(before.files.map((x) => x.p));
        return made.files.some((x) => !had.has(x.p));
      };
      // (An h5ai server gives its whole list in one answer: made at once, the first time the folder is opened —
      // and again, out of sight, when a few hours old. A walk through every folder is made only when asked for.)
      if (!idx) return { text: t('indexNone'), auto: h5ai, action: { label: t('indexMake'), run } };
      if (h5ai && Date.now() - idx.at > 6 * 3600000) return { text: t('indexOld'), auto: true, action: { label: t('indexUpdate'), run } };
      const ago = Math.round((Date.now() - idx.at) / 86400000);
      return { text: `${t('indexState', { series: countSeries(seriesOf(idx).size), n: countVolumes(idx.files.length) })} · ${ago < 1 ? t('today') : daysAgo(ago)}${idx.complete ? '' : ` · ${t('indexPartial')}`}`, action: { label: t('indexUpdate'), run } };
    },
    async browse(q, f, pageNo, shelf): Promise<SourcePage> {
      const special = shelf?.startsWith('::') ? shelf : undefined;
      const rel = special ? '' : (shelf ?? '').replace(/^\/+|\/+$/g, '');
      const crumbs = crumbsOf(rel);
      const title = crumbs.length ? shownName(crumbs[crumbs.length - 1]) : undefined;
      const PAGE = 60;
      const paged = (list: SourceBook[], head?: SourceBook, ttl?: string): SourcePage => { const items = list.slice((pageNo - 1) * PAGE, pageNo * PAGE); if (head && pageNo === 1) items.unshift(head); return { items, hasMore: pageNo * PAGE < list.length, title: ttl }; };
      if (q.trim()) {
        const r = await search(q.trim(), rel, f);
        return paged(r.items, undefined, `${t('searchResultsIn', { n: localDigits(String(r.items.length)) })}${r.partial ? ' …' : ''}${title ? ` · ${title}` : ''}`);
      }
      const idx = await loadIndex(repo);
      // The newest volumes of the whole folder.
      if (special === '::new' && idx) {
        const latest = idx.files.filter((x) => x.t).sort((a, b) => (b.t ?? 0) - (a.t ?? 0)).slice(0, 240);
        const rows = latest.map((x) => { const name = dec(x.p.split('/').pop() ?? ''); const where = x.p.split('/').slice(0, -1).map(dec).join(' / '); return { ...volumeRow({ key: x.p, num: undefined, items: [{ e: { name, url: `${root}${x.p}`, dir: false, size: x.s, time: x.t, date: x.t ? stamp(x.t) : undefined, ext: (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? '').toLowerCase() }, v: parseName(name), rel: x.p }] }, { full: true, where }), group: x.p.includes('/') ? shownName(dec(x.p.split('/')[0])) : undefined }; });
        return paged(rows, undefined, t('shelfNewVolumes'));
      }
      // The top: the series (from the index when there is one: counted, with their publishers).
      if (!rel) {
        let list: SourceBook[]; let topBooks: Vol[] = [];
        if (idx) {
          const dirSet = new Set(idx.dirs);
          let series = [...seriesOf(idx).values()].filter((s) => s.files.length || dirSet.has(s.rel)).filter(byPublisher(f));
          if (special === '::mine') { const mine = await inLibrary(srcId); series = series.filter((s) => mine.has(s.rel)); }
          const news = await newsOf(repo);
          // (The series with new volumes first on "In my library".)
          const sorted = sortSeries(series, special === '::recent' ? { ...f, sort: 'newest' } : f);
          if (special === '::mine') sorted.sort((a, b) => (news[b.rel]?.n ?? 0) - (news[a.rel]?.n ?? 0));
          list = sorted.map((s) => seriesCard(s, special === '::recent' ? { ...f, sort: 'newest' } : f, news));
          // (Books lying at the top itself, beside the series.)
          if (!special) topBooks = idx.files.filter((x) => !x.p.includes('/')).map((x) => { const name = dec(x.p); return { e: { name, url: `${root}${x.p}`, dir: false, size: x.s, time: x.t, date: x.t ? stamp(x.t) : undefined, ext: (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? '').toLowerCase() }, v: parseName(name), rel: x.p }; }).filter((x) => wanted(f)(x.e));
        } else {
          const all = await listFolder(root, false, h5ai);
          let dirs = all.filter((e) => e.dir);
          if (special === '::mine') { const mine = await inLibrary(srcId); dirs = dirs.filter((d) => mine.has(segOf(d))); }
          if (special === '::recent' || f.sort === 'newest') dirs = dirs.sort((a, b) => (b.time ?? 0) - (a.time ?? 0) || natural(a.name, b.name));
          list = dirs.map((e) => folderCard(e.name, childRel('', e), { year: special === '::recent' ? e.date?.slice(0, 10) : undefined }));
          if (!special) topBooks = all.filter((e) => isBook(e) && wanted(f)(e)).map((e) => ({ e, v: parseName(e.name), rel: childRel('', e) }));
        }
        // (Books lying at the top beside the series are rows after them; the top is a series' page only when it
        // has no folders — a flat folder of volumes.)
        const shelvesHere = list.length;
        const groups = groupsOf(topBooks, f);
        list.push(...groups.map((g) => volumeRow(g, { full: true })));
        const head = groups.length && !shelvesHere && !special ? seriesHeadOf('', groups, topBooks.map((x) => x.e)) : undefined;
        const out = paged(list, head, special === '::recent' ? t('shelfRecentSeries') : special === '::mine' ? t('shelfInMyLibrary') : undefined);
        if (!list.length && !special) out.empty = { text: t('folderEmpty'), url: root };
        return out;
      }
      // A series (or any folder with books in it): its card, its volumes in reading order, then its side folders —
      // from the index at once when it knows the folder (the site asked out of sight whether anything changed).
      void seen(repo, rel.split('/')[0]);
      const { entries: all, fromIndex } = await entriesOf(rel);
      if (fromIndex && idx) checkLater(rel, idx);
      const folders = all.filter((e) => e.dir);
      const books = all.filter((e) => isBook(e) && wanted(f)(e));
      const groups = groupsOf(books.map((e) => ({ e, v: parseName(e.name), rel: childRel(rel, e) })), f);
      // (A volume fetched from a series' page goes into the library's folder of that series.)
      const series = shownName(crumbs[0] ?? '');
      const rows = groups.map((g) => ({ ...volumeRow(g), group: series }));
      const list: SourceBook[] = [...rows, ...folders.map((e) => folderCard(e.name, childRel(rel, e)))];
      // (A series' card on top when the folder is its volumes, a few side folders beside them — not over a shelf
      // of series with a stray file or two.)
      const head = groups.length && (folders.length <= 3 || groups.length >= folders.length) ? seriesHeadOf(rel, groups, books) : undefined;
      const out = paged(list, head, title);
      if (!list.length) {
        const others = all.filter((e) => !e.dir && !isBook(e));
        const kinds = [...new Set(others.map((e) => (e.ext || '?').toUpperCase()))].slice(0, 5).join(', ');
        out.empty = { text: all.some(isBook) ? t('folderFiltered') : others.length ? t('folderOtherFiles', { kinds }) : t('folderEmpty'), url: urlOf(root, rel) };
      }
      return out;
    },
    async details(id): Promise<SourceDetails> {
      const kind = id.slice(0, 2); const rel = id.slice(2);
      if (kind !== 'f:') throw new SourceError('notFound', 'parse');
      const parts = rel.split('/'); const last = parts.pop() ?? ''; const parent = parts.join('/');
      const { entries } = await entriesOf(parent);
      const e = entries.find((x) => !x.dir && (segOf(x) === last || x.name === dec(last)));
      if (!e) throw new SourceError('notFound', 'http', 404);
      const file = fileOf(e, rel);
      const v = parseName(e.name);
      const crumbs = crumbsOf(parent);
      const meta: { label: string; value: string }[] = [{ label: t('fileName'), value: e.name }];
      if (v.publisher) meta.push({ label: t('publisher'), value: v.publisher });
      if (v.editions.length) meta.push({ label: t('edition'), value: editionLabel(v, false) });
      if (e.size !== undefined) meta.push({ label: t('fileSize'), value: formatBytes(e.size) });
      if (e.date) meta.push({ label: t('fileDate'), value: e.date });
      if (crumbs.length) meta.push({ label: t('folderPath'), value: `/${crumbs.join('/')}` });
      const peek = /^(epub|pdf)$/.test(file.ext) ? await peekFile(file.url, file.ext, file.size, { noCover: noCover(), headers }).catch(() => null) : null;
      return { id, title: peek?.title || v.base, author: peek?.author || (crumbs.length ? crumbs.map(shownName).join(' / ') : undefined), cover: peek?.cover, description: peek?.description, tags: [], files: [file], url: e.url, meta, formats: [file.label], toc: peek?.toc };
    },
    async fetchFile(_book, file, onProgress): Promise<File> {
      const bytes = await fetchBytes(file.url, onProgress, { headers });
      return new File([bytes.buffer as ArrayBuffer], file.name ?? `${noExt(folderName(file.url))}.${file.ext}`, { type: file.mime ?? '' });
    },
    async peek(b) {
      const fl = b.file; if (!fl || !/^(epub|pdf)$/.test(fl.ext)) return null;
      return peekFile(fl.url, fl.ext, fl.size, { noCover: noCover(), headers });
    },
    peekNow: (b) => (b.file ? peekKnown(b.file.url, b.file.size, noCover()) : undefined),
    freshNow: (rel) => { const news = newsMem.get(repo.key); return news ? news[rel]?.n ?? 0 : undefined; },
    folderCoverNow: (rel) => known(`peek:dir:${keyOf(urlOf(root, rel))}`),
    async folderCover(rel) {
      // Its first volume's cover — volume 1's EPUB (else its PDF), the very file its series' page shows on top,
      // read once for both; for a folder without books, its own picture (cover.jpg…) or its first folder's first
      // volume. What is kept is which file (or picture) — its cover is kept with it, once — for a week.
      const key = `peek:dir:${keyOf(urlOf(root, rel))}`;
      const had = await recall(key, 7 * 86400000); if (had && (had.cover || noCover())) return had;
      // (A folder that could not be read for a cover — a page of its own — is not asked again this session.)
      if (coverless.has(rel)) return { at: Date.now() };
      try { return await coverOf(rel, key); }
      catch (e) { if (!fatal(e)) coverless.add(rel); throw e; }
    },
  };
  /** A folder's cover looked for (see folderCover). */
  const coverless = new Set<string>();
  const coverOf = async (rel: string, key: string): Promise<Peek> => {
    const idx = await loadIndex(repo);
    const s = idx && !rel.includes('/') ? seriesOf(idx).get(rel) : undefined;
    let at = rel; let count = s?.volumes ?? 0;
    for (let depth = 0; depth < 2; depth++) {
      const { entries, fromIndex } = await entriesOf(at, true);
      const books = entries.filter(isBook);
      const groups = groupVolumes(books.map((e) => ({ e, v: parseName(e.name), rel: childRel(at, e) })), storeFirst(saved()), true);
      if (depth === 0 && !s) count = groups.length;
      const c = firstCover(groups);
      if (c) {
        const peek = await peekFile(c.e.url, c.v.ext, c.e.size, { noCover: noCover(), headers });
        const p: Peek = { cover: peek?.cover, count, at: Date.now(), ref: peekKeyOf(c.e.url, c.e.size) };
        if (peek?.cover) remember(key, p);
        return p;
      }
      // (No EPUB or PDF in it: its own picture — which only the site's listing shows, the index keeps books.)
      const live = fromIndex ? await listFolder(urlOf(root, at), true, h5ai).catch(() => entries) : entries;
      const imgs = live.filter(isImage);
      const img = imgs.find((e) => /^(cover|folder|poster|front|thumb)/i.test(e.name)) ?? (imgs.length === 1 ? imgs[0] : undefined);
      if (img && !noCover()) { const cover = await thumbOf(img.url); if (cover) { const p: Peek = { cover, count, at: Date.now(), ref: imageKeyOf(img.url) }; remember(key, p); return p; } }
      if (books.length) break;
      const sub = live.filter((e) => e.dir).sort((a, b) => natural(a.name, b.name))[0];
      if (!sub) break;
      at = childRel(at, sub);
    }
    return { count, at: Date.now() };
  };
  return src;
}

/** The series (top folders) of a folder source with a volume in the library. */
async function inLibrary(srcId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const b of await db.allBooks()) if (b.remote?.source === srcId && b.remote.id?.startsWith('f:')) out.add(b.remote.id.slice(2).split('/')[0]);
  return out;
}
