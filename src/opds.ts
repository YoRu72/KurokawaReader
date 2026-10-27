// OPDS catalogues (as Moon+ Reader's net library and KOReader's catalogues): a server's feed is read — OPDS 1.x
// Atom or OPDS 2.0 JSON — into one shape, navigation entries lead on to further feeds, publications offer their
// files, and a book is fetched straight into the library. Catalogues the reader adds are kept with their
// sign-in; the request goes through native code on the phone and on the desktop, so a home server with no
// CORS headers (Calibre-Web, Kavita, Komga…) answers all the same.
import { db } from './db';
import { importFiles, shrinkCover } from './library';
import { nativePlatform, readContentUri } from './native';
import { http } from './net';
export { http };

export interface OpdsLink { href: string; rel: string; type: string; title?: string }
export interface OpdsEntry {
  id: string; title: string; authors: string[]; summary: string; language?: string; published?: string;
  thumbnail?: string; image?: string; links: OpdsLink[]; categories: string[];
}
export interface OpdsFeed {
  title: string; url: string; entries: OpdsEntry[];
  next?: string; up?: string; start?: string;
  /** How to search: a URL template holding `{searchTerms}`, or an OpenSearch description to read it from. */
  search?: { template?: string; description?: string };
}
export interface Catalog { id: string; name: string; url: string; user?: string; pass?: string }

/* ---------- the catalogues kept ---------- */

const KEY = 'kr.opds';
export function getCatalogs(): Catalog[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Catalog[]; return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveCatalogs(list: Catalog[]): void { localStorage.setItem(KEY, JSON.stringify(list)); }
export function catalogFor(url: string): Catalog | undefined {
  let host = ''; try { host = new URL(url).host; } catch { return undefined; }
  return getCatalogs().find((c) => { try { return new URL(c.url).host === host; } catch { return false; } });
}

/** Catalogues anyone may add with a tap (free books, no sign-in unless said). */
export const SUGGESTED: { name: string; url: string; note: string }[] = [
  { name: 'Project Gutenberg', url: 'https://www.gutenberg.org/ebooks/search.opds/', note: 'EN · public domain' },
  { name: 'Feedbooks', url: 'https://www.feedbooks.com/catalog.atom', note: 'EN · FR · public domain' },
  { name: 'Standard Ebooks', url: 'https://standardebooks.org/feeds/opds', note: 'EN · Patrons Circle sign-in' },
  { name: 'Gallica (BnF)', url: 'https://gallica.bnf.fr/opds', note: 'FR' },
  { name: 'Wolne Lektury', url: 'https://wolnelektury.pl/opds/', note: 'PL' },
  { name: 'textos.info', url: 'https://textos.info/opds', note: 'ES' },
  { name: 'Wikisource', url: 'https://ws-export.wmcloud.org/opds/en/Ready_for_export.xml', note: 'EN' },
];

/* ---------- fetching ---------- */

function authHeaders(url: string): Record<string, string> {
  const c = catalogFor(url);
  if (!c?.user) return {};
  const raw = `${c.user}:${c.pass ?? ''}`;
  return { authorization: `Basic ${btoa(unescape(encodeURIComponent(raw)))}` };
}

const ACCEPT = 'application/atom+xml;profile=opds-catalog, application/atom+xml, application/opds+json, application/json;q=0.9, application/xml;q=0.8, */*;q=0.5';

export class OpdsError extends Error { constructor(msg: string, readonly status?: number) { super(msg); } }

/** Read a feed (either OPDS flavour) at `url`. */
export async function fetchFeed(url: string): Promise<OpdsFeed> {
  const r = await http(url, { headers: { accept: ACCEPT, ...authHeaders(url) } });
  if (r.status === 401 || r.status === 403) throw new OpdsError('auth', r.status);
  if (r.status >= 400 || !r.body) throw new OpdsError(`HTTP ${r.status}`, r.status);
  const body = r.body.trimStart();
  const ctype = r.headers['content-type'] ?? '';
  if (body.startsWith('{') || /json/.test(ctype)) return parseOpds2(JSON.parse(body) as Opds2Feed, url);
  return parseAtom(body, url);
}

/** The URL that searches `feed` for `q`, or null when the feed offers no search. */
export async function searchUrl(feed: OpdsFeed, q: string): Promise<string | null> {
  if (!feed.search) return null;
  let template = feed.search.template;
  if (!template && feed.search.description) {
    const r = await http(feed.search.description, { headers: { accept: 'application/opensearchdescription+xml, application/xml, */*', ...authHeaders(feed.search.description) } });
    const doc = new DOMParser().parseFromString(r.body, 'application/xml');
    const urls = Array.from(doc.getElementsByTagName('*')).filter((e) => e.localName === 'Url');
    const pick = urls.find((u) => /atom|opds/.test(u.getAttribute('type') ?? '')) ?? urls[0];
    template = pick?.getAttribute('template') ?? undefined;
    if (template) template = new URL(template, feed.search.description).href;
    feed.search.template = template;
  }
  if (!template) return null;
  const enc = encodeURIComponent(q);
  // Both template dialects: OpenSearch's {searchTerms} and RFC 6570's {?query} / {query}.
  let out = template.replace(/\{searchTerms\??\}/g, enc).replace(/\{\?query\}/g, `?query=${enc}`).replace(/\{query\}/g, enc);
  // Unused optional parameters ({startPage?}, {count?}…) fall away.
  out = out.replace(/\{[^}]*\?\}/g, '').replace(/[?&][^=&]+=(?=&|$)/g, '').replace(/\?&/, '?').replace(/[?&]$/, '');
  return out;
}

