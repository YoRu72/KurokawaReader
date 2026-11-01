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
      const run = async () => { const s = input.value.trim(); const mine = ++runs; if (!s) { results.replaceChildren(); return; } results.replaceChildren(spinner()); try { const r = await cm.search(s); if (my !== token || mine !== runs) return; results.replaceChildren(r.length ? grid(r) : h('p', { class: 'empty small' }, t('noResults'))); } catch (e) { if (mine === runs) results.replaceChildren(fail(e)); } };
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
