// A Shamela book in the reader: the file holds the card, the contents and the pages (see sources/shamela.ts).
// Each page is one block of the flow — the reader's place in the book is a page, which stays where it is as
// pages arrive — grouped into chapters by the contents. A chapter rarely begins at the top of a page: the
// site's contents point at the page a chapter starts on, and one page often carries the end of one chapter
// and the start of the next (or several short ones). So a page with chapters starting on it is cut at
// their titles — the paragraph that opens with the entry's words — and each piece goes to its chapter; a
// chapter read by itself then holds its own text and nothing else. A book still online has its pages
// fetched as they come near the screen (and the ones ahead of them), each kept in the file once read.
import type { FlowHandler, FlowRender, TocItem } from './types';
import type { ShamelaBook, ShamelaPageData, ShamelaToc } from '../sources/shamela';
import { SHAMELA } from '../sources/shamela';
import { t } from '../i18n';

const el = (tag: string, cls?: string) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const arNum = (n: string | number) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
/** Text as compared for a chapter's opening words: no diacritics, one shape of alef, ya and ta marbuta,
 *  Western digits, no punctuation, one space between words. */
const norm = (s: string) => s.normalize('NFKC').replace(/[ً-ْٰـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** The page's text cut before each title's paragraph: `titles.length + 1` pieces (the first is what comes
 *  before the first title — empty when a chapter begins at the top of the page). A title not found takes
 *  its text from the cut before it, so nothing is lost and the chapter that starts here still reads. */
export function splitPage(html: string, titles: string[]): string[] {
  const box = document.createElement('div'); box.innerHTML = html;
  const nodes = Array.from(box.childNodes);
  const texts = nodes.map((n) => norm(n.textContent ?? ''));
  const cuts: number[] = []; let from = 0;
  for (const title of titles) {
    const key = norm(title);
    let found = -1;
    if (key) for (let i = from; i < nodes.length; i++) {
      const txt = texts[i]; if (!txt) continue;
      if (txt.startsWith(key) || (key.startsWith(txt) && txt.length >= Math.min(key.length, 12)) || (key.length >= 16 && txt.includes(key))) { found = i; break; }
    }
    if (found < 0) found = cuts.length ? cuts[cuts.length - 1] : 0;
    cuts.push(found); from = found;
  }
  const parts: string[] = [];
  const bounds = [0, ...cuts, nodes.length];
  for (let j = 0; j < bounds.length - 1; j++) {
    const piece = el('div'); for (const n of nodes.slice(bounds[j], bounds[j + 1])) piece.append(n.cloneNode(true));
    parts.push(piece.innerHTML.trim());
  }
  return parts;
}

interface PagePart { block: HTMLElement; title?: string }
interface PageSlots { parts: PagePart[]; first: number }

export const shamelaHandler: FlowHandler = {
  kind: 'flow',
  format: 'shamela',
  async readMeta(file) {
    const info = JSON.parse(await file.text()) as ShamelaBook;
    return { title: info.title, author: info.author || undefined, language: 'ar', pageCount: info.pages };
  },
  async render(file, ctx): Promise<FlowRender> {
    const info = JSON.parse(await file.text()) as ShamelaBook;
    const root = el('div', 'kr-content kr-shamela'); root.dir = 'rtl'; root.lang = 'ar';
    const content: Record<number, ShamelaPageData> = info.content ?? {};
    const toc: ShamelaToc[] = (info.toc.length ? info.toc : [{ title: info.title, page: 1, level: 0 }]).filter((e) => e.page >= 1);
    // The chapters: one section per top-level entry; the pages before the first one (the card, a preface)
    // make a chapter of their own.
    const heads: (ShamelaToc & { synthetic?: boolean })[] = toc.filter((e) => e.level === 0);
    if (!heads.length || heads[0].page > 1 || toc[0] !== heads[0]) heads.unshift({ title: info.meta.find((m) => m.label === 'الكتاب')?.value ? 'بطاقة الكتاب' : info.title, page: 1, level: 0, synthetic: true });
    const tocItems: TocItem[] = [];
    const sections = new Map<ShamelaToc, HTMLElement>();
    heads.forEach((h, i) => {
      const sec = el('section', 'kr-chapter'); sec.id = ctx.id(`ch${i}`);
      const title = el('h2', 'kr-shamela-title'); title.textContent = h.title; sec.append(title);
      sections.set(h, sec); root.append(sec);
      if (i === 0 && info.meta.length) {
        const card = el('div', 'kr-txt kr-page kr-shamela-card');
        for (const m of info.meta) { const line = el('div', 'kr-para'); const b = el('b'); b.textContent = `${m.label}: `; line.append(b, m.value); card.append(line); }
        sec.append(card);
      }
    });
    // The entries starting on each page, in the order of the contents (the synthetic first chapter has no
    // words of its own on the page).
    const markersAt = new Map<number, ShamelaToc[]>();
    for (const e of toc) { const list = markersAt.get(e.page); if (list) list.push(e); else markersAt.set(e.page, [e]); }
    const slots = new Map<number, PageSlots>();
    let current = sections.get(heads[0])!;
    const anchorOf = new Map<ShamelaToc, string>();
    let subs = 0;
    for (let n = 1; n <= info.pages; n++) {
      const markers = markersAt.get(n) ?? [];
      const parts: PagePart[] = [];
      const block = (j: number) => { const pg = el('div', 'kr-txt kr-page'); pg.dataset.page = String(n); pg.dataset.part = String(j); pg.id = j === (markers.length ? 1 : 0) ? ctx.id(`p${n}`) : ctx.id(`p${n}-${j}`); return pg; };
      // What comes before the first entry on the page belongs to the chapter under way.
      const head0 = block(0); parts.push({ block: head0 }); current.append(head0);
      markers.forEach((m, k) => {
        if (m.level === 0 && sections.has(m)) { current = sections.get(m)!; anchorOf.set(m, current.id); }
        else { const hh = el('h3', 'kr-shamela-sub'); hh.textContent = m.title; hh.id = ctx.id(`t${subs++}`); anchorOf.set(m, hh.id); current.append(hh); }
        const b = block(k + 1); parts.push({ block: b, title: m.title }); current.append(b);
      });
      slots.set(n, { parts, first: markers.length ? 1 : 0 });
      fill(slots.get(n)!, n, content[n]);
    }
    // The contents in the site's own order, each entry at its chapter or heading.
    if (heads[0].synthetic) tocItems.push({ label: heads[0].title, anchor: sections.get(heads[0])!.id, depth: 0 });
    for (const e of toc) { const a = anchorOf.get(e) ?? (sections.get(e)?.id); if (a) tocItems.push({ label: e.title, anchor: a, depth: e.level === 0 ? 0 : Math.max(1, e.level) }); }
    // Pages still on the site are fetched as they come near, a few at a time, nearest first.
    let gone = false; const wanted = new Set<number>(); let running = 0; let io: IntersectionObserver | null = null;
    const online = !!ctx.bookId && Object.keys(content).length < info.pages;
    const pump = async () => {
      if (gone || running >= 3 || !wanted.size) return;
      const n = [...wanted].sort((a, b) => a - b)[0]; wanted.delete(n); running++;
      try {
        const { page } = await import('../sources/shamela');
        const data = await page(info.id, n);
        if (gone) return;
        content[n] = data; const s = slots.get(n); if (s) fill(s, n, data);
        root.dispatchEvent(new CustomEvent('kr-content-changed', { bubbles: true }));
        // (A fetched page goes into the file now and then, so the next opening has it.)
        if (Object.keys(content).length % 10 === 0 || Object.keys(content).length === info.pages) void save();
      } catch (e) {
        const s = slots.get(n); const err = s?.parts[s.first].block.querySelector('.kr-page-wait');
        if (err) { err.textContent = (e as Error).message === 'cloudflare' ? t('pageNeedsCheck') : (e as Error).message === 'offline' ? t('pageOffline') : t('pageFailed'); err.classList.add('failed'); }
      } finally { running--; void pump(); }
    };
    const save = async () => {
      if (!ctx.bookId) return;
      try {
        // (Over what the file holds now: the contents completed meanwhile, pages fetched by a download.)
        const { mergeFile } = await import('../sources/shamela');
        await mergeFile(ctx.bookId, (cur) => ({ ...cur, content: { ...(cur.content ?? {}), ...content } }));
      } catch { /* kept for this reading */ }
    };
    if (online) {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const n = Number((e.target as HTMLElement).dataset.page);
          for (let k = n; k <= Math.min(info.pages, n + 6); k++) if (!content[k] && slots.has(k)) wanted.add(k);
        }
        void pump(); void pump(); void pump();
      }, { rootMargin: '150% 0px' });
      for (const [n, s] of slots) if (!content[n]) io.observe(s.parts[s.first].block);
    }
    return { element: root, toc: tocItems, images: [], rtl: true, dispose: () => { gone = true; io?.disconnect(); if (online) void save(); } };
  },
};