/* ---------- OPDS 1.x (Atom) ---------- */

const kids = (el: Element, name: string): Element[] => Array.from(el.children).filter((c) => c.localName === name);
const text = (el: Element | undefined): string => (el?.textContent ?? '').trim();
function plain(el: Element | undefined): string {
  if (!el) return '';
  const type = el.getAttribute('type') ?? 'text';
  if (type === 'text') return text(el);
  // HTML content: the words only (a parsed document runs nothing).
  const doc = new DOMParser().parseFromString(type === 'xhtml' ? new XMLSerializer().serializeToString(el) : el.textContent ?? '', 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}
const abs = (href: string, base: string): string => { try { return new URL(href, base).href; } catch { return href; } };

function parseAtom(xml: string, url: string): OpdsFeed {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.localName === 'parsererror' || doc.getElementsByTagName('parsererror').length) throw new OpdsError('parse');
  const feedLinks = kids(root, 'link').map((l) => link(l, url));
  const rel = (r: string) => feedLinks.find((l) => l.rel === r)?.href;
  const entries = root.localName === 'entry' ? [root] : kids(root, 'entry');
  const search = feedLinks.find((l) => l.rel === 'search');
  return {
    title: text(kids(root, 'title')[0]) || url, url,
    entries: entries.map((e) => entry(e, url)),
    next: rel('next'), up: rel('up'), start: rel('start'),
    search: search ? (/opensearchdescription/.test(search.type) ? { description: search.href } : { template: search.href }) : undefined,
  };
}
function link(l: Element, base: string): OpdsLink {
  return { href: abs(l.getAttribute('href') ?? '', base), rel: l.getAttribute('rel') ?? 'alternate', type: l.getAttribute('type') ?? '', title: l.getAttribute('title') ?? undefined };
}
function entry(e: Element, base: string): OpdsEntry {
  const links = kids(e, 'link').map((l) => link(l, base));
  const byRel = (r: string) => links.find((l) => l.rel === r)?.href;
  return {
    id: text(kids(e, 'id')[0]) || text(kids(e, 'title')[0]),
    title: text(kids(e, 'title')[0]),
    authors: kids(e, 'author').map((a) => text(kids(a, 'name')[0]) || text(a)).filter(Boolean),
    summary: plain(kids(e, 'summary')[0]) || plain(kids(e, 'content')[0]),
    language: text(kids(e, 'language')[0]) || undefined,
    published: text(kids(e, 'published')[0]) || text(kids(e, 'issued')[0]) || undefined,
    thumbnail: byRel('http://opds-spec.org/image/thumbnail') ?? byRel('http://opds-spec.org/thumbnail') ?? byRel('http://opds-spec.org/cover/thumbnail'),
    image: byRel('http://opds-spec.org/image') ?? byRel('http://opds-spec.org/cover'),
    links, categories: kids(e, 'category').map((c) => c.getAttribute('label') ?? c.getAttribute('term') ?? '').filter(Boolean),
  };
}

/* ---------- OPDS 2.0 (JSON) ---------- */

interface Opds2Link { href: string; rel?: string | string[]; type?: string; title?: string; templated?: boolean }
interface Opds2Pub { metadata?: { title?: string; author?: unknown; description?: string; language?: string | string[]; published?: string; subject?: unknown; identifier?: string }; links?: Opds2Link[]; images?: Opds2Link[] }
interface Opds2Feed { metadata?: { title?: string }; links?: Opds2Link[]; navigation?: Opds2Link[]; publications?: Opds2Pub[]; groups?: Opds2Feed[] }

