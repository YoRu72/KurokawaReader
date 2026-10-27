// A Shamela book in the reader: the file holds the card, the contents and the pages (see sources/shamela.ts).
// Each page is one block of the flow — the reader's place in the book is a page, which stays where it is as
// pages arrive — grouped into chapters by the contents. A book still online has its pages fetched as they
// come near the screen (and the ones ahead of them), each kept in the file once read.
import type { FlowHandler, FlowRender, TocItem } from './types';
import type { ShamelaBook, ShamelaPageData, ShamelaToc } from '../sources/shamela';
import { SHAMELA } from '../sources/shamela';
import { db } from '../db';

const el = (tag: string, cls?: string) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const arNum = (n: string | number) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);

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
    // The contents, with the pages each entry covers (until the next entry at its level or above).
    const toc: ShamelaToc[] = info.toc.length ? info.toc : [{ title: info.title, page: 1, level: 0 }];
    const heads = toc.filter((e) => e.level === 0);
    if (!heads.length || heads[0].page > 1) heads.unshift({ title: info.meta.find((m) => m.label === 'الكتاب')?.value ? 'بطاقة الكتاب' : info.title, page: 1, level: 0 });
    const pages = new Map<number, HTMLElement>();
    const tocItems: TocItem[] = [];
    heads.forEach((h, i) => {
      const from = h.page, to = (heads[i + 1]?.page ?? info.pages + 1) - 1;
      const sec = el('section', 'kr-chapter'); sec.id = ctx.id(`ch${i}`);
      const title = el('h2', 'kr-shamela-title'); title.textContent = h.title; sec.append(title);
      tocItems.push({ label: h.title, anchor: sec.id, depth: 0 });
      if (i === 0 && info.meta.length) {
        const card = el('div', 'kr-txt kr-page kr-shamela-card');
        for (const m of info.meta) { const line = el('div', 'kr-para'); const b = el('b'); b.textContent = `${m.label}: `; line.append(b, m.value); card.append(line); }
        sec.append(card);
      }
      // Sub-entries become headings inside the chapter, at their pages.
      const subs = toc.filter((e) => e.level > 0 && e.page >= from && e.page <= to);
      for (let n = Math.max(1, from); n <= to; n++) {
        for (const s of subs.filter((e) => e.page === n)) { const hh = el('h3', 'kr-shamela-sub'); hh.textContent = s.title; hh.id = ctx.id(`t${tocItems.length}`); tocItems.push({ label: s.title, anchor: hh.id, depth: s.level }); sec.append(hh); }
        const pg = el('div', 'kr-txt kr-page'); pg.dataset.page = String(n); pg.id = ctx.id(`p${n}`);
        fill(pg, n, content[n]);
        pages.set(n, pg); sec.append(pg);
      }
      root.append(sec);
    });
    // Pages still on the site are fetched as they come near, a few at a time, nearest first.
    let gone = false; const wanted = new Set<number>(); let running = 0; let io: IntersectionObserver | null = null;
    const online = !!ctx.bookId && Object.keys(content).length < info.pages;
    const pump = async () => {
      if (gone || running >= 2 || !wanted.size) return;
      const n = [...wanted].sort((a, b) => a - b)[0]; wanted.delete(n); running++;
      try {
        const { page } = await import('../sources/shamela');
        const data = await page(info.id, n);
        if (gone) return;
        content[n] = data; const pg = pages.get(n); if (pg) fill(pg, n, data);
        root.dispatchEvent(new CustomEvent('kr-content-changed', { bubbles: true }));
        // (A fetched page goes into the file now and then, so the next opening has it.)
        if (Object.keys(content).length % 10 === 0 || Object.keys(content).length === info.pages) void save();
      } catch (e) {
        const pg = pages.get(n); if (pg) { const err = pg.querySelector('.kr-page-wait'); if (err) { err.textContent = (e as Error).message === 'cloudflare' ? 'الموقع يطلب التحقق من المتصفح — افتحه من صفحة الكتاب في المصادر' : (e as Error).message === 'offline' ? 'لا اتصال — تعذّر جلب الصفحة' : 'تعذّر جلب الصفحة'; err.classList.add('failed'); } }
      } finally { running--; void pump(); }
    };
    const save = async () => {
      if (!ctx.bookId) return;
      try {
        const next: ShamelaBook = { ...info, content };
        const f = new File([JSON.stringify(next)], file instanceof File ? file.name : `${info.title}.shamela.json`, { type: 'application/x-kurokawa-shamela+json' });
        await db.putFile(ctx.bookId, f);
        if (Object.keys(content).length >= info.pages) await db.updateBook(ctx.bookId, (b) => { if (b.remote) b.remote.online = false; });
      } catch { /* kept for this reading */ }
    };
    if (online) {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const n = Number((e.target as HTMLElement).dataset.page);
          for (let k = n; k <= Math.min(info.pages, n + 3); k++) if (!content[k] && pages.has(k)) wanted.add(k);
        }
        void pump(); void pump();
      }, { rootMargin: '150% 0px' });
      for (const [n, pg] of pages) if (!content[n]) io.observe(pg);
    }
    return { element: root, toc: tocItems, images: [], rtl: true, dispose: () => { gone = true; io?.disconnect(); if (online) void save(); } };
  },
};

function fill(pg: HTMLElement, n: number, data: ShamelaPageData | undefined): void {
  pg.replaceChildren();
  const mark = el('span', 'kr-page-mark'); mark.contentEditable = 'false';
  if (!data) { mark.textContent = `[${arNum(n)}]`; const wait = el('span', 'kr-page-wait'); wait.textContent = '…'; pg.append(mark, wait); pg.classList.add('pending'); return; }
  pg.classList.remove('pending');
  mark.textContent = data.part ? `[${data.part} · ص${arNum(data.p)}]` : `[ص${arNum(data.p)}]`; mark.title = `${SHAMELA}`;
  const body = el('div', 'kr-page-body'); body.innerHTML = data.html;
  pg.append(mark, body);
}
