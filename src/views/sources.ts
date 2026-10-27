// Sources — books browsed and fetched from the web, drawn the way Mihon draws its extensions: the sources as
// cards; a source as a shelf of covers with a search box, a filter sheet, chips for its shelves and for the
// tags its results share, more loading as the shelf is scrolled; a book's page with its details, its tags,
// the files to fetch, and — for Shamela — its contents, read from the site or fetched whole for offline.
import { h, icon, iconButton, toast, openSheet, coverColors, pickButton } from '../ui/dom';
import { t, localDigits, getLang } from '../i18n';
import { navigate } from '../router';
import { db, type Book } from '../db';
import { importFiles } from '../library';
import { fmtMB } from '../updates';
import { setJump } from './reader';
import { SourceError, type Source, type SourceBook, type SourceDetails, type SourceFilter, type FilterValues, type SourceTag, type SourceChapter } from '../sources/types';
import { archiveSource } from '../sources/archive';
import { shamelaSource, addToLibrary, downloadBook, readBookFile, expandToc, catalogueState, buildCatalogue, isWeb } from '../sources/shamela';
import * as link from '../sources/shamelalink';
import { passChallenge } from '../sources/http';

export const SOURCES: Source[] = [archiveSource, shamelaSource];
const sourceById = (id: string) => SOURCES.find((s) => s.id === id);
const path = (src: string, o: { q?: string; shelf?: string; tags?: string[] } = {}) => { const sp = new URLSearchParams(); if (o.q) sp.set('q', o.q); if (o.shelf) sp.set('shelf', o.shelf); if (o.tags?.length) sp.set('tags', o.tags.join('\u0001')); const qs = sp.toString(); return `/sources/${src}${qs ? `?${qs}` : ''}`; };
const bookPath = (src: string, id: string) => `/sources/${src}/book/${encodeURIComponent(id)}`;

/* ---------- filters kept per source ---------- */
function filterValues(src: Source): FilterValues {
  const base: FilterValues = {}; for (const f of src.filters()) base[f.id] = f.value;
  try { return { ...base, ...(JSON.parse(localStorage.getItem(`kr.src.${src.id}.filters`) ?? '{}') as FilterValues) }; } catch { return base; }
}
function saveFilters(src: Source, v: FilterValues): void { localStorage.setItem(`kr.src.${src.id}.filters`, JSON.stringify(v)); }

/* ---------- results kept for the way back ---------- */
interface Cached { items: SourceBook[]; page: number; hasMore: boolean; tags: SourceTag[]; title?: string; scroll: number }
const cache = new Map<string, Cached>();

export function sourcesView(srcId?: string, bookId?: string, q?: string, shelf?: string, tags?: string[]): HTMLElement & { dispose?: () => void } {
  const src = srcId ? sourceById(srcId) : undefined;
  if (src && bookId) return detailsView(src, bookId);
  if (src) return browseView(src, q ?? '', shelf, tags ?? []);
  return hubView();
}

