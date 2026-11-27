// The Anime tab's «Discover» page: a hero of what is trending now; continue watching (how much of an episode is left,
// the next one when it is out, when it airs if it is not); what is trending today, ranked; what is airing — new
// episodes, new series, new seasons marked —; this season; the studios (each a page of its works); the genres, the
// seasons and the decades as picture tiles that open the search on them; the best rated; the popular films.
import { h } from '../ui/dom';
import { t, localDigits, countMinutes, countEpisodes } from '../i18n';
import { navigate } from '../router';
import { getSettings } from '../settings';
import * as al from '../anilist';
import type { Anime } from '../anilist';
import { hero, rail, poster, tile, continueCard, hueOf } from '../ui/discover';
import { titleOf, fmtFormat, fmtUntil, seasonName, presetSearch, type AnimeTab } from './anime';
import { coverOf, coverFor, customCover, coversReady } from '../anime/covers';
import { cached, keep } from '../anime/listCache';
import { notice } from './animeNet';

const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Romance', 'Slice of Life', 'Sci-Fi', 'Mystery', 'Horror', 'Psychological', 'Thriller', 'Sports', 'Supernatural', 'Mecha', 'Music', 'Mahou Shoujo', 'Ecchi'];
const DECADES = [2020, 2010, 2000, 1990, 1980, 1970, 1960];
const score10 = (a: Anime) => (a.score ? `★ ${localDigits((a.score / 10).toFixed(1))}` : '');
const overlayOf = (a: Anime) => [a.format ? fmtFormat(a.format) : '', score10(a)].filter(Boolean).join(' • ');
const yearsOf = (a: Anime) => { const s = a.startDate?.year ?? a.seasonYear; if (!s) return ''; const e = a.endDate?.year; return a.status === 'RELEASING' ? `${localDigits(s)}–` : e && e !== s ? `${localDigits(s)}–${localDigits(e)}` : localDigits(s); };
const open = (a: { id: number }) => () => navigate(`/anime/${a.id}`);
export const studioPath = (id: number, name?: string): string => `/anime/studio/${id}${name ? `?name=${encodeURIComponent(name)}` : ''}`;

/** The badge of a show that is airing: a new episode out these two days, a new series or season starting, else none. */
function airingBadge(a: Anime & { sequel?: boolean }): { text: string; kind: 'new' | 'live' | 'soon' } | null {
  const n = a.nextAiring; if (!n) return null; const now = Date.now() / 1000;
  if (n.episode > 1 && n.airingAt - 7 * 86400 > now - 2 * 86400) return { text: t('dcNewEpisode'), kind: 'new' };
  if (n.episode <= 3) return { text: a.sequel ? t('dcNewSeason') : t('dcNewSeries'), kind: 'live' };
  return null;
}

/** A row's items made into cards: one that cannot be made (an odd show) is left out, the row stays. */
const each = <X, Y>(xs: X[], f: (x: X, i: number) => Y): Y[] => xs.flatMap((x, i) => { try { return [f(x, i)]; } catch { return []; } });

