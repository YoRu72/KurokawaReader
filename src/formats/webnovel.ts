// A novel from an extension in the reader: the file holds the card and the chapter list (see
// sources/ext/source.ts); each chapter is one block of the flow and a chapter of the contents, its text
// fetched from the site as it comes near the screen (and the next ones), kept in the file once read.
import type { FlowHandler, FlowRender, TocItem } from './types';
import type { WebNovel } from '../sources/ext/source';
import { db } from '../db';
import { t } from '../i18n';
import { badChapter } from '../sources/chapterhealth';

const el = (tag: string, cls?: string) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

export const webnovelHandler: FlowHandler = {
  kind: 'flow',
  format: 'webnovel',
  async readMeta(file) {
    const info = JSON.parse(await file.text()) as WebNovel;
    return { title: info.title, author: info.author || undefined, language: info.lang, pageCount: info.chapters.length, description: info.summary };
  },
  async render(file, ctx): Promise<FlowRender> {
    const info = JSON.parse(await file.text()) as WebNovel;
    const rtl = /^(ar|fa|ur|he)/i.test(info.lang ?? '') || /[؀-ۿ]/.test(info.title);
    const root = el('div', 'kr-content kr-webnovel'); root.dir = rtl ? 'rtl' : 'ltr'; if (info.lang) root.lang = info.lang;
    const content: Record<string, { html: string; at: number }> = { ...(info.content ?? {}) };
    // (A chapter kept as a site's check page or as nothing — by an older version — is let go and fetched again.)
    const dropped = new Set<string>();
    for (const [p, v] of Object.entries(content)) if (badChapter(v.html)) { delete content[p]; dropped.add(p); }
    const bodies = new Map<string, HTMLElement>();
    const tocItems: TocItem[] = [];
    // The card first — the title, the author, the summary, the tags — at the head of the first chapter's
    // section (so a reader going chapter by chapter sees the first chapter under it, not a page of its own).
    const card = el('div', 'kr-novel-card'); card.id = ctx.id('card');
    const ht = el('h1', 'kr-novel-title'); ht.textContent = info.title; card.append(ht);
    if (info.author) { const a = el('p', 'kr-para kr-novel-author'); a.textContent = info.author; card.append(a); }
    if (info.summary) { const s = el('div', 'kr-txt kr-novel-summary'); for (const line of info.summary.split(/\n+/)) { const p = el('p', 'kr-para'); p.textContent = line; s.append(p); } card.append(s); }
    if (info.genres.length) { const g = el('p', 'kr-para kr-novel-genres'); g.textContent = info.genres.join(' · '); card.append(g); }
    tocItems.push({ label: info.title, anchor: card.id, depth: 0 });
    if (!info.chapters.length) { const sec = el('section', 'kr-chapter kr-novel-chapter'); sec.append(card); root.append(sec); }
    info.chapters.forEach((c, i) => {
      const sec = el('section', 'kr-chapter kr-novel-chapter'); sec.id = ctx.id(`c${i}`);
      if (i === 0) sec.append(card);
      const h2 = el('h2', 'kr-chapter-title'); h2.textContent = c.name || `${i + 1}`; h2.id = ctx.id(`t${i}`); sec.append(h2);
      const body = el('div', 'kr-txt kr-chap'); body.dataset.i = String(i); body.id = ctx.id(`b${i}`);
      fill(body, content[c.path]);
      bodies.set(c.path, body); sec.append(body); root.append(sec);
      tocItems.push({ label: c.name || `${i + 1}`, anchor: i === 0 ? h2.id : sec.id, depth: 0 });
    });
    // Chapters still on the site are fetched as they come near, two at a time, nearest first.
    let gone = false; const wanted = new Set<number>(); let running = 0; let io: IntersectionObserver | null = null; let dirty = 0;
    const online = !!ctx.bookId && Object.keys(content).length < info.chapters.length;
    // A chapter asked for brings the two after it (hidden or not: a reader going chapter by chapter finds the
    // next one already here).
    const want = (i: number) => { for (let k = i; k <= Math.min(info.chapters.length - 1, i + 2); k++) if (!content[info.chapters[k].path]) wanted.add(k); };
    const pump = async () => {
      if (gone || running >= 2 || !wanted.size) return;
      const i = [...wanted].sort((a, b) => a - b)[0]; wanted.delete(i); running++;
      const c = info.chapters[i]; const body = bodies.get(c.path)!;
      try {
        const { extHandle, fetchChapter } = await import('../sources/ext/source');
        const h = await extHandle(info.src);
        const html = await fetchChapter(h, info, c);
        if (gone) return;
        content[c.path] = { html, at: Date.now() }; fill(body, content[c.path]);
        root.dispatchEvent(new CustomEvent('kr-content-changed', { bubbles: true }));
        if (++dirty >= 3 || Object.keys(content).length === info.chapters.length) { dirty = 0; void save(); }
      } catch (e) {
        const err = body.querySelector('.kr-page-wait');
        if (err) { const kind = (e as { kind?: string }).kind; err.textContent = (e as Error).message === 'emptyChapter' ? t('chapterEmpty') : kind === 'cloudflare' ? t('chapterNeedsCheck') : kind === 'blocked' ? t('sourceBlockedShort') : kind === 'offline' ? t('chapterOffline') : t('chapterFailed', { error: (e as Error).message }); err.classList.add('failed'); }
      } finally { running--; void pump(); }
    };
    const save = async () => {
      if (!ctx.bookId) return;
      try {
        const { saveNovelFile } = await import('../sources/ext/source');
        const book = await db.getBook(ctx.bookId); if (!book) return;
        await saveNovelFile(book, (cur) => { const all = { ...(cur.content ?? {}), ...content }; for (const p of dropped) if (!content[p]) delete all[p]; return { ...cur, content: all }; });
      } catch { /* kept for this reading */ }
    };
    if (online) {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) { if (e.isIntersecting) want(Number((e.target as HTMLElement).dataset.i)); }
        void pump(); void pump();
      }, { rootMargin: '150% 0px' });
      for (const c of info.chapters) if (!content[c.path]) io.observe(bodies.get(c.path)!);
      // (The first chapters straight away, before anything is scrolled.)
      const first = info.chapters.findIndex((c) => !content[c.path]); if (first >= 0 && first < 3) { want(first); void pump(); void pump(); }
    }
    // A picture the site refuses to a bare request is fetched with the extension's headers (its address let go
    // with the book).
    const made: string[] = [];
    root.addEventListener('error', (e) => {
      const img = e.target as HTMLImageElement; if (!(img instanceof HTMLImageElement) || img.dataset.retried) return;
      img.dataset.retried = '1';
      void import('../sources/http').then(({ fetchBytes }) => fetchBytes(img.src, undefined, { headers: info.imageHeaders ?? { referer: info.url ?? '' } })).then((bytes) => { const u = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer])); made.push(u); img.src = u; }).catch(() => { img.alt = img.alt || '✕'; });
    }, true);
    return { element: root, toc: tocItems, images: [], rtl, dispose: () => { gone = true; io?.disconnect(); if (online && dirty) void save(); for (const u of made) URL.revokeObjectURL(u); } };
  },
};

function fill(body: HTMLElement, data: { html: string } | undefined): void {
  body.replaceChildren();
  if (!data) { const wait = el('p', 'kr-para kr-page-wait'); wait.textContent = '…'; body.append(wait); body.classList.add('pending'); return; }
  body.classList.remove('pending');
  body.innerHTML = data.html;
}