/* ---------- the hub ---------- */
function hubView(): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'library-body sources-hub' });
  const root = h('div', { class: 'view sources-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => navigate('/')), h('div', { class: 'title' }, t('sources'))), body) as HTMLElement & { dispose?: () => void };
  body.append(h('p', { class: 'hint catalog-hint' }, t('sourcesHint')));
  for (const s of SOURCES) {
    const card = h('article', { class: 'source-card' });
    const head = h('button', { type: 'button', class: 'source-head', onclick: () => navigate(path(s.id)) },
      h('span', { class: 'source-icon' }, icon(s.id === 'archive' ? 'library' : 'books')),
      h('span', { class: 'source-text' }, h('b', { dir: 'auto' }, s.name), h('small', null, s.site.replace(/^https?:\/\//, ''))),
      icon('chevronRight'));
    card.append(head, h('p', { class: 'source-desc', dir: 'auto' }, s.description));
    if (s.id === 'shamela') card.append(shamelaStatus());
    if (s.needsApp && isWeb()) card.append(h('p', { class: 'hint warn' }, t('sourceNeedsApp')));
    body.append(card);
  }
  return root;
}

/** Shamela's two helpers: the sign-in to وصلة الشاملة, and the catalogue of titles kept on the device. */
function shamelaStatus(): HTMLElement {
  const box = h('div', { class: 'source-status' });
  const draw = async () => {
    box.replaceChildren();
    // Sign-in.
    const on = link.isConnected();
    box.append(h('div', { class: 'source-row' },
      icon(on ? 'check' : 'user'),
      h('span', { class: 'grow' }, h('b', null, 'وصلة الشاملة (shamela.link)'), h('small', null, on ? t('shamelaLinkOn') : t('shamelaLinkOff'))),
      on ? h('button', { type: 'button', class: 'btn small', onclick: () => { link.disconnect(); void draw(); } }, t('signOut'))
        : h('button', { type: 'button', class: 'btn small primary', onclick: () => void link.connect().catch((e) => toast(describe(e), 'error')) }, icon('user'), t('signIn'))));
    // Catalogue.
    const st = await catalogueState();
    const row = h('div', { class: 'source-row' });
    const status = h('small', null, st ? t('catalogueState', { n: localDigits(st.books), when: new Date(st.at).toLocaleDateString(getLang() === 'ar' ? 'ar' : undefined) }) : t('catalogueNone'));
    const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
    const btn = h('button', { type: 'button', class: 'btn small' + (st ? '' : ' tonal'), onclick: async () => {
      btn.disabled = true; track.hidden = false; let live = true; const off = () => { live = false; }; window.addEventListener('hashchange', off, { once: true });
      try { const n = await buildCatalogue((d, tot) => { bar.style.width = `${(d / tot) * 100}%`; status.textContent = t('catalogueFetching', { n: localDigits(d), total: localDigits(tot) }); }, () => live); toast(t('catalogueDone', { n: localDigits(n) })); }
      catch (e) { toast(describe(e), 'error'); }
      finally { btn.disabled = false; track.hidden = true; void draw(); }
    } }, icon('download'), st ? t('catalogueUpdate') : t('catalogueFetch'));
    row.append(icon('books'), h('span', { class: 'grow' }, h('b', null, t('catalogue')), status, track), btn);
    box.append(row);
  };
  void draw();
  return box;
}

/* ---------- browsing a source ---------- */
function browseView(src: Source, q: string, shelf: string | undefined, tags: string[]): HTMLElement & { dispose?: () => void } {
  let filters = filterValues(src);
  const key = `${src.id}|${q}|${shelf ?? ''}|${tags.join(',')}|${JSON.stringify(filters)}`;
  const grid = h('div', { class: 'src-grid' });
  const sentinel = h('div', { class: 'src-more' });
  const status = h('div', { class: 'src-status' });
  const tagRow = h('div', { class: 'folder-chips src-tags', hidden: true });
  const shelfRow = h('div', { class: 'folder-chips src-shelves', hidden: true });
  const input = h('input', { type: 'search', class: 'src-search', placeholder: t('searchSource', { name: src.name }), value: q, dir: 'auto', 'aria-label': t('search') }) as HTMLInputElement;
  const form = h('form', { class: 'src-search-row', onsubmit: (e: Event) => { e.preventDefault(); navigate(path(src.id, { q: input.value.trim(), shelf, tags })); } },
    input, h('button', { type: 'submit', class: 'icon-btn', 'aria-label': t('search') }, icon('search')));
  const titleEl = h('div', { class: 'title' }, h('span', { dir: 'auto' }, src.name));
  const body = h('div', { class: 'library-body src-body' }, form, shelfRow, tagRow, status, grid, sentinel);
  const root = h('div', { class: 'view sources-view' },
    h('header', { class: 'topbar' }, iconButton('back', t('back'), () => (q || shelf || tags.length ? navigate(path(src.id)) : navigate('/sources'))), titleEl,
      h('div', { class: 'topbar-actions' }, iconButton('filter', t('filters'), () => filterSheet(src, filters, (v) => { filters = v; saveFilters(src, v); navigate(`${path(src.id, { q, shelf, tags })}${q || shelf || tags.length ? '&' : '?'}v=${Date.now().toString(36)}`, true); })))),
    body) as HTMLElement & { dispose?: () => void };
  let gone = false; let page = 0; let hasMore = true; let loading = false; let items: SourceBook[] = []; let allTags: SourceTag[] = [];
  root.dispose = () => { gone = true; io.disconnect(); const c = cache.get(key); if (c) c.scroll = root.closest('.view')?.scrollTop ?? document.scrollingElement?.scrollTop ?? 0; };

  // Shelves (collections, categories) when nothing is searched.
  if (src.shelves) void src.shelves().then((list) => {
    if (gone || !list.length) return;
    shelfRow.hidden = false;
    shelfRow.append(h('button', { type: 'button', class: 'chip' + (!shelf ? ' on' : ''), onclick: () => navigate(path(src.id, { q, tags })) }, h('span', null, t('allShelves'))));
    for (const s of list) shelfRow.append(h('button', { type: 'button', class: 'chip' + (shelf === s.id ? ' on' : ''), onclick: () => navigate(path(src.id, { q, shelf: s.id, tags })) }, h('span', { dir: 'auto' }, s.label), s.count ? h('small', null, ` ${localDigits(s.count)}`) : null));
    if (shelf) { const cur = list.find((s) => s.id === shelf); if (cur) titleEl.replaceChildren(h('span', { dir: 'auto' }, cur.label), h('small', null, src.name)); }
  }).catch(() => undefined);

  const drawTags = () => {
    const shown = new Map<string, SourceTag>();
    for (const tg of tags) shown.set(tg, { id: tg, label: tg });
    for (const tg of allTags) if (!shown.has(tg.id) && shown.size < 16) shown.set(tg.id, tg);
    tagRow.replaceChildren(); tagRow.hidden = !shown.size;
    for (const tg of shown.values()) {
      const on = tags.includes(tg.id);
      tagRow.append(h('button', { type: 'button', class: 'chip tag' + (on ? ' on' : ''), onclick: () => navigate(path(src.id, { q, shelf, tags: on ? tags.filter((x) => x !== tg.id) : [...tags, tg.id] })) }, icon('tag'), h('span', { dir: 'auto' }, tg.label), tg.count ? h('small', null, ` ${localDigits(tg.count)}`) : null));
    }
  };
  const card = (b: SourceBook) => {
    const [c1, c2] = coverColors(b.title);
    const cover = h('div', { class: 'src-cover', style: { background: `linear-gradient(160deg, ${c1}, ${c2})` } }, b.cover ? h('img', { src: b.cover, alt: '', loading: 'lazy', onerror: (e: Event) => (e.target as HTMLElement).remove() }) : h('span', { class: 'src-cover-title', dir: 'auto' }, b.title));
    return h('button', { type: 'button', class: 'src-card', title: b.title, onclick: () => navigate(bookPath(src.id, b.id)) },
      cover,
      b.badge ? h('span', { class: 'src-badge left' }, b.badge) : null,
      b.lang ? h('span', { class: 'src-badge right' }, b.lang.length > 3 ? b.lang.slice(0, 3) : b.lang.toUpperCase()) : null,
      h('span', { class: 'src-title', dir: 'auto' }, b.title),
      b.author ? h('span', { class: 'src-author', dir: 'auto' }, b.author) : null,
      b.description && src.id === 'shamela' && q && String(filters.mode) !== 'titles' ? h('span', { class: 'src-snippet', dir: 'auto' }, b.description) : null);
  };
  const more = async () => {
    if (gone || loading || !hasMore) return;
    loading = true; status.textContent = page === 0 ? t('loading') : '';
    try {
      const f: FilterValues = { ...filters, tags };
      const r = await src.browse(q, f, page + 1, shelf);
      if (gone) return;
      page++; hasMore = r.hasMore; items.push(...r.items);
      if (r.tags?.length && page === 1) { allTags = r.tags; drawTags(); }
      if (r.title && page === 1 && (q || !shelf)) titleEl.replaceChildren(h('span', { dir: 'auto' }, r.title), h('small', null, src.name));
      for (const b of r.items) grid.append(card(b));
      status.textContent = items.length ? '' : t('noResults');
      cache.set(key, { items: [...items], page, hasMore, tags: allTags, title: r.title, scroll: 0 });
    } catch (e) {
      if (gone) return;
      showError(status, e, () => { hasMore = true; void more(); }, src);
      hasMore = false;
    } finally { loading = false; }
  };
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) void more(); }, { rootMargin: '600px' });
  io.observe(sentinel);
  const had = cache.get(key);
  if (had) { items = [...had.items]; page = had.page; hasMore = had.hasMore; allTags = had.tags; drawTags(); for (const b of items) grid.append(card(b)); if (had.title && (q || !shelf)) titleEl.replaceChildren(h('span', { dir: 'auto' }, had.title), h('small', null, src.name)); requestAnimationFrame(() => { (root.closest('.view') ?? root).scrollTop = had.scroll; }); }
  else if (q || shelf || !src.shelves || src.id === 'archive') void more();
  else { drawTags(); status.textContent = t('pickShelfOrSearch'); }
  if (src.needsApp && isWeb()) status.replaceChildren(h('p', { class: 'hint warn' }, t('sourceNeedsApp')));
  if (src.id === 'shamela' && q && String(filters.mode) !== 'titles' && !link.isConnected()) status.replaceChildren(signInNote());
  return root;
}

function signInNote(): HTMLElement {
  return h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('user')), h('p', null, t('shamelaLinkNeeded')),
    h('button', { type: 'button', class: 'btn primary', onclick: () => void link.connect().catch((e) => toast(describe(e), 'error')) }, icon('user'), t('signIn')),
    h('a', { class: 'btn small', href: 'https://shamela.link/register', target: '_blank', rel: 'noopener' }, icon('external'), t('shamelaLinkRegister')));
}

