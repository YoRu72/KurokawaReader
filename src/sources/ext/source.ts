// An extension as a Source: the plugin's popular/latest lists and search as shelves and a query, its filters
// as the filter sheet, a novel's page with its chapters — and the novel as a book of the library: a JSON
// file holding the card and the chapter list, filled chapter by chapter as it is read (sources/ext/… and
// formats/webnovel.ts), or fetched whole for offline.
import { db, uid, type Book } from '../../db';
import { listRepos, pluginCode, pluginKey, langLabel, type Repo, type ExtItem } from '../repos';
import { loadPlugin, callPlugin, isLoaded, withQuiet } from './sandbox';
import { pool, fetchBytes } from '../http';
import { SourceError, type Source, type SourceFilter, type FilterValues, type SourcePage, type SourceBook, type SourceDetails, type SourceChapter } from '../types';

/* ---------- ids ---------- */
export const SRC_PREFIX = 'ext:';
export const sourceIdOf = (repo: Repo, item: ExtItem) => `${SRC_PREFIX}${repo.key}:${encodeURIComponent(item.id)}`;
export function parseSourceId(id: string): { repoKey: string; pluginId: string } | null {
  if (!id.startsWith(SRC_PREFIX)) return null;
  const rest = id.slice(SRC_PREFIX.length); const i = rest.indexOf(':'); if (i < 0) return null;
  return { repoKey: rest.slice(0, i), pluginId: decodeURIComponent(rest.slice(i + 1)) };
}

/* ---------- the plugin, loaded ---------- */
export interface LnInfo { id: string; name: string; site: string; version: string; lang?: string; icon?: string; filters: Record<string, { label: string; type: string; value: unknown; options?: { label: string; value: string }[] }> | null; pluginSettings: Record<string, { label: string; value: unknown; type?: string; options?: { label: string; value: string }[] }> | null; imageRequestInit: { headers?: Record<string, string> } | null; hasPages: boolean }
export interface MyInfo { source: Record<string, unknown>; filters: unknown[]; prefs: unknown[]; supportsLatest: boolean; headers: Record<string, string> | null }
export interface Handle { repo: Repo; item: ExtItem; key: string; kind: 'lnreader' | 'mangayomi'; ln?: LnInfo; my?: MyInfo; source: Source }
const handles = new Map<string, Promise<Handle>>();

export async function findItem(srcId: string): Promise<{ repo: Repo; item: ExtItem } | null> {
  const p = parseSourceId(srcId); if (!p) return null;
  const repo = (await listRepos()).find((r) => r.key === p.repoKey); if (!repo) return null;
  const item = repo.items.find((i) => i.id === p.pluginId); if (!item) return null;
  return { repo, item };
}

/** The extension, running: its code fetched (or taken from the device) and loaded into the sandbox. */
export function extHandle(srcId: string, fresh = false): Promise<Handle> {
  if (fresh) handles.delete(srcId);
  let h = handles.get(srcId);
  if (!h) {
    h = (async () => {
      const found = await findItem(srcId); if (!found) throw new SourceError('noExtension', 'parse');
      const { repo, item } = found;
      if (!item.runnable) throw new SourceError('notRunnable', 'parse');
      const key = pluginKey(repo.key, item.id);
      const code = await pluginCode(repo, item, fresh);
      if (fresh || !isLoaded(key)) await loadPlugin(key, item.kind as 'lnreader' | 'mangayomi', code.code, { pluginId: item.id, source: item.source ?? { name: item.name, lang: item.lang, baseUrl: item.site, iconUrl: item.icon, version: item.version, itemType: 2 } });
      const handle: Handle = { repo, item, key, kind: item.kind as 'lnreader' | 'mangayomi', source: null as unknown as Source };
      if (handle.kind === 'lnreader') handle.ln = await callPlugin<LnInfo>(key, 'info');
      else handle.my = await callPlugin<MyInfo>(key, 'info');
      handle.source = makeSource(srcId, handle);
      return handle;
    })();
    handles.set(srcId, h);
    h.catch(() => handles.delete(srcId));
  }
  return h;
}
export function forgetHandle(srcId: string): void { handles.delete(srcId); }