export function animeDiscover(body: HTMLElement, o: { live: () => boolean; signal: AbortSignal; retry: () => void; goTab: (tab: AnimeTab) => void }): void {
  const adult = getSettings().animeAdult;
  const heroBox = h('div', { class: 'dc-hero-box' }, hero([]));
  const cont = rail(t('continueWatching'), 'history', { kind: 'cont', count: 3 }); cont.el.hidden = true;
  const trending = rail(t('dcTrendingToday'), 'flash');
  const airing = rail(t('dcAiringNow'), 'tv', { seeAll: () => o.goTab('schedule') });
  const season = rail(`${seasonName(al.seasonOf().season)} ${localDigits(al.seasonOf().year)}`, 'calendar', { seeAll: () => o.goTab('season') });
  const studios = rail(t('dcStudios'), 'apps', { kind: 'square', seeAll: () => { presetSearch({}); o.goTab('search'); } });
  const genres = rail(t('dcGenres'), 'grid', { kind: 'tile' });
  const seasons = rail(t('dcSeasons'), 'calendar', { kind: 'tile', count: 4 });
  const decades = rail(t('dcDecades'), 'clock', { kind: 'tile' });
  const top = rail(t('dcTopRated'), 'star', { seeAll: () => { presetSearch({ sort: 'SCORE_DESC' }); o.goTab('search'); } });
  const movies = rail(t('dcMovies'), 'film', { seeAll: () => { presetSearch({ formats: ['MOVIE'] }); o.goTab('search'); } });
  body.append(heroBox, cont.el, trending.el, airing.el, season.el, studios.el, genres.el, seasons.el, decades.el, top.el, movies.el);
  body.classList.add('dc-page');

  // ---- the rows from AniList, in one request
  const fillFrom = (d: al.DiscoverData) => {
    const heroes = d.trending.filter((a) => a.banner).slice(0, 8);
    heroBox.replaceChildren(hero(each(heroes, (a) => ({
      image: a.banner, title: titleOf(a), color: a.color, onClick: open(a),
      facts: [a.format ? fmtFormat(a.format) : '', ...a.genres.slice(0, 2).map(genreName), a.duration ? countMinutes(a.duration) : '', yearsOf(a)].filter(Boolean),
      chips: [a.status === 'RELEASING' ? t('dcOngoing') : a.status === 'FINISHED' ? t('dcFinished') : '', a.score ? `${localDigits(a.score)}%` : '', a.studio ?? ''].filter(Boolean),
      text: a.description?.replace(/\s+/g, ' ').slice(0, 260),
    }))));
    trending.fill(each(d.trending, (a, i) => poster({ image: coverOf(a), title: titleOf(a), sub: yearsOf(a), color: a.color, badge: t('dcRank', { n: localDigits(i + 1) }), badgeKind: i < 3 ? 'rank' : 'plain', overlay: overlayOf(a), onClick: open(a) })));
    airing.fill(each(d.airing, (a) => { const b = airingBadge(a); return poster({ image: coverOf(a), title: titleOf(a), sub: a.nextAiring ? t('animeNextEp', { n: a.nextAiring.episode, t: fmtUntil(a.nextAiring.airingAt - Date.now() / 1000) }) : yearsOf(a), color: a.color, badge: b?.text, badgeKind: b?.kind, overlay: overlayOf(a), onClick: open(a) }); }));
    season.fill(each(d.season, (a) => poster({ image: coverOf(a), title: titleOf(a), sub: a.episodes ? countEpisodes(a.episodes) : yearsOf(a), color: a.color, overlay: overlayOf(a), onClick: open(a) })));
    top.fill(each(d.top, (a, i) => poster({ image: coverOf(a), title: titleOf(a), sub: yearsOf(a), color: a.color, badge: `#${localDigits(i + 1)}`, badgeKind: 'plain', overlay: overlayOf(a), onClick: open(a) })));
    movies.fill(each(d.movies, (a) => poster({ image: coverOf(a), title: titleOf(a), sub: yearsOf(a), color: a.color, overlay: score10(a), onClick: open(a) })));
  };
  // (The page's own request: a time budget, the wait the catalogue asked for shown with Cancel, the last good page shown at once
  // and refreshed, a failure said in words with «Try again». The rows below it that are only pictures fail quietly.)
  const note = notice(); body.prepend(note.el);
  const key = `discover:${adult ? 1 : 0}`; const had = cached<al.DiscoverData>(key); let painted = false;
  if (had) { try { fillFrom(had.v); painted = true; note.refreshing(); } catch { /* asked for below */ } }
  const run = () => {
    const ctl = new AbortController(); let user = false; let ended = false;
    const slow = window.setTimeout(() => { if (!ended && o.live() && !painted) note.slow(); }, 6000);
    const stop = () => { ended = true; window.clearTimeout(slow); o.signal.removeEventListener('abort', onAbort); };
    const onAbort = () => ctl.abort(); o.signal.addEventListener('abort', onAbort);
    al.discover(adult, { signal: ctl.signal, onWait: (n) => { if (!ended && o.live()) { if (n > 0) note.wait(n, () => { user = true; ctl.abort(); }); else if (painted) note.refreshing(); else note.clear(); } } }).then((d) => {
      stop(); if (!o.live()) return;
      try { fillFrom(d); painted = true; } catch (e) { note.plain(e, o.retry); return; }
      keep(key, d); note.clear();
    }).catch((e) => {
      stop(); if (!o.live() || (al.faultKind(e) === 'cancelled' && !user)) return;
      const err = user ? new Error(t('animeNetCancelled')) : e;
      if (painted) note.failed(err, false, run); else { heroBox.replaceChildren(); for (const r of [trending, airing, season, top, movies]) r.el.hidden = true; note.plain(err, o.retry); }
    });
  };
  run();

  // ---- continue watching: what the player left half-way, then the list's next episodes
  void (async () => {
    const { history } = await import('../player/prefs'); await coversReady();
    const half = history().filter((m) => m.anilistId && !m.watched && m.duration > 0 && m.pos > 60 && m.duration - m.pos > 60).slice(0, 10);
    const cards: HTMLElement[] = []; const had = new Set<number>();
    for (const m of half) { if (had.has(m.anilistId!)) continue; had.add(m.anilistId!); cards.push(continueCard({ image: coverFor(m.anilistId, m.cover), title: m.show ?? '', line: m.episode ? t('episodeN', { n: m.episode }) : undefined, chip: t('timeLeft', { t: countMinutes(Math.max(1, Math.round((m.duration - m.pos) / 60))) }), progress: m.pos / m.duration, onClick: () => navigate(`/anime/${m.anilistId}`) })); }
    if (cards.length && o.live()) cont.fill(cards);
    if (!al.linked()) return;
    const list = await al.myList(undefined, { signal: o.signal }).catch(() => [] as Anime[]); if (!o.live()) return;
    const now = Date.now() / 1000;
    for (const a of list) {
      if (had.has(a.id) || cards.length >= 16) continue; const e = a.entry; if (!e) continue; const next = e.progress + 1;
      if (a.episodes && next > a.episodes) continue;
      const aired = a.nextAiring ? a.nextAiring.episode - 1 : a.status === 'FINISHED' ? a.episodes ?? next : next;
      const chip = next <= aired ? t('dcNextUp') : a.nextAiring ? t('dcAirsIn', { t: fmtUntil(a.nextAiring.airingAt - now) }) : '';
      if (!chip) continue;
      cards.push(continueCard({ image: customCover(a.id) ?? a.banner ?? a.cover, title: titleOf(a), line: t('episodeN', { n: next }), chip, progress: a.episodes ? e.progress / a.episodes : undefined, onClick: open(a) }));
    }
    if (o.live()) cont.fill(cards);
  })();

  // ---- the studios, each with the picture of its best known show
  void al.famousStudios({ signal: o.signal }).then((ss) => { if (o.live()) studios.fill(ss.map((s) => tile({ image: s.image, label: s.name, color: s.color ?? hueOf(s.name), onClick: () => navigate(studioPath(s.id, s.name)) }, true))); }).catch(() => { if (o.live()) studios.el.hidden = true; });

  // ---- genres, seasons, decades: picture tiles that open the search on them
  const now = al.seasonOf(); const lastFour = [-3, -2, -1, 0].map((k) => al.seasonShift(now, k)).reverse();
  const want = [
    ...GENRES.map((g) => ({ key: `g:${g}`, filter: `genre: ${JSON.stringify(g)}` })),
    ...lastFour.map((s) => ({ key: `s:${s.season}${s.year}`, filter: `season: ${s.season}, seasonYear: ${s.year}` })),
    ...DECADES.map((y) => ({ key: `d:${y}`, filter: `startDate_greater: ${y * 10000}, startDate_lesser: ${(y + 10) * 10000}` })),
  ];
  const draw = (art: Record<string, al.Art>) => {
    if (!o.live()) return;
    genres.fill(GENRES.map((g) => tile({ image: art[`g:${g}`]?.image, label: genreName(g), sub: genreName(g) !== g ? g : undefined, color: art[`g:${g}`]?.color ?? hueOf(g), onClick: () => { presetSearch({ genres: [g] }); o.goTab('search'); } })));
    seasons.fill(lastFour.map((s) => tile({ image: art[`s:${s.season}${s.year}`]?.image, label: seasonName(s.season), sub: localDigits(s.year), color: hueOf(s.season), onClick: () => { presetSearch({ season: s.season, year: s.year }); o.goTab('search'); } })));
    decades.fill(DECADES.map((y) => tile({ image: art[`d:${y}`]?.image, label: t('dcDecade', { y: localDigits(y), z: localDigits(y + 9) }), color: hueOf(String(y)), onClick: () => { presetSearch({ from: y, to: y + 9 }); o.goTab('search'); } })));
  };
  draw({}); void al.tileArt(want, { signal: o.signal }).then(draw).catch(() => undefined);
}

/** A genre's name in the app's language (AniList's own names otherwise). */
export function genreName(g: string): string {
  const k = `genre_${g.replace(/[^a-zA-Z]/g, '')}`; const v = t(k as 'dcStudios'); return v && v !== k ? v : g;
}