/** The Mihon-like filter sheet: every filter the source offers, applied on «Done». */
function filterSheet(src: Source, current: FilterValues, apply: (v: FilterValues) => void): void {
  const sh = openSheet(t('filters'), t('close'));
  const vals: FilterValues = { ...current };
  const defs = src.filters();
  const row = (f: SourceFilter): HTMLElement => {
    if (f.kind === 'toggle') return h('label', { class: 'switch-row' }, h('span', null, f.label), h('input', { type: 'checkbox', checked: vals[f.id] !== false, onchange: (e: Event) => { vals[f.id] = (e.target as HTMLInputElement).checked; } }));
    if (f.kind === 'text') return h('label', { class: 'field' }, h('span', null, f.label), h('input', { type: 'text', value: String(vals[f.id] ?? ''), placeholder: f.placeholder ?? '', inputmode: 'numeric', oninput: (e: Event) => { vals[f.id] = (e.target as HTMLInputElement).value; } }));
    if (f.kind === 'multi') return h('div', { class: 'field' }, h('span', null, f.label), h('div', { class: 'folder-chips' }, ...f.options.map((o) => { const on = () => (vals[f.id] as string[] ?? []).includes(o.value); const b = h('button', { type: 'button', class: 'chip' + (on() ? ' on' : ''), onclick: () => { const cur = (vals[f.id] as string[]) ?? []; vals[f.id] = on() ? cur.filter((x) => x !== o.value) : [...cur, o.value]; b.classList.toggle('on', on()); } }, h('span', null, o.label)); return b; })));
    const opts = f.options.map((o): [string, string] => [o.value, o.label]);
    return h('div', { class: 'field' }, h('span', null, f.label), pickButton(f.label, opts, String(vals[f.id] ?? f.value), (v) => { vals[f.id] = v; }, t('close')));
  };
  sh.body.append(...defs.map(row));
  sh.actions.append(
    h('button', { type: 'button', class: 'btn', onclick: () => { for (const f of defs) vals[f.id] = f.value; sh.close(); apply(vals); } }, t('resetFilters')),
    h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); apply(vals); } }, icon('check'), t('done')));
}

