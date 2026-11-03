// The TV & Movies tab (the add-on of that name): Discover — Cinemeta's popular, new and best-rated films and
// series, by genre —, Search, the Watchlist, and «Continue watching» (the next episode of what you are in). Each
// card leads to the title's page, where episodes and films are watched now or downloaded from Torrentio.
import { h, icon, iconButton, debounce } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { navigate } from '../router';
import * as cm from '../tv/cinemeta';
import type { TvMeta, TvKind, Catalog } from '../tv/cinemeta';
import { watchlist, watchingIds, nextUp } from '../tv/library';

export type TvTab = 'discover' | 'search' | 'watchlist';
const TAB_KEY = 'kt.tv.tab'; const PREF_KEY = 'kt.tv.discover';
export function tvCard(m: { id: string; type: TvKind; name: string; poster?: string; year?: string; releaseInfo?: string; imdbRating?: string }, extra?: HTMLElement | null): HTMLElement {
  const facts = [m.type === 'movie' ? t('tvFilm') : t('tvSeries'), m.releaseInfo ?? m.year ?? '', m.imdbRating ? `★ ${localDigits(m.imdbRating)}` : ''].filter(Boolean).join(' · ');
  return h('button', { type: 'button', class: 'anime-card tv-card', onclick: () => navigate(`/tv/${m.type}/${m.id}`) },
    h('span', { class: 'anime-cover' }, m.poster ? h('img', { src: m.poster, alt: '', loading: 'lazy', onerror: (e: Event) => { (e.target as HTMLElement).replaceWith(icon('film')); } }) : icon('film')),
    h('span', { class: 'anime-text' }, h('span', { class: 'anime-title', dir: 'auto' }, m.name), h('span', { class: 'anime-facts' }, facts), extra ?? null));
}
export function tvView(tab?: TvTab, q?: string): HTMLElement & { dispose?: () => void } {
  let current: TvTab = tab ?? ((localStorage.getItem(TAB_KEY) as TvTab | null) ?? 'discover');
  const body = h('div', { class: 'body anime-body tv-body' }); const chips = h('div', { class: 'chips filter-chips' });
  const root = h('div', { class: 'view tv-view' }, h('header', { class: 'topbar' }, h('div', { class: 'title' }, h('span', null, t('navTv'))), h('div', { class: 'topbar-actions' }, iconButton('settings', t('settings'), () => navigate('/settings/tv')))), chips, body) as HTMLElement & { dispose?: () => void };
  let token = 0;
  const TABS: [TvTab, string, string][] = [['discover', t('tvDiscover'), 'star'], ['search', t('navSearch'), 'search'], ['watchlist', t('tvWatchlist'), 'bookmark']];
  const spinner = () => h('div', { class: 'center' }, h('div', { class: 'spinner' }));
  const fail = (e: unknown) => h('p', { class: 'empty small' }, String((e as Error)?.message ?? e));
  const grid = (ms: { id: string; type: TvKind; name: string; poster?: string; year?: string; releaseInfo?: string; imdbRating?: string }[]) => h('div', { class: 'anime-grid' }, ...ms.map((m) => tvCard(m)));
  const drawChips = () => chips.replaceChildren(...TABS.map(([k, label, ic]) => h('button', { type: 'button', class: 'chip' + (current === k ? ' on' : ''), onclick: () => { current = k; try { localStorage.setItem(TAB_KEY, k); } catch { /* none */ } navigate(`/tv?tab=${k}`, true); draw(); } }, icon(ic), label)));
  /** «Continue watching»: the series you are in whose next episode is out. */
  const continueRow = async (out: HTMLElement, my: number) => {
    const ids = watchingIds().slice(0, 12); if (!ids.length) return;
    const items: HTMLElement[] = [];
    for (const id of ids) { try { const m = await cm.meta('series', id); const v = nextUp(m); if (v) items.push(h('button', { type: 'button', class: 'cont-card', onclick: () => navigate(`/tv/series/${id}?s=${v.season}`) }, m.poster ? h('img', { src: m.poster, alt: '', loading: 'lazy' }) : h('span', { class: 'sched-noimg' }), h('span', { class: 'grow' }, h('span', { class: 'anime-title', dir: 'auto' }, m.name), h('small', { class: 'src' }, `S${localDigits(v.season)} · E${localDigits(v.episode)}${v.name ? ` · ${v.name}` : ''}`)), icon('play'))); } catch { /* skip */ } }
    if (my !== token || !items.length) return;
    out.prepend(h('h3', { class: 'lib-h' }, t('continueWatching')), h('div', { class: 'cont-row' }, ...items));
  };
  const draw = () => {
    drawChips(); const my = ++token; body.replaceChildren();
    if (current === 'search') {
      const input = h('input', { type: 'search', class: 'search-input', placeholder: t('tvSearchHint'), value: q ?? '', enterkeyhint: 'search' }) as HTMLInputElement; const results = h('div');
      let runs = 0;
      // (Tags and filters over the results: films or series, genres — a tap keeps only those with it —, a lowest rating,
      // and the order; the genres and ratings filled in from each title's page as they come.)
      type SF = { type: '' | TvKind; genres: string[]; min: number; sort: 'match' | 'rating' | 'new' | 'old' | 'title' };
      let sf: SF = { type: '', genres: [], min: 0, sort: 'match' };
      try { sf = { ...sf, ...(JSON.parse(localStorage.getItem('kt.tv.sf') ?? '{}') as Partial<SF>), genres: [] }; } catch { /* first time */ }
      const saveSf = () => { try { localStorage.setItem('kt.tv.sf', JSON.stringify({ ...sf, genres: [] })); } catch { /* full */ } };
      let found: TvMeta[] = []; let note = '';
      const bar = h('div', { class: 'tv-filters' }); const gridBox = h('div');
      const yearOf = (m: TvMeta) => Number((m.releaseInfo ?? m.year ?? '').slice(0, 4)) || 0;
      const shown = () => {
        let r = found.filter((m) => (!sf.type || m.type === sf.type) && (!sf.min || Number(m.imdbRating ?? 0) >= sf.min) && sf.genres.every((g) => m.genres.includes(g)));
        const by: Record<SF['sort'], ((a: TvMeta, b: TvMeta) => number) | null> = { match: null, rating: (a, b) => Number(b.imdbRating ?? 0) - Number(a.imdbRating ?? 0), new: (a, b) => yearOf(b) - yearOf(a), old: (a, b) => (yearOf(a) || 9999) - (yearOf(b) || 9999), title: (a, b) => a.name.localeCompare(b.name) };
        const f = by[sf.sort]; if (f) r = [...r].sort(f); return r;
      };
      const chip = (on: boolean, label: string, fn: () => void) => h('button', { type: 'button', class: 'chip small' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: () => { fn(); saveSf(); drawBar(); drawGrid(); } }, label);
      const drawBar = () => {
        if (!found.length) { bar.replaceChildren(); return; }
        const counts = new Map<string, number>(); for (const m of found) for (const g of m.genres) counts.set(g, (counts.get(g) ?? 0) + 1);
        const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
        bar.replaceChildren(
          ...(note ? [h('p', { class: 'hint small' }, note)] : []),
          h('div', { class: 'chip-row wrap' }, chip(!sf.type, t('tvAll'), () => { sf.type = ''; }), chip(sf.type === 'series', t('tvSeriesPl'), () => { sf.type = 'series'; }), chip(sf.type === 'movie', t('tvFilmsPl'), () => { sf.type = 'movie'; }),
            h('span', { class: 'chip-sep' }), ...([0, 6, 7, 8] as const).map((n) => chip(sf.min === n, n ? `★ ${localDigits(n)}+` : t('tvAnyRating'), () => { sf.min = n; }))),
          h('div', { class: 'chip-row wrap' }, ...([['match', t('tvRelevance')], ['rating', t('tvSortRating')], ['new', t('sortNewest')], ['old', t('tvSortOldest')], ['title', t('sortTitle')]] as const).map(([k, l]) => chip(sf.sort === k, l, () => { sf.sort = k; }))),
          ...(tags.length ? [h('div', { class: 'chip-row wrap tv-genres' }, ...tags.slice(0, 18).map((g) => chip(sf.genres.includes(g), g, () => { sf.genres = sf.genres.includes(g) ? sf.genres.filter((x) => x !== g) : [...sf.genres, g]; })))] : []));
      };
      const drawGrid = () => { const r = shown(); gridBox.replaceChildren(r.length ? grid(r) : h('p', { class: 'empty small' }, found.length ? t('tvNoMatchFilters') : t('noResults'))); };
      const run = async () => {
        const s = input.value.trim(); const mine = ++runs; if (!s) { found = []; note = ''; drawBar(); gridBox.replaceChildren(); return; }
        gridBox.replaceChildren(spinner()); bar.replaceChildren();
        try {
          const r = await cm.searchSmart(s); if (my !== token || mine !== runs) return;
          // (An IMDb link or id pasted: its page at once.)
          if (r.imdb && r.metas.length === 1) { navigate(`/tv/${r.metas[0].type}/${r.metas[0].id}`); return; }
          found = r.metas; note = r.used.toLowerCase() !== s.toLowerCase() && found.length ? t('searchShowingFor', { q: r.used + (r.year ? ` (${localDigits(r.year)})` : '') }) : '';
          drawBar(); drawGrid();
          let pending = 0; void cm.fillIn(found, () => { if (mine !== runs || my !== token) return; if (pending++ % 6 === 5 || pending >= Math.min(found.length, 40)) { drawBar(); drawGrid(); } }).then(() => { if (mine === runs && my === token) { drawBar(); drawGrid(); } });
        } catch (e) { if (mine === runs) gridBox.replaceChildren(fail(e)); }
      };
      results.append(bar, gridBox);
      input.addEventListener('input', debounce(() => void run(), 400));
      body.append(h('form', { class: 'search-form', onsubmit: (e: Event) => { e.preventDefault(); void run(); } }, input), results);
      if (q) void run(); setTimeout(() => input.focus(), 50);
    } else if (current === 'watchlist') {
      const l = watchlist(); body.append(l.length ? grid(l) : h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('bookmark')), h('p', null, t('tvWatchlistEmpty'))));
      void continueRow(body, my);
    } else {
      let p: { type: TvKind; cat: Catalog; genre: string } = { type: 'series', cat: 'top', genre: '' };
      try { p = { ...p, ...(JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Partial<typeof p>) }; } catch { /* first time */ }
      const head = h('div', { class: 'chip-row wrap tv-head' }); const genres = h('div', { class: 'chip-row tv-genres' }); const list = h('div'); const more = h('button', { type: 'button', class: 'btn tonal small anime-more', hidden: true }, t('loadMore')) as HTMLButtonElement;
      let skip = 0; let all: TvMeta[] = [];
      const save = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* full */ } };
      const drawHead = () => {
        const c = (on: boolean, label: string, fn: () => void) => h('button', { type: 'button', class: 'chip small' + (on ? ' on' : ''), onclick: fn }, label);
        head.replaceChildren(c(p.type === 'series', t('tvSeriesPl'), () => { p.type = 'series'; p.genre = ''; save(); drawHead(); void load(); }), c(p.type === 'movie', t('tvFilmsPl'), () => { p.type = 'movie'; p.genre = ''; save(); drawHead(); void load(); }), h('span', { class: 'chip-sep' }),
          c(p.cat === 'top', t('sortPopular'), () => { p.cat = 'top'; p.genre = ''; save(); drawHead(); void load(); }), c(p.cat === 'year', t('sortNewest'), () => { p.cat = 'year'; p.genre = String(new Date().getFullYear()); save(); drawHead(); void load(); }), c(p.cat === 'imdbRating', t('sortScore'), () => { p.cat = 'imdbRating'; p.genre = ''; save(); drawHead(); void load(); }));
        const opts = p.cat === 'year' ? Array.from({ length: 30 }, (_, i) => String(new Date().getFullYear() - i)) : cm.GENRES[p.type];
        genres.replaceChildren(...(p.cat === 'year' ? [] : [c(!p.genre, t('allFiles'), () => { p.genre = ''; save(); drawHead(); void load(); })]), ...opts.map((g) => c(p.genre === g, p.cat === 'year' ? localDigits(g) : g, () => { p.genre = g; save(); drawHead(); void load(); })));
      };
      const load = async (next = false) => {
        if (!next) { skip = 0; all = []; list.replaceChildren(spinner()); } else more.disabled = true;
        try { const r = await cm.catalog(p.type, p.cat, p.genre || undefined, skip); if (my !== token) return; all = all.concat(r.metas); skip += r.metas.length; list.replaceChildren(all.length ? grid(all) : h('p', { class: 'empty small' }, t('noResults'))); more.hidden = !r.more; more.disabled = false; }
        catch (e) { list.replaceChildren(fail(e)); }
      };
      more.addEventListener('click', () => void load(true));
      const cont = h('div'); body.append(cont, head, genres, list, more); drawHead(); void load(); void continueRow(cont, my);
    }
  };
  draw();
  root.dispose = () => { token++; };
  return root;
}