function names(v: unknown): string[] {
  if (!v) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(names);
  if (typeof v === 'object' && 'name' in v) return names((v as { name: unknown }).name);
  return [];
}
function links2(ls: Opds2Link[] | undefined, base: string): OpdsLink[] {
  return (ls ?? []).flatMap((l) => (Array.isArray(l.rel) ? l.rel : [l.rel ?? 'alternate']).map((rel) => ({ href: l.templated ? l.href : abs(l.href, base), rel, type: l.type ?? '', title: l.title })));
}
function parseOpds2(j: Opds2Feed, url: string): OpdsFeed {
  const feedLinks = links2(j.links, url);
  const rel = (r: string) => feedLinks.find((l) => l.rel === r)?.href;
  const entries: OpdsEntry[] = [];
  const take = (f: Opds2Feed) => {
    for (const n of f.navigation ?? []) entries.push({ id: n.href, title: n.title ?? n.href, authors: [], summary: '', links: [{ href: abs(n.href, url), rel: 'subsection', type: n.type ?? 'application/opds+json' }], categories: [] });
    for (const p of f.publications ?? []) {
      const m = p.metadata ?? {}; const ls = links2(p.links, url); const imgs = links2(p.images, url);
      entries.push({
        id: m.identifier ?? m.title ?? '', title: m.title ?? '', authors: names(m.author), summary: m.description ?? '',
        language: Array.isArray(m.language) ? m.language[0] : m.language, published: m.published,
        thumbnail: imgs[0]?.href, image: imgs[imgs.length - 1]?.href, links: ls, categories: names(m.subject),
      });
    }
    for (const g of f.groups ?? []) take(g);
  };
  take(j);
  const search = feedLinks.find((l) => l.rel === 'search');
  return { title: j.metadata?.title ?? url, url, entries, next: rel('next'), up: rel('up'), start: rel('start'), search: search ? { template: search.href } : undefined };
}

/* ---------- what an entry offers ---------- */

const FEED_TYPE = /atom\+xml|opds\+json|application\/json/;
export type Acquisition = { href: string; type: string; label: string; ext: string; rel: string };

/** The feed an entry leads on to (a navigation entry), or null. */
export function entryFeed(e: OpdsEntry): string | null {
  if (acquisitions(e).length) return null;
  const l = e.links.find((l) => FEED_TYPE.test(l.type) && !/type=entry/.test(l.type)) ?? e.links.find((l) => l.rel === 'subsection' || l.rel === 'alternate');
  return l?.href ?? null;
}
/** The full entry document of a publication (OPDS 1 "complete entry"), when the feed only carried a summary. */
export function entryDocument(e: OpdsEntry): string | null {
  return e.links.find((l) => /type=entry/.test(l.type) && l.rel === 'alternate')?.href ?? null;
}

const TYPES: [RegExp, string, string][] = [
  [/epub/, 'EPUB', 'epub'], [/pdf/, 'PDF', 'pdf'], [/mobipocket|x-mobi/, 'MOBI', 'mobi'], [/azw3|vnd\.amazon/, 'AZW3', 'azw3'],
  [/cbz|comicbook\+zip/, 'CBZ', 'cbz'], [/cbr|comicbook\+rar/, 'CBR', 'cbr'], [/fb2|fictionbook/, 'FB2', 'fb2'], [/djvu/, 'DjVu', 'djvu'],
  [/text\/plain/, 'TXT', 'txt'], [/wordprocessingml/, 'DOCX', 'docx'], [/x-mpegurl|audio\/|m4b/, 'Audio', 'm4b'], [/zip/, 'ZIP', 'zip'], [/html/, 'HTML', 'html'],
];
/** The files an entry offers, EPUB first; a link that cannot be read here is not offered. */
export function acquisitions(e: OpdsEntry): Acquisition[] {
  const out: Acquisition[] = [];
  for (const l of e.links) {
    if (!l.rel.startsWith('http://opds-spec.org/acquisition') || l.rel.endsWith('/sample') || l.rel.endsWith('/buy') || l.rel.endsWith('/subscribe')) continue;
    if (FEED_TYPE.test(l.type) && !/type=entry/.test(l.type)) continue;
    const hit = TYPES.find(([re]) => re.test(l.type)) ?? (l.type ? null : [/./, l.title ?? 'File', fileExt(l.href)]);
    if (!hit) continue;
    // (A title that says more than the format — "with images", "Kindle" — is shown with it; "Download" is not.)
    const title = l.title?.trim(); const says = title && !/\b(epub|pdf|mobi|cbz|download|get|acquire|open|read|fetch)\b/i.test(title) && !new RegExp(`^${hit[1]}$`, 'i').test(title);
    out.push({ href: l.href, type: l.type, label: says ? `${hit[1]} · ${title}` : hit[1], ext: hit[2], rel: l.rel });
  }
  const order = ['epub', 'pdf', 'cbz', 'cbr', 'fb2', 'mobi', 'azw3', 'docx', 'txt', 'html', 'zip', 'm4b', 'djvu'];
  return out.sort((a, b) => order.indexOf(a.ext) - order.indexOf(b.ext));
}
function fileExt(href: string): string { const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(href); return m ? m[1].toLowerCase() : 'bin'; }

