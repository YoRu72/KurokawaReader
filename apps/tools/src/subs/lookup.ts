// What the user is looking for subtitles of: a name typed, or an AniList / MyAnimeList / IMDb link or id
// pasted — resolved to one card with every id the sites want (IMDb, AniList, MAL, TVDB, AniDB), by asking
// AniList (anime), Cinemeta (films and series, with IMDb ids) and Jikan (a MAL id) at once — as OTL in the
// reader turns a title into a book across its sources.
import { request } from '../http';
import * as al from '../anilist';

export type TitleKind = 'anime' | 'movie' | 'series';
export interface TitleCard {
  kind: TitleKind; title: string; titles: string[]; year?: number; cover?: string; episodes?: number; seasons?: number;
  ids: { anilist?: number; mal?: number; imdb?: string; tvdb?: number; anidb?: number; kitsu?: number; tmdb?: number };
}

/** An id or a link the user pasted, when it is one. */
export function parseRef(s: string): { anilist?: number; mal?: number; imdb?: string } | null {
  const t = s.trim();
  let m = /anilist\.co\/(?:anime|manga)\/(\d+)/i.exec(t); if (m) return { anilist: Number(m[1]) };
  m = /myanimelist\.net\/anime\/(\d+)/i.exec(t); if (m) return { mal: Number(m[1]) };
  m = /(tt\d{6,10})/i.exec(t); if (m) return { imdb: m[1].toLowerCase() };
  m = /^(?:al|anilist)[:\s]+(\d+)$/i.exec(t); if (m) return { anilist: Number(m[1]) };
  m = /^mal[:\s]+(\d+)$/i.exec(t); if (m) return { mal: Number(m[1]) };
  return null;
}

const fromAnime = (a: al.Anime): TitleCard => ({ kind: 'anime', title: a.title, titles: al.titlesOf(a), year: a.seasonYear ?? a.startDate?.year ?? undefined, cover: a.cover, episodes: a.episodes ?? undefined, ids: { anilist: a.id, mal: a.idMal } });
type Meta = { imdb_id: string; name: string; poster?: string; releaseInfo?: string; year?: string; type: string };
const fromMeta = (m: Meta, kind: 'movie' | 'series'): TitleCard => ({ kind, title: m.name, titles: [m.name], year: Number((m.releaseInfo ?? m.year ?? '').slice(0, 4)) || undefined, cover: m.poster, ids: { imdb: m.imdb_id } });

/** Cards for what was typed: anime first when it is an anime word, films and series beside. */
export async function lookup(q: string, adult = false): Promise<TitleCard[]> {
  const ref = parseRef(q);
  if (ref) {
    if (ref.anilist) return [fromAnime(await al.media(ref.anilist))];
    if (ref.mal) { const d = await al.gql<{ Media: { id: number } | null }>('query ($mal: Int) { Media(idMal: $mal, type: ANIME) { id } }', { mal: ref.mal }, false).catch(() => null); if (d?.Media) return [fromAnime(await al.media(d.Media.id))]; const r = await request(`https://api.jikan.moe/v4/anime/${ref.mal}`); if (r.status === 200) { const j = (JSON.parse(r.body) as { data: { title: string; title_english?: string; year?: number; images?: { jpg?: { large_image_url?: string } }; episodes?: number } }).data; return [{ kind: 'anime', title: j.title_english || j.title, titles: [j.title, j.title_english].filter((x): x is string => !!x), year: j.year, cover: j.images?.jpg?.large_image_url, episodes: j.episodes ?? undefined, ids: { mal: ref.mal } }]; } return []; }
    if (ref.imdb) { const out: TitleCard[] = []; for (const kind of ['movie', 'series'] as const) { const r = await request(`https://v3-cinemeta.strem.io/meta/${kind}/${ref.imdb}.json`); if (r.status === 200) { const m = (JSON.parse(r.body) as { meta?: Meta & { videos?: { season: number }[] } }).meta; if (m) { const c = fromMeta(m, kind); if (kind === 'series' && m.videos) c.seasons = Math.max(0, ...m.videos.map((v) => v.season)); out.push(c); } } } return out; }
  }
  const [anime, movies, series] = await Promise.all([
    al.search(q, { adult }).catch(() => [] as al.Anime[]),
    request(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(q)}.json`).then((r) => (r.status === 200 ? ((JSON.parse(r.body) as { metas?: Meta[] }).metas ?? []) : [])).catch(() => [] as Meta[]),
    request(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(q)}.json`).then((r) => (r.status === 200 ? ((JSON.parse(r.body) as { metas?: Meta[] }).metas ?? []) : [])).catch(() => [] as Meta[]),
  ]);
  const cards = [...anime.slice(0, 8).map(fromAnime), ...movies.slice(0, 6).map((m) => fromMeta(m, 'movie')), ...series.slice(0, 6).map((m) => fromMeta(m, 'series'))];
  // The same work in two catalogues (an anime film is also in Cinemeta): one card, the ids merged.
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const out: TitleCard[] = [];
  for (const c of cards) { const twin = out.find((o) => o.kind !== c.kind && (o.kind === 'anime' || c.kind === 'anime') && o.year === c.year && (norm(o.title) === norm(c.title) || o.titles.some((t) => norm(t) === norm(c.title)))); if (twin) { twin.ids = { ...c.ids, ...twin.ids }; if (!twin.cover) twin.cover = c.cover; continue; } out.push(c); }
  return out;
}

/** Every id the sites could want, filled in from the mapping services for an anime. */
export async function enrich(c: TitleCard): Promise<TitleCard> {
  if (c.kind === 'anime' && c.ids.anilist) { const ids = await al.idsOf(c.ids.anilist).catch(() => ({} as al.IdMap)); c.ids = { ...c.ids, imdb: c.ids.imdb ?? ids.imdb, tvdb: c.ids.tvdb ?? ids.tvdb, anidb: c.ids.anidb ?? ids.anidb, kitsu: c.ids.kitsu ?? ids.kitsu, mal: c.ids.mal ?? ids.mal, tmdb: c.ids.tmdb ?? ids.tmdb }; }
  if (c.kind === 'series' && c.ids.imdb && !c.seasons) { const r = await request(`https://v3-cinemeta.strem.io/meta/series/${c.ids.imdb}.json`).catch(() => null); if (r?.status === 200) { const m = (JSON.parse(r.body) as { meta?: { videos?: { season: number }[] } }).meta; if (m?.videos) c.seasons = Math.max(0, ...m.videos.map((v) => v.season)); } }
  return c;
}