/* ---------- a book ---------- */
const downloads = new Map<string, { done: number; total: number; live: boolean }>();

function detailsView(src: Source, id: string): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'library-body src-details' });
  const titleEl = h('div', { class: 'title' }, src.name);
  const root = h('div', { class: 'view sources-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => history.back()), titleEl), body) as HTMLElement & { dispose?: () => void };
  let gone = false; root.dispose = () => { gone = true; };
  body.append(h('div', { class: 'center' }, h('div', { class: 'spinner' }), t('loading')));
  void (async () => {
    let d: SourceDetails;
    try { d = await src.details(id); } catch (e) { if (!gone) { body.replaceChildren(); showError(body, e, () => { root.replaceWith(detailsView(src, id)); }, src); } return; }
    if (gone) return;
    body.replaceChildren();
    titleEl.replaceChildren(h('span', { dir: 'auto' }, d.title));
    const [c1, c2] = coverColors(d.title);
    const head = h('div', { class: 'src-head' },
      h('div', { class: 'src-cover big', style: { background: `linear-gradient(160deg, ${c1}, ${c2})` } }, d.cover ? h('img', { src: d.cover, alt: '', onerror: (e: Event) => (e.target as HTMLElement).remove() }) : h('span', { class: 'src-cover-title', dir: 'auto' }, d.title)),
      h('div', { class: 'src-head-text' },
        h('h2', { dir: 'auto' }, d.title),
        d.author ? h('p', { class: 'src-author-line', dir: 'auto' }, d.author) : null,
        h('div', { class: 'src-chips' }, ...[d.year, d.lang, d.pages ? t('pagesN', { n: localDigits(d.pages) }) : '', d.volumes?.length ? t('volumesN', { n: localDigits(d.volumes.length) }) : '', d.badge].filter(Boolean).map((x) => h('span', { class: 'src-chip' }, x!))),
        d.url ? h('a', { class: 'src-site', href: d.url, target: '_blank', rel: 'noopener' }, icon('external'), ' ', src.site.replace(/^https?:\/\//, '')) : null));
    body.append(head);
    const actions = h('div', { class: 'src-actions' }); body.append(actions);
    if (src.id === 'shamela') await shamelaActions(actions, d, id, () => gone);
    else fileActions(actions, src, d);
    if (d.description) { const p = h('p', { class: 'src-desc', dir: 'auto' }, d.description); const long = d.description.length > 420; if (long) { p.classList.add('clamped'); p.addEventListener('click', () => p.classList.toggle('clamped')); } body.append(p); }
    if (d.tags.length) body.append(h('div', { class: 'folder-chips src-tags' }, ...d.tags.slice(0, 30).map((tg) => h('button', { type: 'button', class: 'chip tag', onclick: () => navigate(path(src.id, { tags: [tg.id] })) }, icon('tag'), h('span', { dir: 'auto' }, tg.label)))));
    if (d.meta?.length) body.append(h('dl', { class: 'src-meta' }, ...d.meta.flatMap((m) => [h('dt', null, m.label), h('dd', { dir: 'auto' }, m.value)])));
    if (d.chapters?.length) body.append(chaptersList(d, id, () => gone));
  })();
  return root;
}

/** archive.org and the like: a button per file, the fetched one going into the library. */
function fileActions(box: HTMLElement, src: Source, d: SourceDetails): void {
  if (!d.files.length) { box.append(h('p', { class: 'hint' }, d.badge === 'borrow only' ? t('borrowOnly') : t('noFilesOffered'))); return; }
  const list = h('div', { class: 'src-files' });
  for (const f of d.files) {
    const btn = h('button', { type: 'button', class: 'btn tonal src-file' }, icon('download'), h('span', { class: 'grow' }, f.label), f.size ? h('small', null, fmtMB(f.size)) : null) as HTMLButtonElement;
    btn.addEventListener('click', async () => {
      btn.disabled = true; const label = f.label;
      try {
        const file = await src.fetchFile!(d, f, (p) => { btn.replaceChildren(icon('download'), h('span', { class: 'grow' }, p.total ? `${p.pct}% · ${fmtMB(p.got)} / ${fmtMB(p.total)}` : p.got ? fmtMB(p.got) : `${label}…`)); });
        const added = await importFiles([file]);
        if (!added.length) throw new Error(t('convertFailed'));
        toast(t('addedToLibrary'));
        btn.replaceWith(h('button', { type: 'button', class: 'btn primary src-file', onclick: () => navigate(`/read/${added[0].id}`) }, icon('play'), h('span', { class: 'grow' }, `${label} · ${t('open')}`)));
      } catch (e) { btn.disabled = false; btn.replaceChildren(icon('download'), h('span', { class: 'grow' }, label)); if (f.size) btn.append(h('small', null, fmtMB(f.size))); toast(describe(e), 'error'); }
    });
    list.append(btn);
  }
  box.append(list);
}

/** Shamela: read from the site, keep in the library, fetch whole for offline — and search inside the book. */
async function shamelaActions(box: HTMLElement, d: SourceDetails, id: string, gone: () => boolean): Promise<void> {
  const [bookId, pageId] = id.split('#');
  const info = await readInfo(bookId);
  let book = (await db.allBooks()).find((b) => b.format === 'shamela' && b.remote?.id === bookId) ?? null;
  const draw = async () => {
    if (gone()) return;
    box.replaceChildren();
    const open = async (anchorPage?: number) => {
      if (!book) { book = await addToLibrary(info!); }
      if (anchorPage) setJump({ bookId: book.id, kind: 'anchor', id: `${book.id}-p${anchorPage}` });
      navigate(`/read/${book.id}`);
    };
    const row = h('div', { class: 'src-files' });
    row.append(h('button', { type: 'button', class: 'btn primary src-file', onclick: () => void open(pageId ? Number(pageId) : undefined).catch((e) => toast(describe(e), 'error')) }, icon('play'), h('span', { class: 'grow' }, pageId ? t('readAtPage', { n: localDigits(pageId) }) : book ? t('open') : t('readOnline'))));
    if (!book) row.append(h('button', { type: 'button', class: 'btn tonal src-file', onclick: async () => { try { book = await addToLibrary(info!); toast(t('addedToLibrary')); void draw(); } catch (e) { toast(describe(e), 'error'); } } }, icon('plus'), h('span', { class: 'grow' }, t('addToLibrary'))));
    const file = book ? await readBookFile(book.id) : null;
    const have = file?.content ? Object.keys(file.content).length : 0;
    const offline = book && !book.remote?.online;
    const dl = downloads.get(bookId);
    if (offline) row.append(h('span', { class: 'hint src-offline' }, icon('check'), ` ${t('offlineReady')}`));
    else {
      const bar = h('span'); const track = h('div', { class: 'progress-bar' }, bar); const label = h('span', { class: 'grow' }, dl ? t('fetchingPages', { n: localDigits(dl.done), total: localDigits(dl.total) }) : have ? t('fetchOfflineRest', { n: localDigits(have), total: localDigits(info!.pages) }) : t('fetchOffline', { n: localDigits(info!.pages) }));
      const btn = h('button', { type: 'button', class: 'btn tonal src-file' }, icon(dl ? 'stop' : 'download'), label) as HTMLButtonElement;
      if (dl) { bar.style.width = `${(dl.done / dl.total) * 100}%`; }
      btn.addEventListener('click', async () => {
        const running = downloads.get(bookId);
        if (running) { running.live = false; btn.disabled = true; return; }
        try {
          if (!book) book = await addToLibrary(info!);
          const state = { done: have, total: info!.pages, live: true }; downloads.set(bookId, state);
          btn.replaceChildren(icon('stop'), label); track.hidden = false;
          const ok = await downloadBook(book, (done, total) => { state.done = done; state.total = total; if (!gone()) { bar.style.width = `${(done / total) * 100}%`; label.textContent = t('fetchingPages', { n: localDigits(done), total: localDigits(total) }); } }, () => state.live);
          downloads.delete(bookId);
          toast(ok ? t('offlineDone') : t('offlineStopped'));
        } catch (e) { downloads.delete(bookId); toast(describe(e), 'error'); }
        book = (await db.allBooks()).find((b) => b.format === 'shamela' && b.remote?.id === bookId) ?? book;
        void draw();
      });
      row.append(btn, track);
    }
    box.append(row);
    if (book) box.append(h('p', { class: 'hint' }, t('shamelaInLibrary')));
    // Searching inside the book, through وصلة الشاملة.
    const sbox = h('div', { class: 'src-book-search' });
    const input = h('input', { type: 'search', placeholder: t('searchInThisBook'), dir: 'auto' }) as HTMLInputElement;
    const results = h('div', { class: 'src-hits' });
    const run = async () => {
      const q = input.value.trim(); if (!q) return;
      if (!link.isConnected()) { results.replaceChildren(signInNote()); return; }
      results.replaceChildren(h('div', { class: 'hint' }, t('searching')));
      try {
        const r = await link.searchPages(q, { scope: { book_ids: [Number(bookId)] }, limit: 30 });
        results.replaceChildren(h('div', { class: 'hint' }, t('resultsCount', { n: r.total_hits })));
        for (const hit of r.results) {
          const snip = h('span', { class: 'ctx', dir: 'auto' }); snip.innerHTML = (hit.snippet_body || hit.snippet_foot || '').replace(/<(?!\/?mark>)[^>]*>/g, '');
          results.append(h('button', { type: 'button', class: 'src-hit', onclick: () => void open(hit.page_id).catch((e) => toast(describe(e), 'error')) }, h('b', null, hit.printed_page ? `ص ${hit.printed_page}` : `#${hit.page_id}`), snip));
        }
      } catch (e) { results.replaceChildren(h('div', { class: 'hint' }, describe(e))); }
    };
    sbox.append(h('form', { class: 'src-search-row', onsubmit: (e: Event) => { e.preventDefault(); void run(); } }, input, h('button', { type: 'submit', class: 'icon-btn', 'aria-label': t('search') }, icon('search'))), results);
    box.append(sbox);
  };
  await draw();

  async function readInfo(bid: string) { const { bookInfo } = await import('../sources/shamela'); return bookInfo(Number(bid)); }
}

/** The contents of a Shamela book: branches the site folded open on request; a chapter opens the book there. */
function chaptersList(d: SourceDetails, id: string, gone: () => boolean): HTMLElement {
  const [bookId] = id.split('#');
  const list = h('ul', { class: 'plain-list src-chapters' });
  const box = h('section', { class: 'src-chapters-box' }, h('h3', { class: 'section-title' }, t('contents')), list);
  const openAt = async (page?: number) => {
    const { bookInfo } = await import('../sources/shamela');
    let book = (await db.allBooks()).find((b) => b.format === 'shamela' && b.remote?.id === bookId);
    if (!book) book = await addToLibrary(await bookInfo(Number(bookId)));
    if (page) setJump({ bookId: book.id, kind: 'anchor', id: `${book.id}-p${page}` });
    navigate(`/read/${book.id}`);
  };
  const row = (c: SourceChapter) => h('li', { style: { paddingInlineStart: `${c.level * 14}px` } },
    h('button', { type: 'button', onclick: () => void openAt(c.page).catch((e) => toast(describe(e), 'error')) }, h('span', { dir: 'auto' }, c.title), c.page ? h('span', { class: 'meta' }, localDigits(c.page)) : null));
  for (const c of d.chapters ?? []) list.append(row(c));
  // (Folded branches: fetched when the list is shown, so the contents are whole.)
  void (async () => {
    const { bookInfo } = await import('../sources/shamela');
    try {
      const info = await bookInfo(Number(bookId));
      if (!info.toc.some((e) => e.more) || gone()) return;
      const full = await expandToc(info.toc, () => !gone());
      if (gone()) return;
      list.replaceChildren(...full.map((e, i) => row({ id: String(i), title: e.title, level: e.level, page: e.page })));
    } catch { /* the folded contents stay */ }
  })();
  return box;
}

/* ---------- errors ---------- */
function describe(e: unknown): string {
  const err = e as SourceError;
  if (err instanceof SourceError) {
    if (err.kind === 'offline') return t('sourceOffline');
    if (err.kind === 'cloudflare') return t('sourceCloudflare');
    if (err.kind === 'rate') return t('sourceRate');
    if (err.kind === 'auth') return t('shamelaLinkNeeded');
    if (err.kind === 'cors') return t('sourceNeedsApp');
    if (err.kind === 'parse') return t('sourceParse');
  }
  return String((e as Error)?.message ?? e);
}
function showError(box: HTMLElement, e: unknown, retry: () => void, src: Source): void {
  const err = e as SourceError;
  const el = h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('globe')), h('p', null, describe(e)));
  if (err instanceof SourceError && err.kind === 'cloudflare') el.append(h('button', { type: 'button', class: 'btn primary', onclick: () => void passChallenge(src.site).then(retry) }, icon('globe'), t('passCheck')));
  else if (err instanceof SourceError && err.kind === 'auth') el.append(h('button', { type: 'button', class: 'btn primary', onclick: () => void link.connect().catch((x) => toast(describe(x), 'error')) }, icon('user'), t('signIn')));
  else el.append(h('button', { type: 'button', class: 'btn tonal', onclick: retry }, t('tryAgain')));
  box.replaceChildren(el);
}
export { describe as describeSourceError };
