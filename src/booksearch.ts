// Searching many books at once. Each book is read once into its units — a PDF's pages (in reading order, as the
// reader's text layer has them), a flowing book's chapters — and kept on the device, so later searches are
// quick; the units are then searched with the same normalisation as the in-book search (Arabic harakat,
// tatweel and letter variants, vertical and full-width forms, case), or exactly, as chosen.
import { db, type Book } from './db';
import { normalizeForSearch } from './formats/types';
import { flowHandlerFor } from './formats';

export type Unit = { label: string; text: string };
export type Mode = 'phrase' | 'all' | 'any';
export type Options = { mode: Mode; wholeWord: boolean; exact: boolean };
export type Hit = { unit: number; label: string; nth: number; before: string; match: string; after: string };
export type BookResult = { book: Book; hits: Hit[]; total: number; error?: 'protected' | 'unreadable' };

/** Formats whose text can be searched. */
export const SEARCHABLE: Book['format'][] = ['pdf', 'epub', 'docx', 'odt', 'fb2', 'txt', 'md', 'html', 'mobi', 'xlsx', 'csv', 'pptx'];
export const searchable = (b: Book) => SEARCHABLE.includes(b.format);

const memo = new Map<string, Unit[]>();
// (The version goes up whenever the way text is read changes, so books are read again rather than searched
// in text kept from before.)
const TEXT_VERSION = 4;
const keyOf = (b: Book) => `v${TEXT_VERSION}:${b.size ?? 0}:${b.fileName ?? ''}`;

/** A book's text units: from the device's store when read before, else read now (and stored). */
export async function unitsOf(book: Book, onPage?: (n: number, total: number) => void): Promise<Unit[] | 'protected' | 'unreadable'> {
  const key = keyOf(book);
  const m = memo.get(book.id); if (m) return m;
  const stored = await db.getText(book.id);
  if (stored && stored.key === key) { memo.set(book.id, stored.units); return stored.units; }
  const file = await db.getFile(book.id);
  if (!file) return 'unreadable';
  let units: Unit[];
  try {
    if (book.format === 'pdf') {
      const r = await pdfUnits(file, onPage);
      if (r === 'protected') return r;
      units = r;
    } else units = await flowUnits(book, file);
  } catch { return 'unreadable'; }
  memo.set(book.id, units);
  void db.putText(book.id, { key, units });
  return units;
}

