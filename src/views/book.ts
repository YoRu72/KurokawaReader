// A book's own page, shown before the reader: the cover, the title, what the file carries about it, the
// reader's stars and words, its AniList entry when tracking is on, and the contents — each chapter a tap away,
// the read ones marked, with «resume» to carry on where the reader left off.
import { h, icon, iconButton, toast, coverColors } from '../ui/dom';
import { volumesOf } from '../series';
import { t, formatBytes, formatDuration, localDigits, countChapters, getLang, formatLabel } from '../i18n';
import { db, FAV_TAG, chapterRead, type Book } from '../db';
import { coverUrl, forgetCover, shrinkCover } from '../library';
import { navigate, back } from '../router';
import { getSettings } from '../settings';
import { liveStatsOf } from '../stats';
import { setJump } from '../jump';
import { anilistOn, linked } from '../anilist';

/** Did the book come from a source other than archive.org or Shamela (an extension, a web folder)? */
const fromSource = (b: Book): boolean => !!b.remote?.source && b.remote.source !== 'archive' && b.remote.source !== 'shamela' && b.remote.source !== 'link';

const CHAPTERED = new Set(['epub', 'fb2', 'mobi', 'azw', 'azw3', 'kf8']);
/** Whether tapping this book opens its page first. */
export function wantsBookPage(book: Book): boolean {
  const s = getSettings().bookPage;
  return s === 'always' || (s === 'chaptered' && CHAPTERED.has(book.format));
}

type Outline = { description?: string; toc: { label: string; depth: number }[] };
const outlines = new Map<string, Outline>();
/** The book's blurb and contents, read from the file once. */
export async function outlineOf(book: Book): Promise<Outline> {
  let outline = outlines.get(book.id);
  if (outline) return outline;
  try {
    const file = await db.getFile(book.id);
    if (file && book.format === 'epub') { const { epubOutline } = await import('../formats/epub'); outline = await epubOutline(file, book.id); }
    else outline = { description: book.description, toc: [] };
  } catch { outline = { toc: [] }; }
  outlines.set(book.id, outline);
  return outline;
}
const blurs = new Map<string, string>();

/** The cover as a few dozen pixels, blown up: a soft wash behind the title that costs a phone nothing to draw. */
async function coverBlur(book: Book): Promise<string | null> {
  if (!book.cover) return null;
  const hit = blurs.get(book.id); if (hit) return hit;
  try {
    const bmp = await createImageBitmap(book.cover);
    const c = document.createElement('canvas'); c.width = 24; c.height = Math.max(1, Math.round((24 * bmp.height) / bmp.width));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    const url = c.toDataURL(); blurs.set(book.id, url);
    while (blurs.size > 20) blurs.delete(blurs.keys().next().value!);
    return url;
  } catch { return null; }
}