/** The page into its pieces: the mark ([part · page]) on the first piece that has text, the pieces without
 *  text hidden; a page not here yet shows its number and a wait in the piece a jump lands on. */
function fill(s: PageSlots, n: number, data: ShamelaPageData | undefined): void {
  for (const p of s.parts) { p.block.replaceChildren(); p.block.hidden = false; p.block.classList.remove('pending'); }
  if (!data) {
    s.parts.forEach((p, j) => { if (j !== s.first) p.block.hidden = true; });
    const pg = s.parts[s.first].block;
    const mark = el('span', 'kr-page-mark'); mark.contentEditable = 'false'; mark.textContent = `[${arNum(n)}]`;
    const wait = el('span', 'kr-page-wait'); wait.textContent = '…';
    pg.append(mark, wait); pg.classList.add('pending');
    return;
  }
  const pieces = s.parts.length > 1 ? splitPage(data.html, s.parts.slice(1).map((p) => p.title ?? '')) : [data.html];
  let marked = false;
  s.parts.forEach((p, j) => {
    const html = pieces[j] ?? '';
    if (!html) { p.block.hidden = true; return; }
    if (!marked) { marked = true; const mark = el('span', 'kr-page-mark'); mark.contentEditable = 'false'; mark.textContent = data.part ? `[${data.part} · ص${arNum(data.p)}]` : `[ص${arNum(data.p)}]`; mark.title = `${SHAMELA}`; p.block.append(mark); }
    const body = el('div', 'kr-page-body'); body.innerHTML = html; p.block.append(body);
  });
  if (!marked) { const pg = s.parts[s.first].block; pg.hidden = false; const mark = el('span', 'kr-page-mark'); mark.contentEditable = 'false'; mark.textContent = `[ص${arNum(data.p)}]`; pg.append(mark); }
}
