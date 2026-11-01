// Films and series from Cinemeta (Stremio's catalogue, built on IMDb): what is popular, new and best rated —
// by genre or year —, searching, and a title's page (its seasons and episodes with their dates, pictures and
// summaries). Answers are kept a while: they change slowly, and the same pages are opened again and again.
import { request } from '../http';

export type TvKind = 'movie' | 'series';
export interface TvMeta {
  id: string; type: TvKind; name: string; poster?: string; background?: string; logo?: string; description?: string; year?: string; releaseInfo?: string;
  imdbRating?: string; genres: string[]; runtime?: string; cast?: string[]; director?: string[]; country?: string; status?: string; tvdb?: number; tmdb?: number;
  trailer?: string; videos?: TvEpisode[];
}
export interface TvEpisode { id: string; season: number; episode: number; name: string; released?: string; thumbnail?: string; overview?: string }
const META = 'https://v3-cinemeta.strem.io'; const CAT = 'https://cinemeta-catalogs.strem.io';
export const GENRES: Record<TvKind, string[]> = {
  movie: ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western'],
  series: ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western', 'Reality-TV', 'Talk-Show', 'Game-Show'],
};
export type Catalog = 'top' | 'year' | 'imdbRating';

const cache = new Map<string, { at: number; v: unknown }>();
async function get<T>(url: string, ttl = 30 * 60000): Promise<T> {
  const had = cache.get(url); if (had && Date.now() - had.at < ttl) return had.v as T;
  const r = await request(url); if (r.status !== 200) throw new Error(`Cinemeta: HTTP ${r.status}`);
  const v = JSON.parse(r.body) as T; cache.set(url, { at: Date.now(), v }); if (cache.size > 120) cache.delete(cache.keys().next().value!);
  return v;
}
type Raw = { id?: string; imdb_id?: string; type?: string; name: string; poster?: string; background?: string; logo?: string; description?: string; year?: string | number; releaseInfo?: string; imdbRating?: string; genres?: string[]; genre?: string[]; runtime?: string; cast?: string[]; director?: string[] | string; country?: string; status?: string; tvdb_id?: number | string; moviedb_id?: number; trailers?: { source: string; type: string }[]; videos?: { id: string; season: number; episode?: number; number?: number; name?: string; title?: string; released?: string; firstAired?: string; thumbnail?: string; overview?: string; description?: string }[] };
const toMeta = (m: Raw, type: TvKind): TvMeta => ({
  id: m.imdb_id || m.id || '', type: (m.type as TvKind) || type, name: m.name, poster: m.poster, background: m.background, logo: m.logo, description: m.description,
  year: m.year ? String(m.year) : undefined, releaseInfo: m.releaseInfo, imdbRating: m.imdbRating, genres: m.genres ?? m.genre ?? [], runtime: m.runtime, cast: m.cast?.slice(0, 12),
  director: Array.isArray(m.director) ? m.director : m.director ? [m.director] : undefined, country: m.country, status: m.status, tvdb: m.tvdb_id ? Number(m.tvdb_id) : undefined, tmdb: m.moviedb_id,
  trailer: m.trailers?.find((x) => x.type === 'Trailer')?.source ?? m.trailers?.[0]?.source,
  videos: m.videos?.filter((v) => v.season !== undefined).map((v) => ({ id: v.id, season: v.season, episode: v.episode ?? v.number ?? 0, name: v.name ?? v.title ?? '', released: v.released ?? v.firstAired, thumbnail: v.thumbnail, overview: v.overview ?? v.description })).sort((a, b) => a.season - b.season || a.episode - b.episode),
});
/** A catalogue page (100 a «skip»): popular, new (by year) or best rated, optionally of one genre or year. */
export async function catalog(type: TvKind, cat: Catalog, genre?: string, skip = 0): Promise<{ metas: TvMeta[]; more: boolean }> {
  const extra = [genre ? `genre=${encodeURIComponent(genre)}` : '', skip ? `skip=${skip}` : ''].filter(Boolean).join('&');
  const j = await get<{ metas?: Raw[]; hasMore?: boolean }>(`${CAT}/${cat}/catalog/${type}/${cat}${extra ? `/${extra}` : ''}.json`);
  return { metas: (j.metas ?? []).map((m) => toMeta(m, type)).filter((m) => m.id.startsWith('tt')), more: j.hasMore ?? (j.metas?.length ?? 0) >= 50 };
}
export async function search(q: string): Promise<TvMeta[]> {
  const [mv, sr] = await Promise.all((['movie', 'series'] as const).map((type) => get<{ metas?: Raw[] }>(`${META}/catalog/${type}/top/search=${encodeURIComponent(q.trim())}.json`, 10 * 60000).then((j) => (j.metas ?? []).map((m) => toMeta(m, type))).catch(() => [] as TvMeta[])));
  // (Films and series together, the better known first: Cinemeta orders each list by popularity.)
  const out: TvMeta[] = []; for (let i = 0; i < Math.max(mv.length, sr.length); i++) { if (sr[i]) out.push(sr[i]); if (mv[i]) out.push(mv[i]); }
  return out.filter((m) => m.id.startsWith('tt'));
}
export async function meta(type: TvKind, id: string): Promise<TvMeta> {
  const j = await get<{ meta?: Raw }>(`${META}/meta/${type}/${id}.json`, 60 * 60000); if (!j.meta) throw new Error('Cinemeta: not found');
  return toMeta(j.meta, type);
}
/** A series' seasons (specials, season 0, last). */
export const seasonsOf = (m: TvMeta): number[] => { const s = [...new Set((m.videos ?? []).map((v) => v.season))]; return [...s.filter((x) => x > 0).sort((a, b) => a - b), ...s.filter((x) => x === 0)]; };
export const aired = (v: TvEpisode, now = Date.now()): boolean => !v.released || Date.parse(v.released) <= now;
