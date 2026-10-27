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
const fold = (s: string) => s.normalize('NFKC').replace(/[ً-ٰٟـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase();
/** Titles and authors matching every word of `q`, from the categories fetched so far. */
export async function searchCatalogue(q: string, cat?: number): Promise<CatalogueBook[]> {
  const words = fold(q).split(/\s+/).filter(Boolean); if (!words.length) return [];
  const cats = cat ? [{ id: cat }] : await categories().catch(() => [] as { id: number }[]);
  const out: CatalogueBook[] = [];
  for (const c of cats) {
    const cached = await db.getMeta<{ at: number; list: CatalogueBook[] }>(`shamela:cat:${c.id}`);
    for (const b of cached?.list ?? []) { const hay = fold(`${b.title} ${b.author}`); if (words.every((w) => hay.includes(w))) out.push(b); }
  }
  return out.slice(0, 300);
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
/** The branches of the contents the page folded ([+]): fetched and spliced in where they belong. */
export async function expandToc(toc: ShamelaToc[], live?: () => boolean): Promise<ShamelaToc[]> {
  const out: ShamelaToc[] = [];
  for (const e of toc) {
    out.push({ ...e, more: undefined });
    if (!e.more || (live && !live())) continue;
    try {
      const html = await fetchText(`${SHAMELA}/ajax/titlechilds/${e.more}`);
      const doc = new DOMParser().parseFromString(`<ul>${html}</ul>`, 'text/html');
      const kids: ShamelaToc[] = []; parseToc(doc.querySelector('ul')!, e.level + 1, kids, Number(e.more.split('/')[0]));
      out.push(...await expandToc(kids, live));
    } catch { /* that branch stays folded */ }
  }
  return out;
}
/** A book's card and contents from its page, and its extent from its first page. */
export async function bookInfo(id: number): Promise<ShamelaBook> {
  const [doc, first] = await Promise.all([fetchDoc(`${SHAMELA}/book/${id}`), fetchDoc(`${SHAMELA}/book/${id}/1`)]);
  const title = clean(doc.querySelector('h1 a')?.textContent) || clean(doc.querySelector('h1')?.textContent) || `كتاب ${id}`;
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
  // (Without the page's heading, the card names the book and its author.)
  const named = /^كتاب \d+$/.test(title) ? (meta.find((m) => m.label === 'الكتاب')?.value.replace(/\s*\(.*$/, '') || title) : title;
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
/** The book as the library keeps it. */
export async function addToLibrary(info: ShamelaBook): Promise<Book> {
  const existing = (await db.allBooks()).find((b) => b.format === 'shamela' && b.remote?.id === String(info.id));
  if (existing) return existing;
  const file = new File([JSON.stringify(info)], `${info.title}.shamela.json`, { type: 'application/x-kurokawa-shamela+json' });
  const book: Book = {
    id: uid(), title: info.title, author: info.author || undefined, language: 'ar', format: 'shamela', fileName: file.name, mime: file.type, size: file.size,
    addedAt: Date.now(), pageCount: info.pages, bookmarks: [], highlights: [], remote: { source: 'shamela', id: String(info.id), online: true },
  };
  await db.putFile(book.id, file); await db.putBook(book);
  return book;
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
  await pool(wanted, 3, async (n) => {
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
  const next: ShamelaBook = { ...info, content, fetchedAt: Date.now() };
  const file = new File([JSON.stringify(next)], book.fileName ?? `${info.title}.shamela.json`, { type: 'application/x-kurokawa-shamela+json' });
  await db.putFile(book.id, file);
  await db.updateBook(book.id, (b) => { b.size = file.size; if (b.remote) b.remote.online = !complete; });
}

/* ---------- the source ---------- */
const CENTURIES = ['', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩', '١٠', '١١', '١٢', '١٣', '١٤', '١٥'];
export const shamelaSource: Source = {
  id: 'shamela',
  name: 'المكتبة الشاملة',
  lang: 'ar',
  site: SHAMELA,
  needsApp: true,
  description: 'آلاف الكتب العربية في العقيدة والتفسير والحديث والفقه واللغة والتاريخ، تُقرأ من الموقع صفحةً صفحة، وتُجلب كاملةً لتُقرأ دون اتصال. البحث في النصوص عبر «وصلة الشاملة» بعد تسجيل الدخول.',
  filters: (): SourceFilter[] => [
    { id: 'mode', label: 'البحث في', kind: 'select', value: 'titles', options: [['titles', 'أسماء الكتب والمؤلفين'], ['texts', 'نصوص الكتب (وصلة الشاملة)'], ['chapters', 'عناوين الأبواب (وصلة الشاملة)']].map(([value, label]) => ({ value, label })) },
    { id: 'match', label: 'المطابقة', kind: 'select', value: 'words', options: [['words', 'كل الكلمات'], ['phrase', 'عبارة بنصها'], ['root', 'الجذر وتصريفاته'], ['wild', 'بأحرف البدل * و ?']].map(([value, label]) => ({ value, label })) },
    { id: 'from', label: 'من القرن (هـ)', kind: 'select', value: '', options: CENTURIES.map((c, i) => ({ value: i ? String(i) : '', label: i ? `القرن ${c}` : 'أي قرن' })) },
    { id: 'to', label: 'إلى القرن (هـ)', kind: 'select', value: '', options: CENTURIES.map((c, i) => ({ value: i ? String(i) : '', label: i ? `القرن ${c}` : 'أي قرن' })) },
  ],
  shelves: async () => (await categories()).map((c) => ({ id: String(c.id), label: c.name, count: c.count })),
  async browse(q, f, pageNo, shelf): Promise<SourcePage> {
    const text = q.trim();
    const catId = shelf ? Number(shelf) : undefined;
    if (!text) {
      if (!catId) return { items: [], hasMore: false };
      const all = await categoryBooks(catId);
      const slice = all.slice((pageNo - 1) * 60, pageNo * 60);
      return { items: slice.map(fromCatalogue), hasMore: pageNo * 60 < all.length, title: (await categories()).find((c) => c.id === catId)?.name };
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
    if (!link.isConnected()) throw new SourceError('auth', 'auth');
    const match = String(f.match ?? 'words');
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