/* ---------- fetching a book into the library ---------- */

export type Progress = { pct: number; got: number; total: number };
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'book';

/** Fetch `acq` of `e` and add it to the library; the book added is returned. */
export async function downloadToLibrary(e: OpdsEntry, acq: Acquisition, onProgress: (p: Progress) => void): Promise<{ id: string; title: string }> {
  const name = `${safeName(e.title)}.${acq.ext}`;
  const auth = authHeaders(acq.href);
  const file = await fetchFile(acq.href, name, acq.type, auth, onProgress);
  const added = await importFiles([file]);
  if (!added.length) throw new OpdsError('import');
  const book = added[0];
  // The entry's own cover when the file gave none.
  if (!book.cover && (e.image || e.thumbnail)) {
    try {
      const r = await http(e.image ?? e.thumbnail!, { binary: true, headers: auth });
      if (r.status < 400 && r.body) {
        const bin = atob(r.body); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const cover = await shrinkCover(new Blob([bytes], { type: r.headers['content-type'] ?? 'image/jpeg' }));
        if (cover) await db.updateBook(book.id, (b) => { b.cover = cover; });
      }
    } catch { /* the book keeps a plain cover */ }
  }
  return { id: book.id, title: book.title };
}

async function fetchFile(url: string, name: string, mime: string, auth: Record<string, string>, onProgress: (p: Progress) => void): Promise<File> {
  const plat = nativePlatform();
  // The downloaders write to disk and report progress, but carry no sign-in: a catalogue with one goes the
  // other way, through memory (its books are small).
  if (!auth.authorization && plat === 'android') {
    const k = (window as unknown as { Capacitor: { Plugins: { Kurokawa: { downloadFile(o: { url: string; name: string; persist: boolean; connections: number }): Promise<{ path: string }>; deleteDownload?(o: { path: string }): Promise<unknown>; addListener?(ev: string, fn: (p: Progress) => void): Promise<{ remove(): void }> } } } }).Capacitor.Plugins.Kurokawa;
    const sub = await k.addListener?.('downloadProgress', onProgress);
    try {
      const { path } = await k.downloadFile({ url, name, persist: false, connections: 2 });
      const file = await readContentUri(path, name, mime);
      void k.deleteDownload?.({ path }).catch(() => undefined);
      return file;
    } finally { sub?.remove(); }
  }
  const dk = window.kurokawaDesktop as unknown as { download?(u: string, n: string): Promise<string>; onDownloadProgress?(cb: (p: Progress) => void): void; readFile(p: string): Promise<ArrayBuffer>; deleteDownload?(p: string): Promise<boolean> } | undefined;
  if (!auth.authorization && plat === 'desktop' && dk?.download) {
    dk.onDownloadProgress?.(onProgress);
    const path = await dk.download(url, name);
    const file = new File([await dk.readFile(path)], name, { type: mime });
    void dk.deleteDownload?.(path).catch(() => false);
    return file;
  }
  onProgress({ pct: 0, got: 0, total: 0 });
  const r = await http(url, { binary: true, headers: auth });
  if (r.status === 401 || r.status === 403) throw new OpdsError('auth', r.status);
  if (r.status >= 400 || !r.body) throw new OpdsError(`HTTP ${r.status}`, r.status);
  const bin = atob(r.body); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  onProgress({ pct: 100, got: bytes.length, total: bytes.length });
  return new File([bytes], name, { type: mime || r.headers['content-type'] || '' });
}