export function bookView(id: string): HTMLElement {
  const root = h('div', { class: 'view book-view' });
  const body = h('div', { class: 'book-body' });
  const top = h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/')), h('div', { class: 'title' }), h('span', { class: 'spacer' }));
  root.append(top, body);
  // The chapter list's own state, kept while the page is open.
  let reversed = false, hideRead = false, onlyStars = false, query = '';
  void (async () => {
    const book = await db.getBook(id);
    if (!book) { navigate('/', true); return; }
    if (book.format === 'series' && book.remote?.link) { navigate(book.remote.link, true); return; }
    top.querySelector('.title')!.textContent = book.title;
    render(book);
  })();

  const isRead = chapterRead;
  // Chapters picked (a hold, a right-click, Ctrl+click) for marking together.
  const picked = new Set<number>(); let picking = false;

  /** A picture of the reader's own for the cover, or the original back — the page drawn again either way. */
  function coverEdit(book: Book): import('../ui/coverview').CoverEdit {
    const after = (b: Book | undefined): string | null => { forgetCover(book.id); blurs.delete(book.id); if (b) { Object.assign(book, { cover: b.cover, coverOrig: b.coverOrig }); if (!('coverOrig' in b) || b.coverOrig === undefined) delete book.coverOrig; render(book); } return b ? coverUrl(b) : null; };
    return {
      custom: () => book.coverOrig !== undefined,
      set: async (picture) => { const small = await shrinkCover(picture); return after(await db.updateBook(book.id, (b) => { if (b.coverOrig === undefined) b.coverOrig = b.cover ?? null; b.cover = small; })) ?? ''; },
      restore: async () => after(await db.updateBook(book.id, (b) => { b.cover = b.coverOrig ?? undefined; delete b.coverOrig; })),
    };
  }

  function render(book: Book): void {
    const url = coverUrl(book); const [c1, c2] = coverColors(book.title);
    const stats = liveStatsOf(book.id) ?? book.stats;
    const isFav = (book.tags ?? []).includes(FAV_TAG);
    const pct = Math.round((book.progress?.pct ?? 0) * 100);
    const done = book.done ?? pct >= 98;
    const status = done ? t('statusFinished') : book.progress ? t('statusReading') : t('statusNew');

    // The cover, tapped: on its own, full screen (Mihon's cover view) — with a picture of one's own to put in its
    // place; a book with none goes straight to choosing one.
    const coverEl = url ? h('img', { class: 'book-hero-cover cover-tap', src: url, alt: '', title: t('coverTitle') }) : h('button', { type: 'button', class: 'book-hero-cover gen cover-tap', title: t('editCover'), style: { background: `linear-gradient(135deg, ${c1}, ${c2})` } }, h('span', { dir: 'auto' }, book.title));
    coverEl.addEventListener('click', () => void import('../ui/coverview').then((m) => {
      const edit = coverEdit(book);
      // (The library keeps a cover made small; the one in the book's file, at its own size, is what is looked at —
      // unless a picture of one's own is in its place.)
      const full = book.coverOrig === undefined && /^(epub|cbz|mobi|fb2|docx|odt)$/.test(book.format) ? async () => { const f = await db.getFile(book.id); if (!f) return null; const { readMeta } = await import('../formats'); const meta = await readMeta(f, book.fileName, book.format); return meta.cover && meta.cover.size > (book.cover?.size ?? 0) ? meta.cover : null; } : undefined;
      if (url) m.showCover({ url, title: book.title, bytes: async () => (await db.getBook(book.id))?.cover ?? book.cover!, full, edit });
      else m.editCoverSheet(edit, () => {});
    }));
    const bg = h('div', { class: 'book-hero-bg', style: url ? {} : { background: `linear-gradient(135deg, ${c1}, ${c2})` } });
    if (url) void coverBlur(book).then((b) => { if (b) bg.style.backgroundImage = `url("${b}")`; else bg.style.background = `linear-gradient(135deg, ${c1}, ${c2})`; });
    const hero = h('div', { class: 'book-hero' }, bg,
      h('div', { class: 'book-hero-row' },
        coverEl,
        h('div', { class: 'book-hero-text' },
          h('h1', { dir: 'auto' }, book.title),
          book.author ? h('p', { dir: 'auto' }, icon('user'), h('span', null, book.author)) : null,
          h('p', null, icon('clock'), h('span', null, `${status}${pct > 0 && !done ? ' · ' + (getLang() === 'ar' ? `٪${localDigits(String(pct))}` : `${pct}%`) : ''}`)),
          h('p', null, icon('file'), h('span', { dir: 'auto' }, `${formatLabel(book.format)} · ${formatBytes(book.size)}${book.pageCount ? ' · ' + (book.format === 'webnovel' ? countChapters(book.pageCount) : localDigits(String(book.pageCount)) + ' ' + t('pages').toLowerCase()) : ''}`)))));

    const tile = (name: string, label: string, on: boolean, fn: () => void, more?: string) => h('button', { type: 'button', class: 'book-tile' + (on ? ' on' : '') + (more ? ' has-more' : ''), title: more, onclick: fn }, icon(name), h('span', null, label), more ? h('i', { class: 'tile-more', 'aria-hidden': 'true' }, icon('chevronDown')) : null);
    const others = (book.tags ?? []).filter((x) => x !== FAV_TAG);
    const favTile = tile(isFav ? 'heartFill' : 'heart', isFav ? t('inLibraryFav') : t('favorite'), isFav, async () => { const { toggleFavorite } = await import('./reader'); await toggleFavorite(book); render(book); }, t('holdForTags'));
    // Held, or right-clicked: the book's tags, not just the one heart.
    void import('../ui/tags').then((m) => m.onHoldOrContext(favTile, () => m.tagsSheetFor(book, () => render(book))));
    if (others.length) favTile.querySelector('span')!.textContent = `${isFav ? t('inLibraryFav') + ' · ' : ''}${others.slice(0, 2).join('، ')}${others.length > 2 ? '…' : ''}`;
    const tiles = h('div', { class: 'book-tiles' },
      favTile,
      tile('clock', stats?.ms ? formatDuration(stats.ms) : t('notStarted'), !!stats?.ms, async () => { const { showBookInfo } = await import('../ui/bookinfo'); showBookInfo({ book, stats: stats ?? { ms: 0, words: 0, days: {} }, speed: null, pages: book.pageCount, pct: book.progress?.pct ?? 0 }); }),
      // (Tracking is for titles that came from a source — an extension, a web folder — as Mihon tracks its
      // entries; a book of one's own files gets it once an AniList account is linked.)
      anilistOn() && (fromSource(book) || book.track || linked()) ? tile('globe', book.track ? t('tracked') : t('tracking'), !!book.track, async () => { if (!linked()) { toast(t('anilistLinkFirst')); navigate('/settings'); return; } const { trackSheet } = await import('../ui/track'); trackSheet(book, () => render(book)); }) : null,
      tile('star', book.rating ? '★'.repeat(book.rating) : t('reviewBook'), !!book.rating, async () => { const { reviewSheet } = await import('../ui/review'); reviewSheet(book, () => render(book)); }),
      tile('external', t('shareFile'), false, async () => { const { shareBooks } = await import('../library'); void shareBooks([book.id]); }));

    const facts = h('div', { class: 'book-facts' });
    if (book.track) {
      const m = book.track.media; const e = book.track.entry;
      facts.append(h('p', null, icon('globe'), h('a', { href: m.url, target: '_blank', rel: 'noopener', dir: 'auto' }, m.title), h('span', { class: 'src' }, `${m.score ? ` · ${localDigits(String(m.score))}/${localDigits('100')}` : ''}${m.year ? ` · ${localDigits(String(m.year))}` : ''}`)),
        h('p', { class: 'src' }, `${t(`al_${e.status}` as 'al_CURRENT')} · ${t('alProgress')}: ${localDigits(String(e.progress))}${m.chapters ? '/' + localDigits(String(m.chapters)) : ''}${e.score ? ' · ' + t('alScore') + ': ' + localDigits(String(e.score)) : ''}`));
    }
    if (book.review) facts.append(h('p', { class: 'review-quote', dir: 'auto' }, book.review));
    const descEl = h('div', { class: 'book-desc', hidden: true });
    const tagsEl = h('div', { class: 'book-tags' }, ...others.map((x) => h('span', { class: 'chip small' }, h('span', null, x))));
    const chaptersEl = h('div', { class: 'book-chapters' }, h('p', { class: 'src', style: { padding: '0 16px' } }, t('loading')));
    // The series this book belongs to (told from the titles), with its other volumes in the library.
    const seriesEl = h('div', { class: 'book-series', hidden: true });
    void db.allBooks().then((all) => {
      const v = volumesOf(book, all); if (!v) return;
      const i = v.books.findIndex((x) => x.book.id === book.id);
      seriesEl.hidden = false;
      seriesEl.replaceChildren(h('h3', null, h('span', { dir: 'auto' }, v.part.name), h('small', null, ` · ${t('volumeOf', { n: localDigits(String(v.books[i]?.index ?? 0)), total: localDigits(String(v.books.length)) })}`)),
        h('div', { class: 'series-row' }, ...v.books.map((x) => h('button', { type: 'button', class: 'chip small' + (x.book.id === book.id ? ' on' : ''), title: x.book.title, onclick: () => { if (x.book.id !== book.id) navigate(`/book/${x.book.id}`); } }, h('span', null, localDigits(String(x.index)))))),
        ...(i + 1 < v.books.length ? [h('button', { type: 'button', class: 'btn small tonal', onclick: () => navigate(`/book/${v.books[i + 1].book.id}`) }, icon('arrowRight'), t('nextVolume'))] : []));
    });
    const fabText = h('span', { class: 'fab-text' }, h('b', null, book.progress && !done ? t('resume') : done ? t('readAgain') : t('startReading')));
    const fab = h('button', { type: 'button', class: 'fab book-resume', onclick: () => navigate(`/read/${book.id}`) }, icon('play'), fabText);
    body.replaceChildren(hero, tiles, facts, descEl, tagsEl, seriesEl, chaptersEl, fab);

    void (async () => {
      const outline = await outlineOf(book);
      const desc = outline.description || book.description || book.track?.media.description;
      if (desc) {
        descEl.hidden = false; let open = false;
        const p = h('p', { dir: 'auto', class: 'clamp' }, desc);
        const more = h('button', { type: 'button', class: 'btn small text', 'aria-label': t('more'), onclick: () => { open = !open; p.classList.toggle('clamp', !open); more.replaceChildren(icon(open ? 'chevronUp' : 'chevronDown')); } }, icon('chevronDown'));
        descEl.replaceChildren(p, desc.length > 220 ? more : '');
      }
      const toc = outline.toc;
      if (!toc.length) { chaptersEl.replaceChildren(); return; }
      const at = book.progress?.toc ?? -1;
      if (at >= 0 && toc[at] && !done) fabText.append(h('small', { dir: 'auto' }, toc[at].label));
      paintChapters(book, toc, chaptersEl);
    })();
  }

  function paintChapters(book: Book, toc: Outline['toc'], host: HTMLElement): void {
    const at = book.progress?.toc ?? -1;
    const readCount = toc.filter((_, i) => isRead(book, i)).length;
    const search = h('input', { type: 'search', value: query, placeholder: t('searchChapters'), dir: 'auto', class: 'chapter-search', hidden: !query }) as HTMLInputElement;
    search.addEventListener('input', () => { query = search.value; paintList(); });
    const tools = h('div', { class: 'chapter-tools' },
      h('h3', null, countChapters(book.chapters ?? toc.length), readCount ? h('small', null, ` · ${t('readOf', { n: readCount })}`) : null),
      h('span', { class: 'spacer' }),
      iconButton('search', t('searchChapters'), () => { search.hidden = !search.hidden; if (!search.hidden) search.focus(); else { query = ''; search.value = ''; paintList(); } }),
      iconButton('filter', t('hideRead'), () => { hideRead = !hideRead; paintChapters(book, toc, host); }, { pressed: hideRead }),
      Object.keys(book.chapterStars ?? {}).length ? iconButton('bookmark', t('onlyBookmarked'), () => { onlyStars = !onlyStars; paintChapters(book, toc, host); }, { pressed: onlyStars }) : null,
      iconButton('sortAsc', t('reverseOrder'), () => { reversed = !reversed; paintChapters(book, toc, host); }, { pressed: reversed }));
    const list = h('ol', { class: 'chapter-list' });
    const open = (i: number) => { setJump({ bookId: book.id, kind: 'toc', id: String(i) }); navigate(`/read/${book.id}`); };
    // Marks: the chapters picked set read or unread, over and above where the reading stands.
    const mark = async (indices: number[], read: boolean) => {
      const marks = { ...(book.chapterMarks ?? {}) };
      for (const i of indices) marks[String(i)] = read ? 1 : 0;
      book.chapterMarks = marks; book.chapterMarksAt = Date.now();
      await db.updateBook(book.id, (b) => { b.chapterMarks = marks; b.chapterMarksAt = book.chapterMarksAt; });
      void import('../sync').then((m) => m.scheduleSync()).catch(() => undefined);
      picked.clear(); picking = false; paintChapters(book, toc, host);
    };
    // Bookmarks: the chapters picked bookmarked, or (all of them bookmarked already) no longer.
    const star = async (indices: number[]) => {
      const stars = { ...(book.chapterStars ?? {}) };
      const on = !indices.every((i) => stars[String(i)]);
      for (const i of indices) { if (on) stars[String(i)] = 1; else delete stars[String(i)]; }
      book.chapterStars = stars;
      await db.updateBook(book.id, (b) => { b.chapterStars = stars; });
      picked.clear(); picking = false; paintChapters(book, toc, host);
    };
    const pick = (i: number) => { if (picked.has(i)) picked.delete(i); else picked.add(i); if (!picked.size) picking = false; paintBar(); paintList(); };
    const startPick = (i: number) => { picking = true; picked.add(i); paintBar(); paintList(); };
    const bar = h('div', { class: 'chapter-pick', hidden: true });
    const paintBar = () => {
      bar.hidden = !picking;
      if (!picking) return;
      const all = toc.map((_, i) => i); const n = picked.size;
      const act = (name: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'sel-act', 'aria-label': label, title: label, onclick: fn }, icon(name), h('span', null, label));
      bar.replaceChildren(
        h('div', { class: 'sel-head' }, h('span', { class: 'sel-count' }, t('selectedCount', { n })),
          h('button', { class: 'btn small', type: 'button', onclick: () => { if (n === all.length) picked.clear(); else all.forEach((i) => picked.add(i)); paintBar(); paintList(); } }, n === all.length ? t('selectNone') : t('selectAll')),
          h('span', { class: 'spacer' }), iconButton('close', t('close'), () => { picked.clear(); picking = false; paintBar(); paintList(); })),
        h('div', { class: 'sel-actions' },
          act('check', t('markRead'), () => void mark([...picked], true)),
          act('undo', t('markUnread'), () => void mark([...picked], false)),
          act('chevronUp', t('markReadUpTo'), () => void mark(all.filter((i) => i <= Math.max(...picked)), true)),
          act('chevronDown', t('markUnreadFrom'), () => void mark(all.filter((i) => i >= Math.min(...picked)), false)),
          act('bookmark', [...picked].every((i) => book.chapterStars?.[String(i)]) ? t('removeBookmark') : t('bookmarkChapter'), () => void star([...picked])),
          n === 1 ? act('play', t('open'), () => open([...picked][0])) : null));
    };
    const paintList = () => {
      const q = query.trim().toLowerCase();
      const rows = toc.map((c, i) => ({ c, i })).filter(({ c, i }) => (!hideRead || !isRead(book, i)) && (!onlyStars || !!book.chapterStars?.[String(i)]) && (!q || c.label.toLowerCase().includes(q)));
      if (reversed) rows.reverse();
      list.replaceChildren(...rows.map(({ c, i }) => {
        // A tap opens the chapter; a hold, a right-click or Ctrl/⌘ + click picks it (and taps then pick more).
        const btn = h('button', { type: 'button', dir: 'auto', 'aria-pressed': picking ? String(picked.has(i)) : undefined, onclick: (e: MouseEvent) => { if (picking) pick(i); else if (e.ctrlKey || e.metaKey) startPick(i); else open(i); } }, h('i', { class: 'dot' }), h('span', null, c.label), book.chapterStars?.[String(i)] ? h('i', { class: 'star', title: t('bookmarkChapter') }, icon('bookmark')) : null, picking ? h('i', { class: 'tick' }, icon('check')) : null);
        void import('../ui/tags').then((m) => m.onHoldOrContext(btn, () => { if (!picking) startPick(i); else pick(i); }));
        return h('li', { class: (isRead(book, i) && i !== at ? 'read' : i === at ? 'current' : '') + ` d${Math.min(3, c.depth)}` + (picked.has(i) ? ' picked' : '') }, btn);
      }));
      if (!rows.length) list.append(h('li', { class: 'none' }, t('noResults')));
    };
    paintList(); paintBar();
    host.replaceChildren(tools, search, bar, list);
    if (at > 0 && !query) setTimeout(() => list.querySelector('.current')?.scrollIntoView({ block: 'center' }), 50);
  }
  return root;
}
