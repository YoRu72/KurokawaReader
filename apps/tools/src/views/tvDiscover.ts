// The TV & Movies tab's «Discover» page: a hero of what is popular (each title's own wide picture and logo), continue
// watching (how much of an episode or a film is left, the next episode once it is out), the popular series and films
// ranked, the best rated, what came out this year, and the genres as picture tiles that open «Browse» on them.
import { h } from '../ui/dom';
import { t, localDigits, countMinutes } from '../i18n';
import { navigate } from '../router';
import * as cm from '../tv/cinemeta';
import type { TvMeta, TvKind } from '../tv/cinemeta';
import { watchingIds, nextUp } from '../tv/library';
import { hero, rail, poster, tile, continueCard, hueOf } from '../ui/discover';

const PREF_KEY = 'kt.tv.discover'; const ART_KEY = 'kt.tv.art';
const open = (m: { type: TvKind; id: string }) => () => navigate(`/tv/${m.type}/${m.id}`);
const kindName = (m: TvMeta) => (m.type === 'movie' ? t('tvFilm') : t('tvSeries'));
const overlayOf = (m: TvMeta) => [kindName(m), m.imdbRating ? `★ ${localDigits(m.imdbRating)}` : ''].filter(Boolean).join(' • ');
const yearOf = (m: TvMeta) => (m.releaseInfo ?? m.year ?? '').replace(/\d+/g, (d) => localDigits(d));
const card = (m: TvMeta, badge?: string, rank = false) => poster({ image: m.poster, title: m.name, sub: yearOf(m), badge, badgeKind: rank ? 'rank' : 'plain', overlay: overlayOf(m), onClick: open(m) });