/* ---------- filters ---------- */
function lnFilters(info: LnInfo): SourceFilter[] {
  const out: SourceFilter[] = [];
  for (const [id, f] of Object.entries(info.filters ?? {})) {
    const opts = (f.options ?? []).map((o) => ({ value: String(o.value), label: String(o.label) }));
    if (f.type === 'Picker') out.push({ id, label: f.label, kind: 'select', options: opts, value: String(f.value ?? opts[0]?.value ?? '') });
    else if (f.type === 'Checkbox') out.push({ id, label: f.label, kind: 'multi', options: opts, value: Array.isArray(f.value) ? (f.value as string[]).map(String) : [] });
    else if (f.type === 'XCheckbox') { const v = (f.value ?? {}) as { include?: string[]; exclude?: string[] }; out.push({ id, label: f.label, kind: 'multi', options: opts, value: v.include ?? [] }); out.push({ id: `${id}\u0000x`, label: `${f.label} — ✕`, kind: 'multi', options: opts, value: v.exclude ?? [] }); }
    else if (f.type === 'Switch') out.push({ id, label: f.label, kind: 'toggle', value: !!f.value });
    else out.push({ id, label: f.label, kind: 'text', value: String(f.value ?? '') });
  }
  return out;
}
function lnFilterValues(info: LnInfo, v: FilterValues): Record<string, { type: string; value: unknown }> | undefined {
  if (!info.filters) return undefined;
  const out: Record<string, { type: string; value: unknown }> = {};
  for (const [id, f] of Object.entries(info.filters)) {
    let value: unknown = v[id] ?? f.value;
    if (f.type === 'XCheckbox') value = { include: (v[id] as string[]) ?? [], exclude: (v[`${id}\u0000x`] as string[]) ?? [] };
    else if (f.type === 'Checkbox') value = Array.isArray(value) ? value : [];
    else if (f.type === 'Switch') value = !!value;
    else value = String(value ?? '');
    out[id] = { type: f.type, value };
  }
  return out;
}
type MyFilter = Record<string, unknown> & { type_name?: string; type?: string; name?: string; state?: unknown; values?: MyFilter[]; value?: string };
function myFilters(info: MyInfo): SourceFilter[] {
  const out: SourceFilter[] = [];
  const walk = (list: MyFilter[], prefix: string) => {
    list.forEach((f, i) => {
      const id = `${prefix}${i}`; const name = String(f.name ?? '');
      switch (f.type_name) {
        case 'SelectFilter': { const opts = (f.values ?? []).map((o, j) => ({ value: String(j), label: String(o.name ?? o.value ?? j) })); out.push({ id, label: name, kind: 'select', options: opts, value: String(Number(f.state ?? 0)) }); break; }
        case 'SortFilter': { const opts = (f.values ?? []).map((o, j) => ({ value: String(j), label: String(o.name ?? o.value ?? j) })); const st = (f.state ?? {}) as { index?: number; ascending?: boolean }; out.push({ id, label: name, kind: 'sort', options: opts, value: String(st.index ?? 0) }); out.push({ id: `${id}\u0000asc`, label: `${name} ↑`, kind: 'toggle', value: !!st.ascending }); break; }
        case 'TextFilter': out.push({ id, label: name, kind: 'text', value: String(f.state ?? '') }); break;
        case 'CheckBox': out.push({ id, label: name, kind: 'toggle', value: !!f.state }); break;
        case 'TriState': out.push({ id, label: name, kind: 'select', options: [{ value: '0', label: '—' }, { value: '1', label: '✓' }, { value: '2', label: '✕' }], value: String(Number(f.state ?? 0)) }); break;
        case 'GroupFilter': {
          const kids = (f.state ?? []) as MyFilter[];
          const simple = kids.every((k) => k.type_name === 'CheckBox' || k.type_name === 'TriState');
          if (simple && kids.length) {
            const opts = kids.map((k, j) => ({ value: String(j), label: String(k.name ?? k.value ?? j) }));
            out.push({ id, label: name, kind: 'multi', options: opts, value: kids.map((k, j) => (k.type_name === 'CheckBox' ? (k.state ? String(j) : '') : Number(k.state) === 1 ? String(j) : '')).filter(Boolean) });
            if (kids.some((k) => k.type_name === 'TriState')) out.push({ id: `${id}\u0000x`, label: `${name} — ✕`, kind: 'multi', options: opts, value: kids.map((k, j) => (k.type_name === 'TriState' && Number(k.state) === 2 ? String(j) : '')).filter(Boolean) });
          } else walk(kids, `${id}.`);
          break;
        }
        default: break;   // HeaderFilter, SeparatorFilter
      }
    });
  };
  walk((info.filters ?? []) as MyFilter[], '');
  return out;
}
/** The extension's filter list with the reader's choices written into its states. */
function myFilterState(info: MyInfo, v: FilterValues): unknown[] {
  const clone = JSON.parse(JSON.stringify(info.filters ?? [])) as MyFilter[];
  const walk = (list: MyFilter[], prefix: string) => {
    list.forEach((f, i) => {
      const id = `${prefix}${i}`;
      switch (f.type_name) {
        case 'SelectFilter': if (v[id] !== undefined) f.state = Number(v[id]); break;
        case 'SortFilter': { const st = (f.state ?? { index: 0, ascending: false }) as { index: number; ascending: boolean }; if (v[id] !== undefined) st.index = Number(v[id]); if (v[`${id}\u0000asc`] !== undefined) st.ascending = !!v[`${id}\u0000asc`]; f.state = st; break; }
        case 'TextFilter': if (v[id] !== undefined) f.state = String(v[id]); break;
        case 'CheckBox': if (v[id] !== undefined) f.state = !!v[id]; break;
        case 'TriState': if (v[id] !== undefined) f.state = Number(v[id]); break;
        case 'GroupFilter': {
          const kids = (f.state ?? []) as MyFilter[];
          const simple = kids.every((k) => k.type_name === 'CheckBox' || k.type_name === 'TriState');
          if (simple && kids.length) {
            const inc = (v[id] as string[] | undefined); const exc = (v[`${id}\u0000x`] as string[] | undefined);
            if (inc || exc) kids.forEach((k, j) => { const on = (inc ?? []).includes(String(j)), off = (exc ?? []).includes(String(j)); if (k.type_name === 'CheckBox') k.state = on; else k.state = on ? 1 : off ? 2 : 0; });
          } else walk(kids, `${id}.`);
          break;
        }
      }
    });
  };
  walk(clone, '');
  return clone;
}
const isDefault = (defs: SourceFilter[], v: FilterValues) => defs.every((d) => JSON.stringify(v[d.id] ?? d.value) === JSON.stringify(d.value));

