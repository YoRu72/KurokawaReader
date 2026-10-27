// A web folder as a source: the page a server makes for a folder that has no page of its own — the "Index
// of" listings of Apache, nginx, lighttpd, Caddy, Python's http.server, h5ai and the like, or their JSON
// form — with files and folders in it. The reader adds one by its address; its folders are browsed like
// shelves, a folder of volumes shown as one page — every volume with its cover and contents, fetched one at
// a time or all at once — and a folder of folders as a shelf of covers (each the cover of its first volume).
// A search walks the folders for names. Nothing about the folder is known beforehand: what it lists is what
// there is.
import { request, fetchBytes, pool } from './http';
import { t, formatBytes, countVolumes } from '../i18n';
import { SourceError, type Source, type SourceBook, type SourceDetails, type SourceFile, type SourcePage, type FilterValues, type SourceFilter } from './types';
import { peekFile, peekKnown, thumbOf, recall, remember, known, keyOf } from './peek';
import type { Repo } from './repos';

export interface DirEntry { name: string; url: string; dir: boolean; size?: number; date?: string; ext?: string }

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
export const isBook = (e: DirEntry): boolean => !e.dir && !!e.ext && e.ext in BOOK_EXT;
const isImage = (e: DirEntry): boolean => !e.dir && /^(jpe?g|png|webp|gif)$/.test(e.ext ?? '');
const withSlash = (u: string) => (u.endsWith('/') ? u : u + '/');
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const num = (v: unknown): number | undefined => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 ? n : undefined; };
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const stamp = (ms: number) => { const d = new Date(ms); return Number.isNaN(d.getTime()) ? undefined : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

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
  const push = (href: string, dirHint: boolean, size?: number, date?: string) => {
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
    out.push({ name, url: `${root.origin}${root.pathname}${enc}${dir ? '/' : ''}`, dir, size: dir ? undefined : size, date, ext });
  };
  const text = body.trim();
  // The JSON forms: nginx's autoindex_format json ([{name,type,mtime,size}]), Caddy's ([{name,size,url,mod_time,is_dir}]),
  // h5ai's API ({items:[{href,time,size}]}), a few others.
  if (/json/i.test(type) || /^[[{]/.test(text)) {
    try {
      const j = JSON.parse(text) as unknown;
      const arr = Array.isArray(j) ? j : j && typeof j === 'object' ? ((j as Record<string, unknown>).items ?? (j as Record<string, unknown>).files ?? (j as Record<string, unknown>).entries) : null;
      if (Array.isArray(arr)) {
        for (const e of arr as Record<string, unknown>[]) {
          const href = str(e.href);
          if (href) { push(href, href.endsWith('/'), num(e.size), typeof e.time === 'number' ? stamp(e.time) : str(e.time)); continue; }
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

/** Whether a page is a folder's listing rather than a site's page: it has a book among its direct children,
 *  or calls itself an index, or is made mostly of links to its own direct children. */
export function isListing(url: string, body: string, type = ''): boolean {
  if (/\/_h5ai\//.test(body)) return true;
  const entries = parseListing(url, body, type);
  if (!entries.length) return false;
  if (entries.some(isBook)) return true;
  if (/json/i.test(type)) return entries.length > 0;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1] ?? '';
  if (/index of|directory listing|directory of|listing of|فهرس|محتويات المجلد/i.test(title) || /<h1[^>]*>\s*index of/i.test(body)) return true;
  const links = (body.match(/<a\s[^>]*href=/gi) ?? []).length;
  return entries.length >= 3 && entries.length >= links * 0.6;
}

/** The last part of a folder's address as its name ("Novels" for …/Novels/), else its host. */
export function folderName(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) return dec(seg).replace(/[_+]/g, ' ').trim() || u.host;
    return u.host;
  } catch { return url; }
}

/** The number of a volume in its name: after "Vol."/"Volume"/"v"/"Book"/"Part"/"#", "المجلد"/"الجزء", "第…巻",
 *  else the last small number in it (a year is not a volume). */
export function volumeNumber(name: string): number | undefined {
  const s = name.replace(/\.[a-z0-9]{1,5}$/i, '');
  const m = /(?:\b(?:vol(?:ume)?|v|book|part|tome|bd|band|ln)\.?\s*|#\s*|第\s*)(\d+(?:\.\d+)?)/i.exec(s) ?? /(?:المجلد|الجزء|مجلد|جزء)\s*(\d+)/.exec(s);
  if (m) return Number(m[1]);
  const nums = [...s.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d)?)(?![\d])/g)].map((x) => Number(x[1]));
  return nums.length ? nums[nums.length - 1] : undefined;
}
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
/** Volumes in reading order: by their number where both have one, else by name. */
export function volumeOrder(a: DirEntry, b: DirEntry): number {
  const x = volumeNumber(a.name), y = volumeNumber(b.name);
  if (x !== undefined && y !== undefined && x !== y) return x - y;
  if ((x === undefined) !== (y === undefined)) return x === undefined ? 1 : -1;
  return natural(a.name, b.name);
}
/** The first volume of a folder: the first EPUB in reading order, else the first PDF, else the first book. */
function firstVolume(entries: DirEntry[]): DirEntry | undefined {
  const books = entries.filter(isBook).sort(volumeOrder);
  return books.find((e) => e.ext === 'epub') ?? books.find((e) => e.ext === 'pdf') ?? books[0];
}

/* ---------- listings, fetched and kept a while ---------- */
const listings = new Map<string, { at: number; entries: DirEntry[] }>();
const KEEP = 15 * 60000;
export function forgetListings(prefix?: string): void { for (const k of [...listings.keys()]) if (!prefix || k.startsWith(prefix)) listings.delete(k); }

/** The entries of a folder, from the site (or from a listing fetched a few minutes ago). */
export async function listFolder(url: string, quiet = false): Promise<DirEntry[]> {
  const key = withSlash(url);
  const had = listings.get(key); if (had && Date.now() - had.at < KEEP) return had.entries;
  const r = await request(key, { headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }, quiet, retries: 1 });
  if (r.status === 429) throw new SourceError('rate', 'rate', 429);
  if (r.status === 401 || r.status === 403) throw new SourceError('auth', 'auth', r.status);
  if (r.status >= 400) throw new SourceError(`HTTP ${r.status}`, 'http', r.status);
  const base = r.url && /^https?:/.test(r.url) ? withSlash(r.url.replace(/[?#].*$/, '')) : key;
  let entries = parseListing(base, r.body, r.headers['content-type'] ?? '');
  // (h5ai draws its list with a script; when its page has no table to read, its own API is asked.)
  if (!entries.length && /\/_h5ai\//.test(r.body)) {
    const api = await request(`${base}?`, { method: 'POST', headers: { 'content-type': 'application/json;charset=utf-8', accept: 'application/json' }, body: JSON.stringify({ action: 'get', items: { href: new URL(base).pathname, what: 1 } }), quiet, retries: 1 }).catch(() => null);
    if (api && api.status < 400) entries = parseListing(base, api.body, 'application/json');
  }
  // (The listing's own order is whatever the server chose; folders first, then the names in order, is what a reader expects.)
  entries.sort((a, b) => (a.dir === b.dir ? natural(a.name, b.name) : a.dir ? -1 : 1));
  listings.set(key, { at: Date.now(), entries });
  return entries;
}

/* ---------- the source ---------- */
/** A folder inside the root is known by its path from the root: its segments as the server spells them,
 *  joined by "/"; "" is the root. */
const urlOf = (root: string, rel: string) => withSlash(root) + (rel ? withSlash(rel) : '');
const crumbsOf = (rel: string) => rel.split('/').filter(Boolean).map(dec);
const noExt = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/i, '');
const segOf = (e: DirEntry) => e.url.replace(/\/+$/, '').split('/').pop() ?? encodeURIComponent(e.name);
const childRel = (rel: string, e: DirEntry) => (rel ? `${rel}/${segOf(e)}` : segOf(e));
const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[ً-ْٰـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/[-_.+,:;!?'"()[\]{}]+/g, ' ').toLowerCase();

/** The kinds of file a search or a folder can be narrowed to. */
const KINDS: [string, string[]][] = [['EPUB', ['epub']], ['PDF', ['pdf']], ['Kindle', ['mobi', 'azw', 'azw3', 'kf8', 'prc']], ['Text', ['txt', 'md', 'html', 'htm', 'xhtml', 'fb2', 'docx', 'odt', 'rtf']], ['Audio', ['m4b', 'mp3', 'm4a', 'ogg', 'opus', 'flac']]];

export function fileOf(e: DirEntry, rel: string): SourceFile {
  const ext = e.ext ?? ''; const [label, mime] = BOOK_EXT[ext] ?? [ext.toUpperCase(), ''];
  return { id: rel, label, ext, size: e.size, url: e.url, mime, name: e.name };
}

export function folderSource(repo: Repo): Source {
  const root = withSlash(repo.url);
  const srcId = `dir:${repo.key}`;
  const wanted = (f: FilterValues) => { const kinds = Array.isArray(f.kinds) ? f.kinds : []; if (!kinds.length) return () => true; const exts = new Set(KINDS.filter(([k]) => kinds.includes(k)).flatMap(([, e]) => e)); return (e: DirEntry) => e.dir || (!!e.ext && exts.has(e.ext)); };
  const order = (f: FilterValues) => (a: DirEntry, b: DirEntry) => f.sort === 'newest' ? (b.date ?? '').localeCompare(a.date ?? '') || volumeOrder(a, b) : f.sort === 'biggest' ? (b.size ?? 0) - (a.size ?? 0) || volumeOrder(a, b) : volumeOrder(a, b);
  const folderCard = (e: DirEntry, rel: string, where?: string): SourceBook => ({ id: `d:${rel}`, title: e.name, openShelf: rel, look: 'folder', author: where, year: e.date });
  const volume = (e: DirEntry, rel: string, where?: string): SourceBook => ({ id: `f:${rel}`, title: noExt(e.name), look: 'volume', badge: e.ext ? BOOK_EXT[e.ext]?.[0] ?? e.ext.toUpperCase() : undefined, author: where, year: e.date, file: fileOf(e, rel) });
  // A search's matches are gathered once and paged from memory.
  const searches = new Map<string, { items: SourceBook[]; partial: boolean }>();
  const search = async (q: string, rel: string, f: FilterValues): Promise<{ items: SourceBook[]; partial: boolean }> => {
    const key = `${rel}\u0000${q}\u0000${JSON.stringify(f.kinds ?? [])}`;
    const had = searches.get(key); if (had) return had;
    const words = norm(q).split(/\s+/).filter(Boolean);
    const keep = wanted(f);
    const found: { e: DirEntry; rel: string; where: string }[] = [];
    // Breadth first from the folder in view, a few folders at a time, within a budget of folders and time.
    const started = Date.now(); let fetched = 0; let partial = false;
    let layer = [rel];
    while (layer.length) {
      if (fetched >= 200 || Date.now() - started > 20000) { partial = true; break; }
      const take = layer.slice(0, Math.max(1, Math.min(layer.length, 200 - fetched))); layer = layer.slice(take.length);
      const next: string[] = [];
      await pool(take, 4, async (r) => {
        let entries: DirEntry[];
        try { entries = await listFolder(urlOf(root, r), true); fetched++; } catch { partial = true; return; }
        const where = crumbsOf(r).join(' / ');
        for (const e of entries) {
          const cr = childRel(r, e);
          if (e.dir) next.push(cr);
          if (!e.dir && !isBook(e)) continue;
          if (!keep(e)) continue;
          // Every word somewhere in the folder's path and the name, one at least in the name itself.
          const own = norm(e.name); const hay = `${norm(where)} ${own}`;
          if (words.every((w) => hay.includes(w)) && words.some((w) => own.includes(w))) found.push({ e, rel: cr, where });
        }
      });
      layer.push(...next);
    }
    found.sort((a, b) => (a.e.dir !== b.e.dir ? (a.e.dir ? -1 : 1) : natural(a.where, b.where) || volumeOrder(a.e, b.e)));
    const res = { items: found.map((x) => (x.e.dir ? folderCard(x.e, x.rel, x.where) : volume(x.e, x.rel, x.where))), partial };
    searches.set(key, res);
    return res;
  };
  const src: Source = {
    id: srcId, name: repo.name, lang: '', description: t('folderSourceDesc'), site: root,
    filters(): SourceFilter[] {
      return [
        { id: 'kinds', label: t('fileKinds'), kind: 'multi', options: KINDS.map(([k]) => ({ value: k, label: k })), value: [] },
        { id: 'sort', label: t('sortBy'), kind: 'sort', options: [{ value: 'name', label: t('sortName') }, { value: 'newest', label: t('sortNewest') }, { value: 'biggest', label: t('sortBiggest') }], value: 'name' },
      ];
    },
    async browse(q, f, pageNo, shelf): Promise<SourcePage> {
      const rel = (shelf ?? '').replace(/^\/+|\/+$/g, '');
      const crumbs = crumbsOf(rel);
      const title = crumbs.length ? crumbs[crumbs.length - 1] : undefined;
      const PAGE = 80;
      if (q.trim()) {
        const r = await search(q.trim(), rel, f);
        const slice = r.items.slice((pageNo - 1) * PAGE, pageNo * PAGE);
        return { items: slice, hasMore: pageNo * PAGE < r.items.length, title: `${t('searchResultsIn', { n: String(r.items.length) })}${r.partial ? ' …' : ''}${title ? ` · ${title}` : ''}` };
      }
      const all = await listFolder(urlOf(root, rel));
      const folders = all.filter((e) => e.dir);
      const files = all.filter(isBook).filter(wanted(f)).sort(order(f));
      const list: SourceBook[] = [...folders.map((e) => folderCard(e, childRel(rel, e))), ...files.map((e) => volume(e, childRel(rel, e)))];
      const items = list.slice((pageNo - 1) * PAGE, pageNo * PAGE);
      // A folder with books in it opens as their page: the series' card, then its volumes one under another.
      if (pageNo === 1 && files.length) {
        const total = files.reduce((n, e) => n + (e.size ?? 0), 0);
        items.unshift({ id: `a:${rel}`, title: title ?? repo.name, look: 'series', author: crumbs.length > 1 ? crumbs.slice(0, -1).join(' / ') : undefined, badge: countVolumes(files.length), description: total ? formatBytes(total) : undefined, files: files.map((e) => fileOf(e, childRel(rel, e))), formats: [...new Set(files.map((e) => BOOK_EXT[e.ext!]?.[0] ?? ''))].filter(Boolean) });
      }
      return { items, hasMore: pageNo * PAGE < list.length, title };
    },
    async details(id): Promise<SourceDetails> {
      const kind = id.slice(0, 2); const rel = id.slice(2);
      if (kind !== 'f:') throw new SourceError('notFound', 'parse');
      const parts = rel.split('/'); const last = parts.pop() ?? ''; const parent = parts.join('/');
      const entries = await listFolder(urlOf(root, parent));
      const e = entries.find((x) => !x.dir && (segOf(x) === last || x.name === dec(last)));
      if (!e) throw new SourceError('notFound', 'http', 404);
      const file = fileOf(e, rel);
      const crumbs = crumbsOf(parent);
      const meta: { label: string; value: string }[] = [{ label: t('fileName'), value: e.name }];
      if (e.size !== undefined) meta.push({ label: t('fileSize'), value: formatBytes(e.size) });
      if (e.date) meta.push({ label: t('fileDate'), value: e.date });
      if (crumbs.length) meta.push({ label: t('folderPath'), value: `/${crumbs.join('/')}` });
      const peek = /^(epub|pdf)$/.test(file.ext) ? await peekFile(file.url, file.ext, file.size).catch(() => null) : null;
      return { id, title: peek?.title || noExt(e.name), author: peek?.author || (crumbs.length ? crumbs.join(' / ') : undefined), cover: peek?.cover, tags: [], files: [file], url: e.url, meta, formats: [file.label], toc: peek?.toc };
    },
    async fetchFile(_book, file, onProgress): Promise<File> {
      const bytes = await fetchBytes(file.url, onProgress, { headers: { referer: root } });
      return new File([bytes.buffer as ArrayBuffer], file.name ?? `${noExt(folderName(file.url))}.${file.ext}`, { type: file.mime ?? '' });
    },
    async peek(b) {
      const f = b.file; if (!f || !/^(epub|pdf)$/.test(f.ext)) return null;
      return peekFile(f.url, f.ext, f.size);
    },
    peekNow: (b) => (b.file ? peekKnown(b.file.url, b.file.size) : undefined),
    folderCoverNow: (rel) => known(`peek:dir:${keyOf(urlOf(root, rel))}`),
    async folderCover(rel) {
      // A folder's own picture (cover.jpg…) when it has one, else the cover of its first volume — a folder
      // of folders looked into one level down. Kept for a week.
      const key = `peek:dir:${keyOf(urlOf(root, rel))}`;
      const had = await recall(key, 7 * 86400000); if (had) return had;
      let at = rel; let count = 0;
      for (let depth = 0; depth < 2; depth++) {
        const entries = await listFolder(urlOf(root, at), true);
        const books = entries.filter(isBook);
        if (depth === 0) count = books.length;
        const img = entries.filter(isImage).find((e) => /^(cover|folder|poster|front|thumb)/i.test(e.name)) ?? (entries.filter(isImage).length === 1 ? entries.find(isImage) : undefined);
        if (img) { const cover = await thumbOf(img.url); if (cover) { const p = { cover, count, at: Date.now() }; remember(key, p); return p; } }
        const v1 = firstVolume(entries);
        if (v1 && /^(epub|pdf)$/.test(v1.ext ?? '')) { const peek = await peekFile(v1.url, v1.ext!, v1.size); const p = { cover: peek?.cover, count, at: Date.now() }; if (peek) remember(key, p); return p; }
        if (books.length) break;
        const sub = entries.filter((e) => e.dir).sort((a, b) => natural(a.name, b.name))[0];
        if (!sub) break;
        at = childRel(at, sub);
      }
      return { count, at: Date.now() };
    },
  };
  return src;
}
