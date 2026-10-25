// A book's own page, shown before the reader: the cover, the title, what the file carries about it, the
// reader's stars and words, its AniList entry when tracking is on, and the contents — each chapter a tap away,
// the read ones marked — with «resume» to carry on where the reader left off.
import { h, icon, iconButton, toast, coverColors } from '../ui/dom';
import { t, formatBytes, formatDate, formatDuration, localDigits } from '../i18n';
import { db, FAV_TAG, type Book } from '../db';
import { coverUrl } from '../library';
import { navigate } from '../router';
import { getSettings } from '../settings';
import { liveStatsOf } from '../stats';
import { setJump } from './reader';
import { anilistOn, linked } from '../anilist';

const CHAPTERED = new Set(['epub', 'fb2', 'mobi', 'azw', 'azw3', 'kf8', 'docx']);
/** Whether tapping this book opens its page first. */
export function wantsBookPage(book: Book): boolean {
  const s = getSettings().bookPage;
  return s === 'always' || (s === 'chaptered' && CHAPTERED.has(book.format));
}

const outlines = new Map<string, { description?: string; toc: { label: string; depth: number }[] }>();

export function bookView(id: string): HTMLElement {
  const root = h('div', { class: 'view book-view' });
  const body = h('div', { class: 'book-body' });
  const top = h('header', { class: 'topbar' }, iconButton('back', t('back'), () => navigate('/')), h('div', { class: 'title' }), h('span', { class: 'spacer' }));
  root.append(top, body);
  void (async () => {
    const book = await db.getBook(id);
    if (!book) { navigate('/', true); return; }
    top.querySelector('.title')!.textContent = book.title;
    render(book);
  })();

  function render(book: Book): void {
    const url = coverUrl(book); const [c1, c2] = coverColors(book.title);
    const stats = liveStatsOf(book.id) ?? book.stats;
    const isFav = (book.tags ?? []).includes(FAV_TAG);
    const pct = Math.round((book.progress?.pct ?? 0) * 100);
    const done = book.done ?? pct >= 98;
    const status = done ? t('statusFinished') : book.progress ? t('statusReading') : t('statusNew');

    const hero = h('div', { class: 'book-hero' },
      h('div', { class: 'book-hero-bg', style: url ? { backgroundImage: `url("${url}")` } : { background: `linear-gradient(135deg, ${c1}, ${c2})` } }),
      h('div', { class: 'book-hero-row' },
        url ? h('img', { class: 'book-hero-cover', src: url, alt: '' }) : h('div', { class: 'book-hero-cover gen', style: { background: `linear-gradient(135deg, ${c1}, ${c2})` } }, h('span', { dir: 'auto' }, book.title)),
        h('div', { class: 'book-hero-text' },
          h('h1', { dir: 'auto' }, book.title),
          book.author ? h('p', { class: 'who', dir: 'auto' }, icon('type'), book.author) : null,
          h('p', { class: 'src' }, icon('clock'), `${status} · ${book.format.toUpperCase()} · ${formatBytes(book.size)}${book.pageCount ? ' · ' + localDigits(String(book.pageCount)) + ' ' + t('pages').toLowerCase() : ''}`))));

    const tile = (name: string, label: string, on: boolean, fn: () => void) => h('button', { type: 'button', class: 'book-tile' + (on ? ' on' : ''), onclick: fn }, icon(name), h('span', null, label));
    const tiles = h('div', { class: 'book-tiles' },
      tile(isFav ? 'heartFill' : 'heart', isFav ? t('inLibraryFav') : t('favorite'), isFav, async () => { const { toggleFavorite } = await import('./reader'); await toggleFavorite(book); render(book); }),
      tile('clock', stats?.ms ? formatDuration(stats.ms) : t('notStarted'), false, async () => { const { showBookInfo } = await import('../ui/bookinfo'); showBookInfo({ book, stats: stats ?? { ms: 0, words: 0, days: {} }, speed: null, pages: book.pageCount, pct: book.progress?.pct ?? 0 }); }),
      anilistOn() ? tile('cloud', book.track ? t('tracked') : t('tracking'), !!book.track, async () => { if (!linked()) { toast(t('anilistLinkFirst')); navigate('/settings'); return; } const { trackSheet } = await import('../ui/track'); trackSheet(book, () => render(book)); }) : null,
      tile('note', book.rating ? '★'.repeat(book.rating) : t('reviewBook'), !!book.rating, async () => { const { reviewSheet } = await import('../ui/review'); reviewSheet(book, () => render(book)); }));

    const facts = h('div', { class: 'book-facts' });
    if (book.track) {
      const m = book.track.media; const e = book.track.entry;
      facts.append(h('p', null, h('b', null, 'AniList: '), h('a', { href: m.url, target: '_blank', rel: 'noopener', dir: 'auto' }, m.title), m.score ? ` · ${localDigits(String(m.score))}/١٠٠`.replace('١٠٠', localDigits('100')) : '', m.year ? ` · ${localDigits(String(m.year))}` : ''),
        h('p', { class: 'src' }, `${t(`al_${e.status}` as 'al_CURRENT')} · ${t('alProgress')}: ${localDigits(String(e.progress))}${m.chapters ? '/' + localDigits(String(m.chapters)) : ''}${e.score ? ' · ' + t('alScore') + ': ' + localDigits(String(e.score)) : ''}`));
    }
    if (book.review) facts.append(h('p', { class: 'review-quote', dir: 'auto' }, book.review));
    const descEl = h('div', { class: 'book-desc', hidden: true });
    const tagsEl = h('div', { class: 'book-tags' }, ...(book.tags ?? []).filter((x) => x !== FAV_TAG).map((x) => h('span', { class: 'chip small' }, h('span', null, x))));
    const chaptersEl = h('div', { class: 'book-chapters' }, h('p', { class: 'src' }, t('loading')));
    const fab = h('button', { type: 'button', class: 'fab book-resume', onclick: () => navigate(`/read/${book.id}`) }, icon('play'), book.progress && !done ? t('resume') : done ? t('readAgain') : t('startReading'));
    body.replaceChildren(hero, tiles, facts, descEl, tagsEl, chaptersEl, fab);

    void (async () => {
      let outline = outlines.get(book.id);
      if (!outline) {
        try {
          const file = await db.getFile(book.id);
          if (file && book.format === 'epub') { const { epubOutline } = await import('../formats/epub'); outline = await epubOutline(file, book.id); }
          else outline = { description: book.description, toc: [] };
          outlines.set(book.id, outline);
        } catch { outline = { toc: [] }; }
      }
      const desc = outline.description || book.description || book.track?.media.description;
      if (desc) {
        descEl.hidden = false; let open = false;
        const p = h('p', { dir: 'auto', class: 'clamp' }, desc);
        const more = h('button', { type: 'button', class: 'btn small text', onclick: () => { open = !open; p.classList.toggle('clamp', !open); more.replaceChildren(icon(open ? 'chevronUp' : 'chevronDown')); } }, icon('chevronDown'));
        descEl.replaceChildren(p, desc.length > 220 ? more : '');
      }
      const toc = outline.toc;
      const at = book.progress?.toc ?? -1;
      if (!toc.length) { chaptersEl.replaceChildren(); return; }
      const list = h('ol', { class: 'chapter-list' }, ...toc.map((c, i) => h('li', { class: (i < at ? 'read' : i === at ? 'current' : '') + ` d${Math.min(3, c.depth)}` },
        h('button', { type: 'button', dir: 'auto', onclick: () => { setJump({ bookId: book.id, kind: 'toc', id: String(i) }); navigate(`/read/${book.id}`); } }, h('i', { class: 'dot' }), h('span', null, c.label)))));
      chaptersEl.replaceChildren(h('h3', null, t('chaptersCount', { n: localDigits(String(toc.length)) })), list);
      if (at > 0) setTimeout(() => list.querySelector('.current')?.scrollIntoView({ block: 'center' }), 50);
    })();
  }
  return root;
}