/* ---------- the Source ---------- */
interface NovelItem { name: string; path: string; cover?: string }
interface LnNovel { name: string; path: string; cover?: string; genres?: string; summary?: string; author?: string; artist?: string; status?: string; chapters: { name: string; path: string; chapterNumber?: number; releaseTime?: string; page?: string }[]; totalPages?: number }
interface MyNovel { name?: string; imageUrl?: string; description?: string; author?: string; artist?: string; status?: number; genre?: string[]; chapters?: { name: string; url: string; dateUpload?: string; scanlator?: string }[] }
const STATUS_MY = ['Ongoing', 'Completed', 'On Hiatus', 'Cancelled', 'Publishing Finished', 'Unknown'];

function makeSource(srcId: string, h: Handle): Source {
  const name = h.item.name; const site = h.item.site || String(h.my?.source.baseUrl ?? h.ln?.site ?? '');
  const defs = () => (h.ln ? lnFilters(h.ln) : myFilters(h.my!));
  return {
    id: srcId, name, lang: h.item.lang, site, needsApp: true,
    description: '',
    filters: defs,
    shelves: async () => [{ id: 'popular', label: '★' }, { id: 'latest', label: '⟳' }],
    async browse(q, f, page, shelf): Promise<SourcePage> {
      const text = q.trim();
      let list: NovelItem[] = []; let hasMore = true;
      if (h.ln) {
        if (text) list = await callPlugin<NovelItem[]>(h.key, 'searchNovels', text, page);
        else list = await callPlugin<NovelItem[]>(h.key, 'popularNovels', page, { showLatestNovels: shelf === 'latest', filters: lnFilterValues(h.ln, f) });
        hasMore = list.length > 0;
      } else {
        const my = h.my!; const d = defs();
        let r: { list: { name: string; imageUrl?: string; link: string }[]; hasNextPage: boolean };
        if (text || !isDefault(d, f)) r = await callPlugin(h.key, 'search', text, page, myFilterState(my, f));
        else if (shelf === 'latest' && my.supportsLatest) r = await callPlugin(h.key, 'getLatestUpdates', page);
        else r = await callPlugin(h.key, 'getPopular', page);
        list = (r?.list ?? []).map((x) => ({ name: x.name, path: x.link, cover: x.imageUrl }));
        hasMore = !!r?.hasNextPage && list.length > 0;
      }
      const items: SourceBook[] = list.filter((n) => n && n.path).map((n) => ({ id: n.path, title: n.name, cover: n.cover || undefined, lang: undefined }));
      return { items, hasMore };
    },
    async details(id): Promise<SourceDetails> {
      const novel = await fetchNovel(h, id);
      const chapters: SourceChapter[] = novel.chapters.map((c, i) => ({ id: c.path, title: c.name, level: 0, page: i + 1 }));
      const meta: { label: string; value: string }[] = [];
      if (novel.status) meta.push({ label: 'status', value: novel.status });
      return { id, title: novel.title, author: novel.author, cover: novel.cover, lang: h.item.lang, description: novel.summary, badge: novel.status, tags: novel.genres.map((g) => ({ id: g, label: g })), files: [], chapters, pages: novel.chapters.length, meta, url: novel.url, raw: novel };
    },
  };
}

