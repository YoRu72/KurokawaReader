// المكتبة الشاملة (shamela.ws) as a source: the library's categories and authors browsed as shelves, a book's
// card and contents read from its page, and its text read page by page from the site — or fetched whole, to
// be read offline. The site offers no files: a book in the library is a small JSON "file" holding the card,
// the contents and, once fetched, the pages; the reader's shamela format lays it out. Searching the texts
// goes through وصلة الشاملة (shamela.link, see shamelalink.ts) when signed in; the catalogue itself — every
// category's list, kept on the device — answers for titles and authors otherwise.
import { db, uid, type Book } from '../db';
import { fetchDoc, fetchText, pool } from './http';
import { isWebOnly } from '../net';
import * as link from './shamelalink';
import { SourceError, type Source, type SourceFilter, type FilterValues, type SourcePage, type SourceBook, type SourceDetails, type SourceTag, type SourceChapter } from './types';

// (The site's address; a test server stands in for it through localStorage.)
export const SHAMELA = (typeof localStorage !== 'undefined' && localStorage.getItem('kr.shamela.base')) || 'https://shamela.ws';
const num = (s: string | null | undefined) => { const m = /\/(\d+)(?:[#?]|$)/.exec(s ?? ''); return m ? Number(m[1]) : 0; };
const arDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/* ---------- the catalogue ---------- */
export interface Category { id: number; name: string; count: number }
export interface CatalogueBook { id: number; title: string; author: string; authorId: number; cat: number; pages?: number; volumes?: number; info: string }
const CAT_TTL = 7 * 86400000;

export async function categories(force = false): Promise<Category[]> {
  const cached = await db.getMeta<{ at: number; list: Category[] }>('shamela:cats');
  if (cached && !force && Date.now() - cached.at < CAT_TTL) return cached.list;
  const doc = await fetchDoc(`${SHAMELA}/`);
  const list: Category[] = [];
  for (const a of doc.querySelectorAll<HTMLAnchorElement>('a.cat_title')) {
    const id = num(a.getAttribute('href')); if (!id) continue;
    const count = Number(arDigits(clean(a.querySelector('.badge')?.textContent))) || 0;
    const name = clean(a.textContent).replace(clean(a.querySelector('.badge')?.textContent), '').replace(/^\d+\.\s*/, '').trim();
    list.push({ id, name, count });
  }
  if (!list.length) throw new SourceError('parse', 'parse');
  await db.setMeta('shamela:cats', { at: Date.now(), list });
  return list;
}
function parseBookItems(doc: Document, cat: number): CatalogueBook[] {
  const out: CatalogueBook[] = [];
  for (const it of doc.querySelectorAll('.book_item')) {
    const t = it.querySelector<HTMLAnchorElement>('a.book_title'); const id = num(t?.getAttribute('href')); if (!t || !id) continue;
    const au = it.querySelector<HTMLAnchorElement>('a.text-gray');
    const des = (it.querySelector('p.des')?.innerHTML ?? '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '');
    const pages = /عدد الصفحات:\s*([٠-٩\d]+)/.exec(des), vols = /عدد الأجزاء:\s*([٠-٩\d]+)/.exec(des);
    out.push({ id, title: clean(t.textContent), author: clean(au?.textContent), authorId: num(au?.getAttribute('href')), cat, pages: pages ? Number(arDigits(pages[1])) : undefined, volumes: vols ? Number(arDigits(vols[1])) : undefined, info: des.trim() });
  }
  return out;
}
/** The books of one category (the site lists them all on one page), kept on the device. */
export async function categoryBooks(cat: number, force = false): Promise<CatalogueBook[]> {
  const key = `shamela:cat:${cat}`;
  const cached = await db.getMeta<{ at: number; list: CatalogueBook[] }>(key);
  if (cached && !force && Date.now() - cached.at < CAT_TTL) return cached.list;
  const doc = await fetchDoc(`${SHAMELA}/category/${cat}`);
  const list = parseBookItems(doc, cat);
  await db.setMeta(key, { at: Date.now(), list });
  return list;
}
export interface Author { id: number; name: string; bio: string; books: CatalogueBook[] }
export async function author(id: number): Promise<Author> {
  const doc = await fetchDoc(`${SHAMELA}/author/${id}`);
  return { id, name: clean(doc.querySelector('h1')?.textContent), bio: clean([...doc.querySelectorAll('.heading-title + .alert')].map((e) => e.textContent).join('\n')), books: parseBookItems(doc, 0) };
}
/** Every category's list, fetched once (a few dozen requests) so titles and authors can be searched without
 *  the site — and offline. */
export async function buildCatalogue(onProgress: (done: number, total: number) => void, live?: () => boolean): Promise<number> {
  const cats = await categories();
  let done = 0, books = 0;
  await pool(cats, 3, async (c) => { const l = await categoryBooks(c.id); books += l.length; onProgress(++done, cats.length); }, live);
  await db.setMeta('shamela:catalogue', { at: Date.now(), books });
  return books;
}
export async function catalogueState(): Promise<{ at: number; books: number } | null> { return (await db.getMeta<{ at: number; books: number }>('shamela:catalogue')) ?? null; }
const fold = (s: string) => s.normalize('NFKC').replace(/[ً-ْٰـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase();
// The catalogue as kept for searching: every category's list read once from the device, each title and
// author folded once (no diacritics, one shape of alef, ya and ta marbuta), so a search is a scan of strings.
let catalogueIndex: { at: number; rows: { hay: string; book: CatalogueBook }[] } | null = null;
async function catalogueRows(): Promise<{ hay: string; book: CatalogueBook }[]> {
  const st = await catalogueState();
  if (catalogueIndex && catalogueIndex.at === (st?.at ?? 0)) return catalogueIndex.rows;
  const rows: { hay: string; book: CatalogueBook }[] = [];
  for (const c of await categories().catch(() => [] as Category[])) {
    const cached = await db.getMeta<{ at: number; list: CatalogueBook[] }>(`shamela:cat:${c.id}`);
    for (const b of cached?.list ?? []) rows.push({ hay: fold(`${b.title} ${b.author}`), book: b });
  }
  catalogueIndex = { at: st?.at ?? 0, rows };
  return rows;
}
/** Titles and authors matching every word of `q`, from the categories fetched so far — the ones whose
 *  title starts with the words first. */
export async function searchCatalogue(q: string, cat?: number): Promise<CatalogueBook[]> {
  const words = fold(q).split(/\s+/).filter(Boolean); if (!words.length) return [];
  const rows = await catalogueRows();
  const out: { book: CatalogueBook; rank: number }[] = [];
  for (const r of rows) {
    if (cat && r.book.cat !== cat) continue;
    if (!words.every((w) => r.hay.includes(w))) continue;
    const title = fold(r.book.title);
    out.push({ book: r.book, rank: title.startsWith(words[0]) ? 0 : title.includes(words[0]) ? 1 : 2 });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out.slice(0, 300).map((x) => x.book);
}
/** The catalogue's entry for a book, when its category was fetched. */
export async function catalogueEntry(id: number): Promise<CatalogueBook | undefined> {
  return (await catalogueRows()).find((r) => r.book.id === id)?.book;
}

/* ---------- a book ---------- */
export interface ShamelaToc { title: string; page: number; level: number; more?: string }
export interface ShamelaBook { v: 1; id: number; title: string; author: string; authorId: number; cat?: number; meta: { label: string; value: string }[]; pages: number; volumes: { name: string; from: number; to: number }[]; toc: ShamelaToc[]; content: Record<number, ShamelaPageData> | null; fetchedAt?: number }
export interface ShamelaPageData { p: string; part?: string; html: string }

function parseToc(ul: Element, level: number, out: ShamelaToc[], bookId: number): void {
  for (const li of Array.from(ul.children)) {
    if (li.tagName !== 'LI') continue;
    const links = Array.from(li.children).filter((c) => c.tagName === 'A') as HTMLAnchorElement[];
    const a = links.find((x) => /\/book\/\d+\/\d+/.test(x.getAttribute('href') ?? ''));
    const more = links.find((x) => x.classList.contains('exp_bu'))?.getAttribute('data-id') ?? undefined;
    if (a) out.push({ title: clean(a.textContent), page: num(a.getAttribute('href')), level, more: more && !li.querySelector(':scope > ul') ? `${bookId}/${more}` : undefined });
    const sub = Array.from(li.children).find((c) => c.tagName === 'UL');
    if (sub) parseToc(sub, level + 1, out, bookId);
  }
}
/** The branches of the contents the page folded ([+]): fetched — a level of branches at a time, several at
 *  once — and spliced in where they belong. A branch that fails stays folded. `budgetMs` stops the work
 *  after that long (what is left keeps its `more` mark, so it can be finished later). */
export async function expandToc(toc: ShamelaToc[], live?: () => boolean, budgetMs = 0): Promise<ShamelaToc[]> {
  const started = Date.now();
  const going = () => (!live || live()) && (!budgetMs || Date.now() - started < budgetMs);
  type Node = ShamelaToc & { kids?: Node[] };
  const nodes: Node[] = toc.map((e) => ({ ...e }));
  let frontier = nodes.filter((n) => n.more);
  while (frontier.length && going()) {
    const next: Node[] = [];
    await pool(frontier, 5, async (n) => {
      if (!going()) return;
      try {
        const html = await fetchText(`${SHAMELA}/ajax/titlechilds/${n.more}`);
        const doc = new DOMParser().parseFromString(`<ul>${html}</ul>`, 'text/html');
        const kids: ShamelaToc[] = []; parseToc(doc.querySelector('ul')!, n.level + 1, kids, Number(n.more!.split('/')[0]));
        n.kids = kids.map((k) => ({ ...k })); n.more = undefined;
        next.push(...n.kids.filter((k) => k.more));
      } catch { /* that branch stays folded */ }
    });
    frontier = next;
  }
  const out: ShamelaToc[] = [];
  const flat = (list: Node[]) => { for (const n of list) { const { kids, ...e } = n; out.push(e); if (kids) flat(kids); } };
  flat(nodes);
  return out;
}
/** The whole contents of a book, every branch open, remembered for the session. */
const fullTocs = new Map<number, Promise<ShamelaToc[]>>();
export function fullToc(info: ShamelaBook, live?: () => boolean): Promise<ShamelaToc[]> {
  if (!info.toc.some((e) => e.more)) return Promise.resolve(info.toc);
  let p = fullTocs.get(info.id);
  if (!p) { p = expandToc(info.toc, live); fullTocs.set(info.id, p); p.then((t) => { if (t.some((e) => e.more)) fullTocs.delete(info.id); }, () => fullTocs.delete(info.id)); }
  return p;
}
/** A book's card and contents from its page, and its extent from its first page — remembered a while, since
 *  a book's page, its actions and its contents all ask for it. */
const infos = new Map<number, { at: number; p: Promise<ShamelaBook> }>();
export function bookInfo(id: number): Promise<ShamelaBook> {
  const had = infos.get(id);
  if (had && Date.now() - had.at < 600000) return had.p;
  const p = readBookInfo(id);
  infos.set(id, { at: Date.now(), p });
  p.catch(() => infos.delete(id));
  if (infos.size > 8) infos.delete(infos.keys().next().value!);
  return p;
}
async function readBookInfo(id: number): Promise<ShamelaBook> {
  const [doc, first] = await Promise.all([fetchDoc(`${SHAMELA}/book/${id}`), fetchDoc(`${SHAMELA}/book/${id}/1`)]);
  // The heading names the book ("كتاب الفقه الأكبر"); the card has the full title ("الكتاب: الفقه الأكبر (مطبوع مع…)").
  const heading = (clean(doc.querySelector('h1 a')?.textContent) || clean(doc.querySelector('h1')?.textContent)).replace(/^كتاب\s+/, '');
  const au = doc.querySelector<HTMLAnchorElement>('h1 + div a');
  const nass = doc.querySelector('.nass');
  if (!nass) throw new SourceError('parse', 'parse');
  const card = nass.cloneNode(true) as HTMLElement;
  card.querySelectorAll('.text-left, .betaka-index, h3, div').forEach((e) => e.remove());
  const meta: { label: string; value: string }[] = [];
  for (const line of card.innerHTML.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').split('\n')) {
    const m = /^\s*([^:：]{2,24})[:：]\s*(.+)$/.exec(line); if (m) meta.push({ label: clean(m[1]), value: clean(m[2]) });
    else if (/ترقيم الكتاب/.test(line)) meta.push({ label: 'الترقيم', value: clean(line).replace(/^\[|\]$/g, '') });
  }
  const toc: ShamelaToc[] = [];
  const index = doc.querySelector('.betaka-index > ul, .betaka-index ul');
  if (index) parseToc(index, 0, toc, id);
  const last = num(first.querySelector('input#fld_goto_bottom + a + a')?.getAttribute('href')) || num(first.querySelector('input#fld_goto_top + a + a')?.getAttribute('href'));
  const pages = Math.max(last, 1, ...toc.map((e) => e.page));
  const volumes: ShamelaBook['volumes'] = [];
  const parts = Array.from(first.querySelectorAll<HTMLAnchorElement>('#fld_part_top ~ div ul[role="menu"] li a')).slice(1).map((a) => ({ name: clean(a.textContent), page: num(a.getAttribute('href')) })).filter((p) => p.name && p.page);
  parts.sort((a, b) => a.page - b.page).forEach((p, i) => volumes.push({ name: p.name, from: p.page, to: parts[i + 1] ? parts[i + 1].page - 1 : pages }));
  const cat = num(doc.querySelector<HTMLAnchorElement>('.breadcrumb a[href*="/category/"], a[href*="/category/"]')?.getAttribute('href')) || undefined;
  // The title: the heading's, when the card's full title begins with it (its short form); else the card's
  // without its parenthetical note; else the unlabelled line above "المؤلف:"; else the catalogue's entry.
  const short = (x: string) => clean(x).replace(/\s*[(\[].*$/, '').trim();
  const cardTitle = meta.find((m) => m.label === 'الكتاب')?.value ?? '';
  let named = heading && !/^\d+$/.test(heading) && (!cardTitle || fold(short(cardTitle)).startsWith(fold(heading)) || fold(cardTitle).includes(fold(heading))) ? heading : short(cardTitle);
  if (!named) {
    const lines = card.innerHTML.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').split('\n').map((l) => clean(l));
    const i = lines.findIndex((l) => /^المؤلف\s*[:：]/.test(l));
    if (i > 0 && lines[i - 1] && !/[:：]/.test(lines[i - 1])) named = lines[i - 1];
  }
  if (!named) named = (await catalogueEntry(id).catch(() => undefined))?.title ?? heading ?? '';
  if (!named) named = `كتاب رقم ${id}`;
  const authorLink = doc.querySelector<HTMLAnchorElement>('a[href*="/author/"]');
  const authorName = clean(au?.textContent) || clean(authorLink?.textContent) || (meta.find((m) => m.label === 'المؤلف')?.value.replace(/\s*\(ت.*$/, '') ?? '');
  return { v: 1, id, title: named, author: authorName, authorId: num(au?.getAttribute('href')) || num(authorLink?.getAttribute('href')), cat, meta, pages, volumes, toc, content: null };
}
/** One page's text as the reader shows it: the printed page and part, the text with the site's buttons and
 *  anchors gone and its paragraphs and footnotes marked. */
export function cleanPage(nass: Element): string {
  const el = nass.cloneNode(true) as HTMLElement;
  el.querySelectorAll('a.btn_tag, span.anchor, script, style, .text-left').forEach((x) => x.remove());
  el.querySelectorAll('a').forEach((a) => { const href = a.getAttribute('href') ?? ''; if (!/^https?:\/\/shamela\.ws\/book\//.test(href) && !href.startsWith('#')) return; a.replaceWith(...Array.from(a.childNodes)); });
  for (const p of Array.from(el.querySelectorAll('p'))) {
    const d = document.createElement('div'); d.className = p.classList.contains('hamesh') ? 'kr-para kr-hamesh' : 'kr-para';
    if (p.classList.contains('text-center')) d.classList.add('kr-center');
    d.innerHTML = p.innerHTML; p.replaceWith(d);
  }
  for (const s of Array.from(el.querySelectorAll('span[style], font'))) {
    const color = (s.getAttribute('style') ?? '').match(/color:\s*#?([0-9a-f]{3,6})/i)?.[1]?.toLowerCase() ?? (s.getAttribute('color') ?? '').replace('#', '').toLowerCase();
    const cls = color === 'ff0000' || color === 'f00' ? 'kr-red' : color === '008000' || color === '00a000' || color === '080' ? 'kr-green' : color === '0000ff' || color === '00f' ? 'kr-blue' : '';
    const span = document.createElement('span'); if (cls) span.className = cls; span.innerHTML = s.innerHTML; s.replaceWith(span);
  }
  // (Nothing of the site's markup but the text, its paragraphs and the few marks the reader styles: no
  // attributes at all besides those — a page's HTML goes into the reader as it is.)
  el.querySelectorAll('*').forEach((x) => {
    const keep = [...x.classList].filter((c) => c.startsWith('kr-') || c === 'hamesh');
    if (keep.includes('hamesh')) keep.push('kr-para', 'kr-hamesh');
    const href = x.tagName === 'A' && /^https?:\/\//i.test(x.getAttribute('href') ?? '') ? x.getAttribute('href') : null;
    for (const a of [...x.attributes]) x.removeAttribute(a.name);
    if (keep.length) x.className = [...new Set(keep.filter((c) => c !== 'hamesh'))].join(' ');
    if (href) { x.setAttribute('href', href); x.setAttribute('target', '_blank'); x.setAttribute('rel', 'noopener'); }
  });
  el.querySelectorAll('script, style, iframe, object, embed, img, video, audio, form, input, button').forEach((x) => x.remove());
  return el.innerHTML.trim();
}
export async function page(id: number, n: number): Promise<ShamelaPageData> {
  const doc = await fetchDoc(`${SHAMELA}/book/${id}/${n}`);
  const nass = doc.querySelector('.nass[data-page-id]') ?? doc.querySelector('.nass');
  if (!nass) throw new SourceError('parse', 'parse');
  const part = clean(doc.querySelector('#fld_part_top ~ div button, #fld_part_bottom ~ div button')?.textContent) || undefined;
  return { p: arDigits(nass.getAttribute('data-page-num') ?? (doc.querySelector<HTMLInputElement>('#fld_goto_bottom')?.value ?? String(n))), part: part && !/^\s*$/.test(part) ? part : undefined, html: cleanPage(nass) };
}

/* ---------- the library ---------- */
/** The book as the library keeps it: its card, its contents with every branch open (a few seconds' worth
 *  now, the rest fetched in the background and written into the file), its pages as they are read. */
export async function addToLibrary(info: ShamelaBook): Promise<Book> {
  const existing = (await db.allBooks()).find((b) => b.format === 'shamela' && b.remote?.id === String(info.id));
  if (existing) return existing;
  let toc = info.toc;
  if (toc.some((e) => e.more)) { try { toc = await expandToc(info.toc, undefined, 5000); } catch { /* the folded contents stay */ } }
  const first: ShamelaBook = { ...info, toc };
  const file = new File([JSON.stringify(first)], `${info.title}.shamela.json`, { type: 'application/x-kurokawa-shamela+json' });
  const book: Book = {
    id: uid(), title: info.title, author: info.author || undefined, language: 'ar', format: 'shamela', fileName: file.name, mime: file.type, size: file.size,
    addedAt: Date.now(), pageCount: info.pages, bookmarks: [], highlights: [], remote: { source: 'shamela', id: String(info.id), online: true },
  };
  await db.putFile(book.id, file); await db.putBook(book);
  if (toc.some((e) => e.more)) void fullToc({ ...info, toc }).then((full) => mergeFile(book.id, (cur) => ({ ...cur, toc: full }))).catch(() => undefined);
  return book;
}
/** Write the book's file back with a change, over what the file holds now (pages read meanwhile stay). */
export async function mergeFile(bookId: string, patch: (cur: ShamelaBook) => ShamelaBook): Promise<ShamelaBook | null> {
  const cur = await readBookFile(bookId); if (!cur) return null;
  const next = patch(cur);
  const book = await db.getBook(bookId);
  const file = new File([JSON.stringify(next)], book?.fileName ?? `${next.title}.shamela.json`, { type: 'application/x-kurokawa-shamela+json' });
  await db.putFile(bookId, file);
  const have = Object.keys(next.content ?? {}).length;
  await db.updateBook(bookId, (b) => { b.size = file.size; if (b.remote) b.remote.online = have < next.pages; });
  return next;
}
export async function readBookFile(bookId: string): Promise<ShamelaBook | null> {
  const f = await db.getFile(bookId); if (!f) return null;
  try { return JSON.parse(await f.text()) as ShamelaBook; } catch { return null; }
}
/** Fetch every page of the book into its file, so it reads offline; `live` says whether to go on. */
export async function downloadBook(book: Book, onProgress: (done: number, total: number) => void, live?: () => boolean): Promise<boolean> {
  const info = await readBookFile(book.id); if (!info) throw new SourceError('parse', 'parse');
  const content: Record<number, ShamelaPageData> = { ...(info.content ?? {}) };
  const wanted = Array.from({ length: info.pages }, (_, i) => i + 1).filter((n) => !content[n]);
  let done = info.pages - wanted.length; onProgress(done, info.pages);
  let failed = 0;
  await pool(wanted, 4, async (n) => {
    try { content[n] = await page(info.id, n); } catch (e) { failed++; if ((e as SourceError).kind === 'cloudflare' || (e as SourceError).kind === 'offline') throw e; }
    onProgress(++done, info.pages);
    // (The pages so far are saved now and then: a download cut short keeps what it got.)
    if (done % 40 === 0) await saveContent(book, info, content, false);
  }, live);
  const complete = wanted.every((n) => content[n]) && (!live || live());
  await saveContent(book, info, content, complete);
  if (failed && !complete) throw new SourceError('incomplete', 'http');
  return complete;
}
async function saveContent(book: Book, info: ShamelaBook, content: Record<number, ShamelaPageData>, complete: boolean): Promise<void> {
  const merged = await mergeFile(book.id, (cur) => ({ ...cur, content: { ...(cur.content ?? {}), ...content }, fetchedAt: Date.now() }));
  if (!merged) {
    const next: ShamelaBook = { ...info, content, fetchedAt: Date.now() };
    const file = new File([JSON.stringify(next)], book.fileName ?? `${info.title}.shamela.json`, { type: 'application/x-kurokawa-shamela+json' });
    await db.putFile(book.id, file);
    await db.updateBook(book.id, (b) => { b.size = file.size; if (b.remote) b.remote.online = !complete; });
  }
}

/* ---------- the site's own search (no account) ---------- */
export interface SiteHit { bookId: number; page: number; title: string; author: string; snippet: string; url: string }
export interface SiteSearch { hits: SiteHit[]; total?: number; next?: number }
/** The term as the site's search reads it: every word required (`+word`), or a phrase in quotes. */
export function siteTerm(q: string, match: string): string {
  const t = q.trim().replace(/[+"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (match === 'phrase') return `"${t}"`;
  if (match === 'any') return t;
  return t.split(' ').map((w) => `+${w}`).join(' ');
}
/** Search the texts of the whole library on the site itself (POST /ajax/search, as the site's own page does):
 *  the hits with their snippets, the count, the next page. `books` narrows to books, `cats` to categories,
 *  `centuries` to centuries (hijri). */
export async function siteSearch(term: string, o: { page?: number; cats?: number[]; centuries?: number[]; books?: number[]; authors?: number[] } = {}): Promise<SiteSearch> {
  const form = new URLSearchParams();
  form.set('term', term); form.set('page', String(o.page ?? 1));
  for (const c of o.cats?.length ? o.cats : [-1]) form.append('aqsam[]', String(c));
  for (const c of o.centuries?.length ? o.centuries : [-1]) form.append('decades[]', String(c));
  for (const a of o.authors?.length ? o.authors : [-1]) form.append('authors[]', String(a));
  for (const b of o.books?.length ? o.books : [-1]) form.append('books[]', String(b));
  const html = await fetchText(`${SHAMELA}/ajax/search`, { method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', accept: 'text/html, */*; q=0.01' } });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const hits: SiteHit[] = [];
  const seen = new Set<string>();
  for (const snip of Array.from(doc.querySelectorAll('.srch-snippet, p.snippet, .snippet'))) {
    const a = (snip.closest('a[href*="/book/"]') ?? snip.parentElement?.querySelector('a[href*="/book/"]') ?? snip.closest('div')?.querySelector('a[href*="/book/"]')) as HTMLAnchorElement | null;
    const href = a?.getAttribute('href') ?? ''; const m = /\/book\/(\d+)\/(\d+)/.exec(href); if (!m) continue;
    const key = `${m[1]}/${m[2]}`; if (seen.has(key)) continue; seen.add(key);
    const holder = (a?.closest('div') ?? a) as Element;
    const title = clean(holder.querySelector('b, strong, .book_title')?.textContent) || clean(a?.textContent).split('[')[0].trim();
    const author = clean(holder.querySelector('span')?.textContent).replace(/^\[|\]$/g, '').trim();
    const sn = snip.cloneNode(true) as HTMLElement;
    sn.querySelectorAll('b, strong, mark, font, span[style*="color"], em').forEach((e) => { const mk = document.createElement('mark'); mk.textContent = e.textContent; e.replaceWith(mk); });
    const snippet = sn.innerHTML.replace(/<(?!\/?mark>)[^>]*>/g, '').trim();
    hits.push({ bookId: Number(m[1]), page: Number(m[2]), title, author, snippet, url: /^https?:/.test(href) ? href : `${SHAMELA}${href}` });
  }
  const text = clean(doc.body?.textContent);
  const totalM = /النتائج\s*[\d٠-٩,]+\s*إلى\s*[\d٠-٩,]+\s*من\s*([\d٠-٩,]+)/.exec(text);
  const total = totalM ? Number(arDigits(totalM[1]).replace(/,/g, '')) : undefined;
  const nextEl = doc.querySelector('#bu_srch_more, [data-page]');
  const next = nextEl ? Number(nextEl.getAttribute('data-page')) || undefined : undefined;
  if (!hits.length && !/النتائج|لا توجد|لم يتم العثور|srch/.test(html) && html.length > 20000) throw new SourceError('parse', 'parse');
  return { hits, total, next: next && next > (o.page ?? 1) ? next : undefined };
}
/** Which engine searches the texts: the site itself (no account), or وصلة الشاملة when signed in. */
export function textEngine(f: FilterValues): 'site' | 'link' {
  return String(f.engine ?? 'site') === 'link' && link.isConnected() ? 'link' : 'site';
}

/* ---------- the source ---------- */
const CENTURIES = ['', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩', '١٠', '١١', '١٢', '١٣', '١٤', '١٥'];
export const shamelaSource: Source = {
  id: 'shamela',
  name: 'المكتبة الشاملة',
  lang: 'ar',
  site: SHAMELA,
  needsApp: true,
  description: 'آلاف الكتب العربية في العقيدة والتفسير والحديث والفقه واللغة والتاريخ، تُقرأ من الموقع صفحةً صفحة، وتُجلب كاملةً لتُقرأ دون اتصال. البحث في نصوص الكتب كلها من الموقع نفسه دون حساب، أو عبر «وصلة الشاملة» لمن سجّل الدخول.',
  filters: (): SourceFilter[] => [
    { id: 'mode', label: 'البحث في', kind: 'select', value: 'titles', options: [['titles', 'أسماء الكتب والمؤلفين'], ['texts', 'نصوص الكتب'], ['chapters', 'عناوين الأبواب (وصلة الشاملة)']].map(([value, label]) => ({ value, label })) },
    { id: 'engine', label: 'محرك البحث في النصوص', kind: 'select', value: 'site', options: [['site', 'موقع الشاملة (دون حساب)'], ['link', 'وصلة الشاملة (بعد تسجيل الدخول)']].map(([value, label]) => ({ value, label })) },
    { id: 'match', label: 'المطابقة', kind: 'select', value: 'words', options: [['words', 'كل الكلمات'], ['any', 'أيٌّ من الكلمات'], ['phrase', 'عبارة بنصها'], ['root', 'الجذر وتصريفاته (وصلة الشاملة)'], ['wild', 'بأحرف البدل * و ? (وصلة الشاملة)']].map(([value, label]) => ({ value, label })) },
    { id: 'from', label: 'من القرن (هـ)', kind: 'select', value: '', options: CENTURIES.map((c, i) => ({ value: i ? String(i) : '', label: i ? `القرن ${c}` : 'أي قرن' })) },
    { id: 'to', label: 'إلى القرن (هـ)', kind: 'select', value: '', options: CENTURIES.map((c, i) => ({ value: i ? String(i) : '', label: i ? `القرن ${c}` : 'أي قرن' })) },
  ],
  shelves: async () => (await categories()).map((c) => ({ id: String(c.id), label: c.name, count: c.count })),
  async browse(q, f, pageNo, shelf): Promise<SourcePage> {
    const text = q.trim();
    const catId = shelf ? Number(shelf) : undefined;
    if (!text) {
      if (catId) {
        const all = await categoryBooks(catId);
        const slice = all.slice((pageNo - 1) * 60, pageNo * 60);
        return { items: slice.map(fromCatalogue), hasMore: pageNo * 60 < all.length, title: (await categories()).find((c) => c.id === catId)?.name };
      }
      // No shelf: the whole library, category after category, each list fetched when the page reaches it
      // (the home page's counts say where each begins).
      const cats = await categories();
      const total = cats.reduce((n, c) => n + (c.count || 0), 0);
      let offset = (pageNo - 1) * 60, pos = 0; const items: SourceBook[] = [];
      for (const c of cats) {
        if (items.length >= 60) break;
        const count = c.count || 0;
        if (offset >= pos + count) { pos += count; continue; }
        const list = await categoryBooks(c.id);
        const start = Math.max(0, offset - pos);
        items.push(...list.slice(start, start + (60 - items.length)).map(fromCatalogue));
        pos += count; offset = pos;
      }
      return { items, hasMore: (pageNo - 1) * 60 + items.length < total && items.length > 0 };
    }
    const mode = String(f.mode ?? 'titles');
    const period: link.Scope = {}; if (f.from) period.period_from = (Number(f.from) - 1) * 100 + 1; if (f.to) period.period_to = Number(f.to) * 100;
    if (mode === 'titles') {
      if (link.isConnected()) {
        const r = await link.searchBooks(text, { offset: (pageNo - 1) * 30, limit: 30, scope: { ...period, ...(catId ? { category_ids: [catId] } : {}) } });
        return { items: r.results.map((b) => ({ id: String(b.book_id), title: b.book_name, author: b.author_name, lang: 'ar', badge: b.category, year: b.book_date ? `${b.book_date} هـ` : undefined, description: b.snippet })), hasMore: !!r.has_more };
      }
      const found = await searchCatalogue(text, catId);
      return { items: found.slice((pageNo - 1) * 60, pageNo * 60).map(fromCatalogue), hasMore: pageNo * 60 < found.length };
    }
    const match = String(f.match ?? 'words');
    // The texts: the site's own search first — no account — unless وصلة الشاملة was chosen and is signed in
    // (chapter titles, roots and wildcards are its alone).
    const wantsLink = mode === 'chapters' || match === 'root' || match === 'wild' || String(f.engine ?? 'site') === 'link';
    if (!wantsLink || !link.isConnected()) {
      if (mode === 'chapters' || match === 'root' || match === 'wild') throw new SourceError('auth', 'auth');
      const from = Number(f.from) || 0, to = Number(f.to) || 0;
      const centuries = from || to ? Array.from({ length: Math.max(0, (to || 15) - (from || 1) + 1) }, (_, i) => (from || 1) + i) : [];
      const r = await siteSearch(siteTerm(text, match), { page: pageNo, cats: catId ? [catId] : [], centuries });
      const items: SourceBook[] = r.hits.map((h) => ({ id: `${h.bookId}#${h.page}`, title: h.title, author: h.author || undefined, lang: 'ar', badge: `ص ${h.page}`, description: h.snippet.replace(/<\/?mark>/g, '') }));
      return { items, hasMore: !!r.next && items.length > 0, title: r.total !== undefined ? `${r.total} نتيجة` : undefined };
    }
    const r = await link.searchPages(text, { offset: (pageNo - 1) * 20, limit: 20, titles: mode === 'chapters', phrase: match === 'phrase', morphology: match === 'root', wildcards: match === 'wild', scope: { ...period, ...(catId ? { category_ids: [catId] } : {}) } });
    const items: SourceBook[] = r.results.map((h) => ({ id: `${h.book_id}#${h.page_id}`, title: h.book_name, author: h.author_name, lang: 'ar', badge: h.printed_page ? `ص ${h.printed_page}` : undefined, description: (h.snippet_body || h.snippet_foot || '').replace(/<\/?mark>/g, '') , year: h.category }));
    const tags: SourceTag[] = Object.entries(r.coverage?.by_category ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, count]) => ({ id: `cat:${label}`, label, count }));
    return { items, hasMore: r.has_more, tags, title: `${r.total_hits} نتيجة` };
  },
  async details(id): Promise<SourceDetails> {
    const [bookId, pageId] = id.split('#'); const info = await bookInfo(Number(bookId));
    const chapters: SourceChapter[] = info.toc.map((e, i) => ({ id: String(i), title: e.title, level: e.level, page: e.page }));
    return {
      id: String(info.id), title: info.title, author: info.author, lang: 'ar', description: info.meta.find((m) => m.label === 'الكتاب')?.value,
      tags: [], files: [], chapters, pages: info.pages, volumes: info.volumes, meta: info.meta, url: `${SHAMELA}/book/${info.id}${pageId ? `/${pageId}` : ''}`,
    };
  },
};
function fromCatalogue(b: CatalogueBook): SourceBook {
  return { id: String(b.id), title: b.title, author: b.author || undefined, lang: 'ar', badge: b.pages ? `${b.pages} ص${b.volumes && b.volumes > 1 ? ` · ${b.volumes} ج` : ''}` : undefined, description: b.info.split('\n').filter((l) => /الناشر|الطبعة/.test(l)).join(' · ') || undefined };
}
export function isWeb(): boolean { return isWebOnly(); }