async function pdfUnits(file: Blob, onPage?: (n: number, total: number) => void): Promise<Unit[] | 'protected'> {
  const { loadPdfjs } = await import('./formats/pdf');
  const { openPdfjs } = await import('./pdfkeys');
  const { pageReadingText } = await import('./pdflayer');
  const pdfjs = await loadPdfjs();
  const RES = new URL('./pdfjs/', import.meta.url).href;
  let o: Awaited<ReturnType<typeof openPdfjs>>;
  // (A protected file opens with the password remembered for it; one never opened here is left out, not asked.)
  try { o = await openPdfjs(pdfjs, new Uint8Array(await file.arrayBuffer()), { cMapUrl: `${RES}cmaps/`, cMapPacked: true, standardFontDataUrl: `${RES}standard_fonts/`, wasmUrl: `${RES}wasm/`, isEvalSupported: false }); }
  catch (e) { if (String((e as Error).message) === 'password') return 'protected'; throw e; }
  try {
    const out: Unit[] = [];
    // (A few pages asked of the worker ahead, so it reads them while the one before is laid out here.)
    const N = o.doc.numPages;
    const ask = (n: number) => o.doc.getPage(n).then(async (page) => { const text = await pageReadingText(page); page.cleanup(); return text; });
    const ahead = new Map<number, Promise<string>>();
    for (let n = 1; n <= N; n++) {
      for (let k = n; k <= Math.min(N, n + 3); k++) if (!ahead.has(k)) ahead.set(k, ask(k));
      out.push({ label: String(n), text: await ahead.get(n)! });
      ahead.delete(n);
      onPage?.(n, N);
      if (n % 10 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  } finally { o.destroy(); }
}

async function flowUnits(book: Book, file: Blob): Promise<Unit[]> {
  const handler = flowHandlerFor(book.format);
  if (!handler) throw new Error('unsupported');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:800px;visibility:hidden';
  host.className = 'kr-content'; // (the reader's own layout, so verses and tables are laid out as they are read)
  document.body.appendChild(host);
  const render = await handler.render(file, { bookId: book.id, bookTitle: book.title, publisherStyles: false, id: (s) => `bs-${s}` });
  try {
    host.appendChild(render.element);
    const sections = Array.from(render.element.querySelectorAll<HTMLElement>(':scope > .kr-chapter'));
    const parts = sections.length ? sections : [render.element];
    return parts.map((el, i) => {
      el.querySelectorAll('style, script').forEach((x) => x.remove());
      // Blocks on lines of their own, so excerpts do not run paragraphs together.
      el.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, tr, div, br, blockquote, pre').forEach((x) => x.append('\n'));
      // Pieces laid side by side (a verse's two halves, table cells) are words apart too.
      el.querySelectorAll('span, td, th, a, em, b, i').forEach((x) => { const d = getComputedStyle(x).display; if (d !== 'inline' && d !== 'contents' && d !== 'none') x.append(' '); });
      const label = render.toc.find((tI) => el.querySelector(`#${CSS.escape(tI.anchor)}`) || el.id === tI.anchor)?.label?.trim() || el.querySelector('h1, h2, h3')?.textContent?.trim() || String(i + 1);
      return { label, text: (el.textContent ?? '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim() };
    });
  } finally { render.dispose(); host.remove(); }
}

/** Words and their places in normalised text (letters and digits of any script). */
const WORD = /[\p{L}\p{M}\p{N}]/u;

const normCache = new WeakMap<Unit, { raw: string; norm: { text: string; map: Int32Array } }>();

/** Search one book's units. Excerpts are cut at word boundaries, about eight words each side. */
export function searchUnits(units: Unit[], query: string, o: Options, limit = 200): { hits: Hit[]; total: number } {
  const prep = (s: string) => (o.exact ? { text: s, map: Int32Array.from({ length: s.length + 1 }, (_, i) => i) } : normalizeForSearch(s));
  const terms = o.mode === 'phrase' ? [prep(query.trim()).text.replace(/\s+/g, ' ')] : prep(query).text.split(/\s+/).filter(Boolean);
  if (!terms.length || !terms[0]) return { hits: [], total: 0 };
  const hits: Hit[] = []; let total = 0;
  units.forEach((u, ui) => {
    // (A unit's normalised text is kept from one search to the next: a big book's thousands of pages took
    // seconds to normalise again for every search.)
    let c = o.exact ? null : normCache.get(u);
    if (!c) { const raw = u.text.replace(/\s/g, ' '); c = { raw, norm: prep(raw) }; if (!o.exact) normCache.set(u, c); }
    const { raw, norm } = c;
    const found = (term: string) => {
      const at: number[] = [];
      for (let i = norm.text.indexOf(term); i >= 0; i = norm.text.indexOf(term, i + Math.max(1, term.length))) {
        if (o.wholeWord && ((i > 0 && WORD.test(norm.text[i - 1])) || (i + term.length < norm.text.length && WORD.test(norm.text[i + term.length])))) continue;
        at.push(i);
      }
      return at;
    };
    const per = terms.map((term) => ({ term, at: found(term) }));
    // All words: each must be on the page (or in the chapter); any word: one is enough.
    if (o.mode === 'all' && per.some((p) => !p.at.length)) return;
    const places = per.flatMap((p) => p.at.map((i) => ({ i, len: p.term.length }))).sort((a, b) => a.i - b.i);
    let nth = 0;
    for (const { i, len } of places) {
      total++;
      if (hits.length >= limit) continue;
      const s = norm.map[i], e = norm.map[Math.min(norm.map.length - 1, i + len)];
      let a = Math.max(0, s - 70); if (a > 0) { const sp = raw.indexOf(' ', a); a = sp >= 0 && sp < s ? sp + 1 : a; }
      let b = Math.min(raw.length, e + 70); if (b < raw.length) { const sp = raw.lastIndexOf(' ', b); b = sp > e ? sp : b; }
      const clean = (x: string) => x.replace(/ـ/g, '').replace(/[-]/g, '').replace(/\s+/g, ' ');
      hits.push({ unit: ui, label: u.label, nth: nth++, before: (a > 0 ? '… ' : '') + clean(raw.slice(a, s)).trimStart(), match: clean(raw.slice(s, e)), after: clean(raw.slice(e, b)).trimEnd() + (b < raw.length ? ' …' : '') });
    }
  });
  return { hits, total };
}

/** Where the reader should go when a result is opened (read once by the reader as the book opens). */
export type Jump = { id: string; q: string; unit: number; nth: number; pdf: boolean };
export function setJump(j: Jump): void { try { sessionStorage.setItem('kr.searchJump', JSON.stringify(j)); } catch { /* private mode */ } }
export function takeJump(id: string): Jump | null {
  try { const raw = sessionStorage.getItem('kr.searchJump'); if (!raw) return null; const j = JSON.parse(raw) as Jump; if (j.id !== id) return null; sessionStorage.removeItem('kr.searchJump'); return j; } catch { return null; }
}

/** Where to come back to from a result: the search as it was (query, which books, how far down the list), so
 *  going back from the book opens it again with its results. */
export type Return = { q: string; scope: { kind: 'all' } | { kind: 'folder'; id: string } | { kind: 'picked'; ids: string[]; leaveOut: boolean }; scroll: number; shown: Record<string, number> };
export function setReturn(r: Return): void { try { sessionStorage.setItem('kr.searchReturn', JSON.stringify(r)); } catch { /* private mode */ } }
export function takeReturn(): Return | null {
  try { const raw = sessionStorage.getItem('kr.searchReturn'); if (!raw) return null; sessionStorage.removeItem('kr.searchReturn'); return JSON.parse(raw) as Return; } catch { return null; }
}

/** A PDF's page texts kept from an earlier reading (by this search or the reader's own), or null. */
export async function storedPages(book: Book): Promise<string[] | null> {
  const m = memo.get(book.id); if (m) return m.map((u) => u.text);
  const stored = await db.getText(book.id).catch(() => null);
  if (!stored || stored.key !== keyOf(book)) return null;
  memo.set(book.id, stored.units);
  return stored.units.map((u) => u.text);
}
/** Keep a PDF's page texts once the reader has read them all (its search across books is then quick too). */
export async function storePages(book: Book, texts: string[]): Promise<void> {
  if (memo.has(book.id)) return;
  const units = texts.map((text, i) => ({ label: String(i + 1), text }));
  memo.set(book.id, units);
  await db.putText(book.id, { key: keyOf(book), units }).catch(() => undefined);
}