/* ---------- a novel ---------- */
export interface WebChapter { name: string; path: string; released?: string; n?: number }
export interface WebNovel {
  v: 1; src: string; path: string; url?: string; title: string; author?: string; cover?: string; summary?: string; genres: string[]; status?: string; lang?: string;
  chapters: WebChapter[]; content: Record<string, { html: string; at: number }> | null; fetchedAt?: number; imageHeaders?: Record<string, string>;
}
const novelCache = new Map<string, { at: number; novel: WebNovel }>();

/** The novel's card and all its chapters (every page of them), in reading order. */
export async function fetchNovel(h: Handle, path: string, fresh = false): Promise<WebNovel> {
  const ck = `${h.key}|${path}`;
  const had = novelCache.get(ck); if (had && !fresh && Date.now() - had.at < 120000) return had.novel;
  let novel: WebNovel;
  if (h.ln) {
    const n = await callPlugin<LnNovel>(h.key, 'parseNovel', path);
    if (!n) throw new SourceError('parse', 'parse');
    let chapters = (n.chapters ?? []).slice();
    if (n.totalPages && n.totalPages > 1 && h.ln.hasPages) {
      const pages = Array.from({ length: Math.min(n.totalPages, 400) - 1 }, (_, i) => String(i + 2));
      const more = await pool(pages, 2, async (p) => { try { return (await callPlugin<{ chapters: LnNovel['chapters'] }>(h.key, 'parsePage', path, p))?.chapters ?? []; } catch { return []; } });
      for (const m of more) chapters.push(...m);
    }
    chapters = chapters.filter((c) => c && c.path);
    const url = await callPlugin<string>(h.key, 'resolveUrl', path, true).catch(() => undefined);
    novel = { v: 1, src: sourceIdOf(h.repo, h.item), path, url, lang: langOf(h.item.lang), title: n.name || path, author: n.author || undefined, cover: n.cover || undefined, summary: n.summary || undefined, genres: splitGenres(n.genres), status: n.status || undefined, chapters: chapters.map((c, i) => ({ name: c.name, path: c.path, released: c.releaseTime || undefined, n: c.chapterNumber ?? i + 1 })), content: null, imageHeaders: h.ln.imageRequestInit?.headers };
  } else {
    const n = await callPlugin<MyNovel>(h.key, 'getDetail', path);
    if (!n) throw new SourceError('parse', 'parse');
    let chapters = (n.chapters ?? []).filter((c) => c && c.url);
    // (Mangayomi lists the newest chapter first, as manga apps do; a book reads from the first.)
    if (chapters.length > 1 && !looksAscending(chapters)) chapters = chapters.slice().reverse();
    novel = { v: 1, src: sourceIdOf(h.repo, h.item), path, url: path, lang: langOf(h.item.lang), title: n.name || path, author: n.author || undefined, cover: n.imageUrl || undefined, summary: n.description || undefined, genres: (n.genre ?? []).map(String).filter(Boolean), status: typeof n.status === 'number' ? STATUS_MY[n.status] ?? undefined : undefined, chapters: chapters.map((c, i) => ({ name: c.name, path: c.url, released: c.dateUpload ? new Date(Number(c.dateUpload)).toISOString() : undefined, n: i + 1 })), content: null, imageHeaders: h.my?.headers ?? undefined };
  }
  novelCache.set(ck, { at: Date.now(), novel });
  return novel;
}
function looksAscending(ch: { name: string; dateUpload?: string }[]): boolean {
  const a = Number(ch[0].dateUpload), b = Number(ch[ch.length - 1].dateUpload);
  if (a && b && a !== b) return a < b;
  const na = /\d+(?:\.\d+)?/.exec(ch[0].name)?.[0], nb = /\d+(?:\.\d+)?/.exec(ch[ch.length - 1].name)?.[0];
  if (na && nb && na !== nb) return Number(na) < Number(nb);
  return false;
}
const langOf = (lang: string): string | undefined => { const l = langLabel(lang).toLowerCase(); return /^[a-z]{2}$/.test(l) ? l : undefined; };
const splitGenres = (g?: string) => (g ?? '').split(/[,،/|•]+/).map((s) => s.trim()).filter((s) => s && s.length < 40);