export function tvDiscover(body: HTMLElement, o: { live: () => boolean; browse: (p: { type: TvKind; cat: cm.Catalog; genre: string }) => void }): void {
  const heroBox = h('div', { class: 'dc-hero-box' }, hero([]));
  const cont = rail(t('continueWatching'), 'history', { kind: 'cont', count: 3 }); cont.el.hidden = true;
  const year = String(new Date().getFullYear());
  const rows: { r: ReturnType<typeof rail>; type: TvKind; cat: cm.Catalog; genre?: string; rank?: boolean }[] = [
    { r: rail(t('tvPopularSeries'), 'tv', { seeAll: () => o.browse({ type: 'series', cat: 'top', genre: '' }) }), type: 'series', cat: 'top', rank: true },
    { r: rail(t('tvPopularFilms'), 'film', { seeAll: () => o.browse({ type: 'movie', cat: 'top', genre: '' }) }), type: 'movie', cat: 'top', rank: true },
    { r: rail(t('tvNewSeries', { y: localDigits(year) }), 'calendar', { seeAll: () => o.browse({ type: 'series', cat: 'year', genre: year }) }), type: 'series', cat: 'year', genre: year },
    { r: rail(t('tvNewFilms', { y: localDigits(year) }), 'calendar', { seeAll: () => o.browse({ type: 'movie', cat: 'year', genre: year }) }), type: 'movie', cat: 'year', genre: year },
    { r: rail(t('tvTopSeries'), 'star', { seeAll: () => o.browse({ type: 'series', cat: 'imdbRating', genre: '' }) }), type: 'series', cat: 'imdbRating' },
    { r: rail(t('tvTopFilms'), 'star', { seeAll: () => o.browse({ type: 'movie', cat: 'imdbRating', genre: '' }) }), type: 'movie', cat: 'imdbRating' },
  ];
  const genres = rail(t('dcGenres'), 'grid', { kind: 'tile' });
  const anim = rail(t('tvAnimation'), 'playCircle', { seeAll: () => o.browse({ type: 'movie', cat: 'top', genre: 'Animation' }) });
  body.append(heroBox, cont.el, rows[0].r.el, rows[1].r.el, genres.el, rows[2].r.el, rows[3].r.el, anim.el, rows[4].r.el, rows[5].r.el);
  body.classList.add('dc-page');

  // ---- the hero: the popular series and films that have a wide picture, side by side
  void Promise.all([cm.catalog('series', 'top'), cm.catalog('movie', 'top')]).then(([s, m]) => {
    if (!o.live()) return; const mix: TvMeta[] = []; for (let i = 0; i < 6; i++) { if (s.metas[i]) mix.push(s.metas[i]); if (m.metas[i]) mix.push(m.metas[i]); }
    heroBox.replaceChildren(hero(mix.filter((x) => x.background).slice(0, 8).map((x) => ({ image: x.background, logo: x.logo, title: x.name, onClick: open(x),
      facts: [kindName(x), ...x.genres.slice(0, 2), x.runtime ?? '', yearOf(x)].filter(Boolean),
      chips: [x.imdbRating ? `IMDb ${localDigits(x.imdbRating)}` : ''].filter(Boolean), text: x.description?.slice(0, 260) }))));
  }).catch(() => { if (o.live()) heroBox.replaceChildren(); });
  for (const row of rows) void cm.catalog(row.type, row.cat, row.genre).then((r) => { if (o.live()) row.r.fill(r.metas.slice(0, 24).map((m, i) => card(m, row.rank ? `#${localDigits(i + 1)}` : undefined, row.rank && i < 3))); }).catch((e) => { if (o.live()) row.r.fail(String((e as Error)?.message ?? e)); });
  void cm.catalog('movie', 'top', 'Animation').then((r) => { if (o.live()) anim.fill(r.metas.slice(0, 24).map((m) => card(m))); }).catch(() => { anim.el.hidden = true; });

  // ---- continue watching: what the player left half-way, then the next episode of the series being watched
  void (async () => {
    const { history } = await import('../player/prefs'); const cards: HTMLElement[] = []; const had = new Set<string>();
    for (const m of history().filter((x) => x.imdbId && !x.watched && x.duration > 0 && x.pos > 60 && x.duration - x.pos > 60).slice(0, 10)) {
      if (had.has(m.imdbId!)) continue; had.add(m.imdbId!);
      const type: TvKind = m.season !== undefined ? 'series' : 'movie';
      cards.push(continueCard({ image: m.cover, title: m.show ?? '', line: m.season !== undefined && m.episode !== undefined ? `S${localDigits(m.season)} E${localDigits(m.episode)}` : undefined, chip: t('timeLeft', { t: countMinutes(Math.max(1, Math.round((m.duration - m.pos) / 60))) }), progress: m.pos / m.duration, onClick: () => navigate(`/tv/${type}/${m.imdbId}`) }));
    }
    if (cards.length && o.live()) cont.fill(cards);
    for (const id of watchingIds().slice(0, 12)) {
      if (had.has(id)) continue;
      try { const m = await cm.meta('series', id); if (!o.live()) return; const v = nextUp(m); if (!v) continue; cards.push(continueCard({ image: v.thumbnail ?? m.background ?? m.poster, title: m.name, line: `S${localDigits(v.season)} E${localDigits(v.episode)}${v.name ? ` · ${v.name}` : ''}`, chip: t('dcNextUp'), onClick: () => navigate(`/tv/series/${id}?s=${v.season}`) })); cont.fill(cards); } catch { /* the next */ }
    }
  })();

  // ---- genres: each tile with the wide picture of its most popular film, found as the tile comes into view (kept three days)
  let art: { at: number; v: Record<string, string> } = { at: 0, v: {} }; try { art = JSON.parse(localStorage.getItem(ART_KEY) ?? 'null') ?? art; } catch { /* first time */ }
  if (Date.now() - art.at > 3 * 86400e3) art = { at: Date.now(), v: {} };
  const tiles = cm.GENRES.movie.map((g) => { const el = tile({ image: art.v[g], label: tvGenreName(g), sub: tvGenreName(g) !== g ? g : undefined, color: hueOf(g), onClick: () => o.browse({ type: browseType(), cat: 'top', genre: g }) }); el.dataset.genre = g; return el; });
  genres.fill(tiles);
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { for (const e of es) { if (!e.isIntersecting) continue; const el = e.target as HTMLElement; io!.unobserve(el); const g = el.dataset.genre!; if (art.v[g]) continue;
    void cm.catalog('movie', 'top', g).then((r) => { const pic = r.metas.find((m) => m.background)?.background; if (!pic || !o.live()) return; art.v[g] = pic; try { localStorage.setItem(ART_KEY, JSON.stringify(art)); } catch { /* full */ } el.prepend(h('img', { class: 'dc-tile-img', src: pic, alt: '', loading: 'lazy' })); }).catch(() => undefined); } }, { rootMargin: '200px' }) : null;
  if (io) tiles.forEach((el) => io.observe(el));
}
const browseType = (): TvKind => { try { return (JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as { type?: TvKind }).type ?? 'series'; } catch { return 'series'; } };
/** A genre's name in the app's language (Cinemeta's own names otherwise). */
export function tvGenreName(g: string): string { const k = `tvGenre_${g.replace(/[^a-zA-Z]/g, '')}`; const v = t(k as 'tvFilm'); return v && v !== k ? v : g; }