/** A chapter's text, as the site gives it, cleaned for the reader. */
export async function fetchChapter(h: Handle, novel: WebNovel, chapter: WebChapter): Promise<string> {
  let html: string;
  if (h.ln) html = await callPlugin<string>(h.key, 'parseChapter', chapter.path);
  else html = await callPlugin<string>(h.key, 'getHtmlContent', novel.title, chapter.path);
  if (typeof html !== 'string') html = String(html ?? '');
  if (html.length >= 2 && html.startsWith('"') && html.endsWith('"')) { try { html = JSON.parse(html); } catch { /* as is */ } }
  return cleanChapter(html, h.item.site);
}

/** The chapter's HTML with nothing but text, its marks, images and links: scripts, styles, forms, frames gone;
 *  no attributes besides the few the reader uses; relative addresses made absolute. */
export function cleanChapter(html: string, site: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, input, button, select, textarea, noscript, link, meta, svg, video, audio, [data-aa], ins, .adsbygoogle').forEach((e) => e.remove());
  const abs = (u: string) => { try { return new URL(u, site || undefined).href; } catch { return u; } };
  doc.body.querySelectorAll('*').forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const keep: Record<string, string> = {};
    if (tag === 'a') { const href = el.getAttribute('href'); if (href && /^(https?:|\/|#)/i.test(href)) keep.href = href.startsWith('#') ? href : abs(href); }
    if (tag === 'img') {
      const src = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original') || el.getAttribute('src') || (el.getAttribute('srcset') ?? '').split(/\s+/)[0] || '';
      if (src && !src.startsWith('data:')) keep.src = abs(src); else if (src.startsWith('data:')) keep.src = src;
      const alt = el.getAttribute('alt'); if (alt) keep.alt = alt;
      keep.loading = 'lazy';
    }
    if (el.hasAttribute('dir')) keep.dir = el.getAttribute('dir')!;
    if (el.hasAttribute('lang')) keep.lang = el.getAttribute('lang')!;
    const align = /text-align:\s*(center|right|left)/i.exec(el.getAttribute('style') ?? '')?.[1] ?? (el.getAttribute('align') ?? '');
    for (const a of [...el.attributes]) el.removeAttribute(a.name);
    for (const [k, v] of Object.entries(keep)) el.setAttribute(k, v);
    if (align) el.setAttribute('class', `kr-${align.toLowerCase()}`);
    if (tag === 'a' && keep.href && !keep.href.startsWith('#')) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
  });
  // (Paragraphs of the reader's own kind, so the reader's typography and search apply.)
  doc.body.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, blockquote, li, pre').forEach((el) => { el.classList.add('kr-para'); if (/^h[1-6]$/.test(el.tagName.toLowerCase())) el.classList.add('kr-heading'); });
  doc.body.querySelectorAll('img').forEach((img) => { img.classList.add('kr-img'); });
  return doc.body.innerHTML.trim();
}

/* ---------- the library ---------- */
export const MIME = 'application/x-kurokawa-webnovel+json';
export async function findInLibrary(src: string, path: string): Promise<Book | undefined> {
  return (await db.allBooks()).find((b) => b.format === 'webnovel' && b.remote?.source === src && b.remote?.id === path);
}
export async function addNovelToLibrary(novel: WebNovel, coverBlob?: Blob): Promise<Book> {
  const existing = await findInLibrary(novel.src, novel.path);
  if (existing) return existing;
  const file = new File([JSON.stringify(novel)], `${novel.title}.webnovel.json`, { type: MIME });
  const book: Book = {
    id: uid(), title: novel.title, author: novel.author, language: novel.lang, format: 'webnovel', fileName: file.name, mime: file.type, size: file.size,
    addedAt: Date.now(), pageCount: novel.chapters.length, chapters: novel.chapters.length, bookmarks: [], highlights: [], cover: coverBlob, description: novel.summary,
    remote: { source: novel.src, id: novel.path, online: true, chapterCount: novel.chapters.length, checkedAt: Date.now() },
  };
  await db.putFile(book.id, file); await db.putBook(book);
  return book;
}
export async function readNovelFile(bookId: string): Promise<WebNovel | null> {
  const f = await db.getFile(bookId); if (!f) return null;
  try { return JSON.parse(await f.text()) as WebNovel; } catch { return null; }
}
/** Write the novel's file back: the content and chapters given merged over what the file holds now. */
export async function saveNovelFile(book: Book, patch: (cur: WebNovel) => WebNovel): Promise<WebNovel> {
  const cur = (await readNovelFile(book.id)); if (!cur) throw new SourceError('parse', 'parse');
  const next = patch(cur);
  const file = new File([JSON.stringify(next)], book.fileName || `${next.title}.webnovel.json`, { type: MIME });
  await db.putFile(book.id, file);
  const have = Object.keys(next.content ?? {}).length;
  await db.updateBook(book.id, (b) => { b.size = file.size; b.pageCount = next.chapters.length; b.chapters = next.chapters.length; if (b.remote) { b.remote.online = have < next.chapters.length; b.remote.chapterCount = next.chapters.length; } });
  return next;
}
/** Fetch every chapter not yet in the file, a few at a time; `live` says whether to go on. */
export async function downloadNovel(book: Book, onProgress: (done: number, total: number) => void, live?: () => boolean): Promise<boolean> {
  const info = await readNovelFile(book.id); if (!info) throw new SourceError('parse', 'parse');
  const h = await extHandle(info.src);
  const content = { ...(info.content ?? {}) };
  const wanted = info.chapters.filter((c) => !content[c.path]);
  let done = info.chapters.length - wanted.length; onProgress(done, info.chapters.length);
  let failed = 0; let since = 0;
  await pool(wanted, 2, async (c) => {
    try { content[c.path] = { html: await fetchChapter(h, info, c), at: Date.now() }; }
    catch (e) { failed++; if ((e as SourceError).kind === 'cloudflare' || (e as SourceError).kind === 'blocked' || (e as SourceError).kind === 'offline') throw e; }
    onProgress(++done, info.chapters.length);
    if (++since >= 10) { since = 0; await saveNovelFile(book, (cur) => ({ ...cur, content: { ...(cur.content ?? {}), ...content } })); }
  }, live);
  const complete = wanted.every((c) => content[c.path]) && (!live || live());
  await saveNovelFile(book, (cur) => ({ ...cur, content: { ...(cur.content ?? {}), ...content }, fetchedAt: complete ? Date.now() : cur.fetchedAt }));
  if (failed && !complete) throw new SourceError('incomplete', 'http');
  return complete;
}

/** The novel as an EPUB file of its own: every chapter (the ones not fetched yet fetched first), the
 *  pictures in them carried inside, the card at the head, the cover. */
export async function novelToEpub(book: Book, onProgress: (step: 'chapters' | 'pictures' | 'build', done: number, total: number) => void, live?: () => boolean): Promise<Blob> {
  let info = await readNovelFile(book.id); if (!info) throw new SourceError('parse', 'parse');
  if (info.chapters.some((c) => !info!.content?.[c.path])) {
    const complete = await downloadNovel(book, (d, tot) => onProgress('chapters', d, tot), live);
    if (!complete) throw new SourceError('stopped', 'http');
    info = await readNovelFile(book.id); if (!info) throw new SourceError('parse', 'parse');
  }
  const nv = info;
  const rtl = /^(ar|fa|ur|he)/i.test(nv.lang ?? '') || /[؀-ۿ]/.test(nv.title);
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  // The pictures the chapters show, fetched with the site's headers (a few at a time); one that fails stays a link.
  const urls = new Set<string>();
  for (const c of nv.chapters) for (const m of (nv.content?.[c.path]?.html ?? '').matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) { const u = m[1].replace(/&amp;/g, '&'); if (/^https?:/i.test(u)) urls.add(u); }
  const images = new Map<string, Blob>(); let got = 0;
  const kind = (b: Uint8Array) => (b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b[0] === 0x47 && b[1] === 0x49 ? 'image/gif' : b[0] === 0x52 && b[8] === 0x57 ? 'image/webp' : 'image/jpeg');
  const list = [...urls].slice(0, 500);
  await pool(list, 3, async (u) => {
    try { const bytes = await fetchBytes(u, undefined, { headers: nv.imageHeaders ?? { referer: nv.url ?? '' }, retries: 1 }); images.set(u, new Blob([bytes.slice().buffer as ArrayBuffer], { type: kind(bytes) })); } catch { /* left as a link */ }
    onProgress('pictures', ++got, list.length);
  }, live);
  const card = `<h1>${esc(nv.title)}</h1>${nv.author ? `<p><b>${esc(nv.author)}</b></p>` : ''}${(nv.summary ?? '').split(/\n+/).filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('')}${nv.genres.length ? `<p><i>${esc(nv.genres.join(' · '))}</i></p>` : ''}${nv.url ? `<p><small>${esc(nv.url)}</small></p>` : ''}`;
  const chapters = [{ title: nv.title, html: card, rtl }, ...nv.chapters.map((c, i) => ({ title: c.name || String(i + 1), html: `<h2>${esc(c.name || String(i + 1))}</h2>${nv.content?.[c.path]?.html ?? ''}`, rtl }))];
  const { buildEpub } = await import('../../convert');
  onProgress('build', 0, 1);
  const blob = await buildEpub({ title: nv.title, author: nv.author, lang: nv.lang, rtl, chapters, images, fonts: new Map(), cover: book.cover }, () => undefined);
  onProgress('build', 1, 1);
  return blob;
}

/** Ask the site for the novel's chapters again; new ones go into the file (and are counted on the book). */
export async function checkNovel(book: Book, quiet = true): Promise<number> {
  const info = await readNovelFile(book.id); if (!info) return 0;
  const h = await extHandle(info.src);
  const fresh = quiet ? await withQuiet(() => fetchNovel(h, info.path, true)) : await fetchNovel(h, info.path, true);
  const known = new Set(info.chapters.map((c) => c.path));
  const added = fresh.chapters.filter((c) => !known.has(c.path));
  if (added.length) {
    await saveNovelFile(book, (cur) => ({ ...cur, chapters: [...cur.chapters, ...added.filter((c) => !cur.chapters.some((k) => k.path === c.path))], status: fresh.status ?? cur.status, summary: cur.summary ?? fresh.summary }));
    await db.updateBook(book.id, (b) => { if (b.remote) { b.remote.newChapters = (b.remote.newChapters ?? 0) + added.length; b.remote.checkedAt = Date.now(); b.remote.online = true; } });
  } else await db.updateBook(book.id, (b) => { if (b.remote) b.remote.checkedAt = Date.now(); });
  return added.length;
}
