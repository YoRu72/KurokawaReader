// AniList for anime: the account (a token taken from AniList's sign-in page or pasted), searching the
// catalogue, an entry's status, progress and score read and written (the reader's tracking, for episodes), the
// season chart (what AniChart draws) and the airing schedule (what LiveChart draws) — all from the one GraphQL
// endpoint, through the app's own HTTP so the phone and the desktop are not held back by CORS.
import { request } from './http';
import { parseFilename } from './anime/anitomy';
import { getSettings, updateSettings } from './settings';

const API = 'https://graphql.anilist.co';
const TOKEN_KEY = 'kt.anilist.token';
const USER_KEY = 'kt.anilist.user';

export type AlStatus = 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'DROPPED' | 'PAUSED' | 'REPEATING';
export const AL_STATUSES: AlStatus[] = ['CURRENT', 'PLANNING', 'COMPLETED', 'PAUSED', 'DROPPED', 'REPEATING'];
export type ScoreFormat = 'POINT_100' | 'POINT_10_DECIMAL' | 'POINT_10' | 'POINT_5' | 'POINT_3';
export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
export interface AlUser { id: number; name: string; avatar?: string; scoreFormat: ScoreFormat }
export interface AlDate { year?: number | null; month?: number | null; day?: number | null }
export interface AlEntry { id?: number; status: AlStatus; progress: number; score: number; startedAt?: AlDate; completedAt?: AlDate }
export interface Airing { airingAt: number; episode: number }
export interface Anime {
  id: number; idMal?: number;
  title: string; titleRomaji?: string; titleEnglish?: string; titleNative?: string; synonyms: string[];
  cover?: string; banner?: string; color?: string;
  format?: string; status?: string; episodes?: number | null; duration?: number | null;
  season?: Season; seasonYear?: number; startDate?: AlDate; endDate?: AlDate;
  genres: string[]; score?: number; popularity?: number; description?: string; isAdult: boolean; url: string;
  studio?: string; studioId?: number; trailer?: { id: string; site: string; thumbnail?: string };
  nextAiring?: Airing; schedule?: Airing[];
  streaming?: { title: string; url: string; site: string; thumbnail?: string }[];
  links?: { site: string; url: string; type?: string }[];
  relations?: { relation: string; id: number; title: string; format?: string }[];
  entry?: AlEntry;
  sequels?: { id: number; title: string; status: string; onList: boolean }[];
}

export function token(): string { try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; } }
export function user(): AlUser | null { try { return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') as AlUser | null; } catch { return null; } }
export const linked = (): boolean => !!token() && !!user();
export function unlink(): void { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch { /* private mode */ } }
/** Where the user signs in: AniList shows the token in the address it ends on when the client's redirect is its pin page. */
/** The sign-in page: the user's own API client, else the app's (see views/anilistLink). */
export function authUrl(): string { const id = getSettings().anilistClientId.trim() || BUILTIN_CLIENT; return `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(id)}&response_type=token`; }
/** The apps' own AniList API client «Kurokawa» (its ID only — public by design for this sign-in; no secret is
 *  used or kept). Its redirect address is AniList's pin page. */
export const BUILTIN_CLIENT = '55772';

const later = (m: string) => Object.assign(new Error(m), { later: true });
export const isLater = (e: unknown): boolean => !!(e as { later?: boolean })?.later;
let lastCall = 0;
/** One GraphQL call; AniList allows about thirty a minute, so calls are spaced out a little. */
export async function gql<T>(query: string, variables: Record<string, unknown> = {}, auth = true): Promise<T> {
  const wait = lastCall + 350 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastCall = Date.now();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const tk = token(); if (auth && tk) headers.Authorization = `Bearer ${tk}`;
  let r: Awaited<ReturnType<typeof request>>;
  try { r = await request(API, { method: 'POST', headers, body: JSON.stringify({ query, variables }) }); } catch (e) { throw later(String((e as Error)?.message ?? e)); }
  const busy = r.status === 429 || r.status >= 500 || r.status === 0;
  let json: { data?: T; errors?: { message: string; status?: number }[] } = {};
  try { json = JSON.parse(r.body); } catch { throw busy ? later(`AniList: HTTP ${r.status}`) : new Error(`AniList: HTTP ${r.status}`); }
  if (json.errors?.length) { const e = json.errors[0]; if ((e.status === 400 && /invalid token|unauthorized/i.test(e.message)) || r.status === 401) unlink(); throw busy || (e.status ?? 0) >= 500 || e.status === 429 ? later(e.message) : new Error(e.message); }
  if (r.status >= 400) throw busy ? later(`AniList: HTTP ${r.status}`) : new Error(`AniList: HTTP ${r.status}`);
  return json.data as T;
}

export async function link(tk: string): Promise<AlUser> {
  const clean = tk.trim().replace(/^Bearer\s+/i, ''); if (!clean) throw new Error('empty');
  try { localStorage.setItem(TOKEN_KEY, clean); } catch { /* private mode */ }
  try {
    const d = await gql<{ Viewer: { id: number; name: string; avatar?: { medium?: string }; mediaListOptions?: { scoreFormat?: ScoreFormat } } }>('query { Viewer { id name avatar { medium } mediaListOptions { scoreFormat } } }');
    const u: AlUser = { id: d.Viewer.id, name: d.Viewer.name, avatar: d.Viewer.avatar?.medium, scoreFormat: d.Viewer.mediaListOptions?.scoreFormat ?? 'POINT_10' };
    localStorage.setItem(USER_KEY, JSON.stringify(u)); return u;
  } catch (e) { unlink(); throw e; }
}

/* ---------- media ---------- */
const strip = (html?: string | null) => (html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
type RawEntry = { id: number; status: AlStatus; progress: number; score: number; startedAt?: AlDate; completedAt?: AlDate } | null;
type Raw = { id: number; idMal?: number; title: { romaji?: string; english?: string; native?: string; userPreferred?: string }; synonyms?: string[]; coverImage?: { large?: string; extraLarge?: string; color?: string }; bannerImage?: string; format?: string; status?: string; episodes?: number | null; duration?: number | null; season?: Season; seasonYear?: number; startDate?: AlDate; endDate?: AlDate; genres?: string[]; averageScore?: number; popularity?: number; description?: string; isAdult?: boolean; siteUrl: string; studios?: { nodes: { id?: number; name: string }[] }; trailer?: { id: string; site: string; thumbnail?: string } | null; nextAiringEpisode?: Airing | null; airingSchedule?: { nodes: Airing[] }; streamingEpisodes?: { title: string; url: string; site: string; thumbnail?: string }[]; externalLinks?: { site: string; url: string; type?: string }[]; relations?: { edges: { relationType: string; node: { id: number; title: { userPreferred?: string; romaji?: string }; format?: string } }[] }; mediaListEntry?: RawEntry };
const entryOf = (e?: RawEntry): AlEntry | undefined => (e ? { id: e.id, status: e.status, progress: e.progress, score: e.score, startedAt: e.startedAt, completedAt: e.completedAt } : undefined);
/** The title shown: the user's AniList preference when linked, else English, then romaji. */
const pick = (m: Raw) => m.title.userPreferred || m.title.english || m.title.romaji || m.title.native || '';
const toAnime = (m: Raw): Anime => ({
  id: m.id, idMal: m.idMal ?? undefined, title: pick(m), titleRomaji: m.title.romaji ?? undefined, titleEnglish: m.title.english ?? undefined, titleNative: m.title.native ?? undefined, synonyms: m.synonyms ?? [],
  cover: m.coverImage?.extraLarge ?? m.coverImage?.large, banner: m.bannerImage ?? undefined, color: m.coverImage?.color ?? undefined,
  format: m.format, status: m.status, episodes: m.episodes, duration: m.duration, season: m.season, seasonYear: m.seasonYear, startDate: m.startDate, endDate: m.endDate,
  genres: m.genres ?? [], score: m.averageScore, popularity: m.popularity, description: strip(m.description), isAdult: !!m.isAdult, url: m.siteUrl,
  studio: m.studios?.nodes?.[0]?.name, studioId: m.studios?.nodes?.[0]?.id, trailer: m.trailer ?? undefined, nextAiring: m.nextAiringEpisode ?? undefined, schedule: m.airingSchedule?.nodes,
  streaming: m.streamingEpisodes, links: m.externalLinks, relations: m.relations?.edges.map((e) => ({ relation: e.relationType, id: e.node.id, title: e.node.title.userPreferred || e.node.title.romaji || '', format: e.node.format })), entry: entryOf(m.mediaListEntry),
});
const CARD = 'id idMal title { romaji english native userPreferred } synonyms coverImage { large extraLarge color } format status episodes season seasonYear startDate { year month day } genres averageScore popularity isAdult siteUrl nextAiringEpisode { airingAt episode } mediaListEntry { id status progress score startedAt { year month day } completedAt { year month day } }';
const FULL = `${CARD} duration endDate { year month day } bannerImage description(asHtml: false) studios(isMain: true) { nodes { id name } } trailer { id site thumbnail } airingSchedule(perPage: 50) { nodes { airingAt episode } } streamingEpisodes { title url site thumbnail } externalLinks { site url type } relations { edges { relationType(version: 2) node { id title { userPreferred romaji } format } } }`;

export async function search(q: string, opts: { adult?: boolean; page?: number } = {}): Promise<Anime[]> {
  const d = await gql<{ Page: { media: Raw[] } }>(`query ($q: String, $page: Int, $adult: Boolean) { Page(page: $page, perPage: 20) { media(search: $q, type: ANIME, sort: SEARCH_MATCH, isAdult: $adult) { ${CARD} } } }`, { q, page: opts.page ?? 1, adult: opts.adult ? undefined : false });
  return d.Page.media.map(toAnime);
}
/** AniList's search with its filters (Hayase's and Senpwai's): words, genres, tags (all must match; some can be
 *  left out), format, status, season and year, sort — any of them alone browses by it. Answers are kept a few
 *  minutes, so going back and forth costs no request. */
export interface SearchFilters { q?: string; genres?: string[]; tags?: string[]; notTags?: string[]; formats?: string[]; status?: string; season?: Season; year?: number; sort?: string; minScore?: number; adult?: boolean; onList?: boolean; /** A decade or span of years (first and last year). */ from?: number; to?: number }
const searchCache = new Map<string, { at: number; v: { media: Anime[]; hasNext: boolean; used?: string } }>();
/** Other ways to put what was typed, for when it finds nothing: a release's file name read for its title; «season 2»,
 *  «2nd season», «part 2», «S2», an episode and a year dropped; punctuation made spaces; then the first words only. */
export function queryVariants(q: string): string[] {
  const out: string[] = []; const add = (x: string) => { const y = x.replace(/\s+/g, ' ').trim(); if (y.length >= 2 && y !== q && !out.includes(y)) out.push(y); };
  if (/[[\]_]|\.(mkv|mp4|avi|webm|torrent)$|\b(1080|720|480)p\b/i.test(q)) add(parseFilename(q).title);
  const plain = q.replace(/\b(?:season|cour|part)\s*\d+\b|\b\d+(?:st|nd|rd|th)\s+(?:season|cour)\b|\bS\d{1,2}(?:E\d{1,3})?\b|\b(?:ep(?:isode)?\.?)\s*\d+\b|\(?\b(?:19|20)\d\d\b\)?/gi, ' ');
  add(plain); const words = plain.replace(/[:\-–—!?,.~'’"“”]+/g, ' ').replace(/\s+/g, ' ').trim(); add(words);
  const w = words.split(' '); if (w.length > 2) add(w.slice(0, -1).join(' ')); if (w.length > 3) add(w.slice(0, 3).join(' '));
  return out.slice(0, 4);
}
export async function searchBy(f: SearchFilters, page = 1): Promise<{ media: Anime[]; hasNext: boolean; used?: string }> {
  const v: Record<string, unknown> = { page, adult: f.adult ? undefined : false, sort: [f.sort || (f.q ? 'SEARCH_MATCH' : 'POPULARITY_DESC')] };
  if (f.q?.trim()) v.q = f.q.trim(); if (f.genres?.length) v.genres = f.genres; if (f.tags?.length) v.tags = f.tags; if (f.notTags?.length) v.notTags = f.notTags;
  if (f.formats?.length) v.formats = f.formats; if (f.status) v.status = f.status; if (f.season) v.season = f.season; if (f.year) v.year = f.year; if (f.minScore) v.minScore = f.minScore; if (f.onList !== undefined) v.onList = f.onList;
  if (f.from) v.from = f.from * 10000; if (f.to) v.to = (f.to + 1) * 10000;
  const key = JSON.stringify(v); const had = searchCache.get(key); if (had && Date.now() - had.at < 5 * 60000) return had.v;
  const ask = (vars: Record<string, unknown>) => gql<{ Page: { pageInfo: { hasNextPage: boolean }; media: Raw[] } }>(`query ($q: String, $page: Int, $adult: Boolean, $genres: [String], $tags: [String], $notTags: [String], $formats: [MediaFormat], $status: MediaStatus, $season: MediaSeason, $year: Int, $sort: [MediaSort], $minScore: Int, $onList: Boolean, $from: FuzzyDateInt, $to: FuzzyDateInt) { Page(page: $page, perPage: 30) { pageInfo { hasNextPage } media(search: $q, type: ANIME, isAdult: $adult, genre_in: $genres, tag_in: $tags, tag_not_in: $notTags, format_in: $formats, status: $status, season: $season, seasonYear: $year, sort: $sort, averageScore_greater: $minScore, onList: $onList, startDate_greater: $from, startDate_lesser: $to) { ${CARD} } } }`, vars);
  let d = await ask(v); let used: string | undefined;
  // (Nothing for the words as typed — a file's name, «Season 2», a subtitle, a typo's last word —: the same search with
  // the words cleaned up, then shortened; the results say which words found them.)
  if (page === 1 && v.q && !d.Page.media.length) for (const q of queryVariants(String(v.q))) { const r = await ask({ ...v, q }); if (r.Page.media.length) { d = r; used = q; break; } }
  const out = { media: d.Page.media.map(toAnime), hasNext: d.Page.pageInfo.hasNextPage, used };
  searchCache.set(key, { at: Date.now(), v: out }); if (searchCache.size > 60) searchCache.delete(searchCache.keys().next().value!);
  return out;
}
/** Several shows at once (the library's covers). */
export async function mediaMany(ids: number[]): Promise<Anime[]> {
  const out: Anime[] = [];
  for (let i = 0; i < ids.length; i += 50) { const d = await gql<{ Page: { media: Raw[] } }>(`query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${CARD} relations { edges { relationType(version: 2) node { id type status format title { userPreferred romaji } mediaListEntry { status } } } } } } }`, { ids: ids.slice(i, i + 50) }); out.push(...d.Page.media.map((m) => { const a = toAnime(m); a.sequels = ((m as unknown as { relations?: { edges: { relationType: string; node: { id: number; type: string; status: string; format?: string; title: { userPreferred?: string; romaji?: string }; mediaListEntry?: { status: string } | null } }[] } }).relations?.edges ?? []).filter((e) => e.relationType === 'SEQUEL' && e.node.type === 'ANIME').map((e) => ({ id: e.node.id, title: e.node.title.userPreferred || e.node.title.romaji || '', status: e.node.status, onList: !!e.node.mediaListEntry })); return a; })); }
  return out;
}
/** Finished shows whose sequel you have not started (Seanime's «missed sequels»): the sequels, released or airing. */
export async function missedSequels(): Promise<{ from: Anime; sequel: { id: number; title: string; status: string } }[]> {
  const u = user(); if (!u) return [];
  const d = await gql<{ MediaListCollection: { lists: { entries: { media: { id: number } }[] }[] } }>('query ($user: Int) { MediaListCollection(userId: $user, type: ANIME, status_in: [COMPLETED]) { lists { entries { media { id } } } } }', { user: u.id });
  const ids = [...new Set(d.MediaListCollection.lists.flatMap((l) => l.entries.map((e) => e.media.id)))];
  const shows = await mediaMany(ids.slice(0, 300));
  const out: { from: Anime; sequel: { id: number; title: string; status: string } }[] = []; const seen = new Set<number>();
  for (const a of shows) for (const s of a.sequels ?? []) if (!s.onList && s.status !== 'NOT_YET_RELEASED' && s.status !== 'CANCELLED' && !seen.has(s.id)) { seen.add(s.id); out.push({ from: a, sequel: s }); }
  return out;
}
export interface AlTag { name: string; category: string; description?: string; isAdult: boolean }
let tagsP: Promise<{ genres: string[]; tags: AlTag[] }> | null = null;
/** AniList's genres and tags (kept for the session, and a week on the device). */
export function genresAndTags(): Promise<{ genres: string[]; tags: AlTag[] }> {
  tagsP ??= (async () => {
    try { const c = JSON.parse(localStorage.getItem('kt.al.tags') ?? 'null') as { at: number; genres: string[]; tags: AlTag[] } | null; if (c && Date.now() - c.at < 7 * 86400000 && c.tags.length) return c; } catch { /* none */ }
    const d = await gql<{ GenreCollection: string[]; MediaTagCollection: AlTag[] }>('query { GenreCollection MediaTagCollection { name category description isAdult } }', {}, false);
    const v = { genres: d.GenreCollection.filter((g) => g !== 'Hentai'), tags: d.MediaTagCollection };
    try { localStorage.setItem('kt.al.tags', JSON.stringify({ at: Date.now(), ...v })); } catch { /* full */ }
    return v;
  })().catch((e) => { tagsP = null; throw e; });
  return tagsP;
}
export async function media(id: number): Promise<Anime> {
  const d = await gql<{ Media: Raw }>(`query ($id: Int) { Media(id: $id, type: ANIME) { ${FULL} } }`, { id });
  return toAnime(d.Media);
}
/** The season chart: every show of a season, most popular first (AniChart's page). */
export async function seasonChart(season: Season, year: number, opts: { adult?: boolean; sort?: string; page?: number } = {}): Promise<{ media: Anime[]; hasNext: boolean }> {
  const d = await gql<{ Page: { pageInfo: { hasNextPage: boolean }; media: Raw[] } }>(`query ($season: MediaSeason, $year: Int, $page: Int, $adult: Boolean, $sort: [MediaSort]) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } media(type: ANIME, season: $season, seasonYear: $year, isAdult: $adult, sort: $sort) { ${CARD} } } }`, { season, year, page: opts.page ?? 1, adult: opts.adult ? undefined : false, sort: [opts.sort ?? 'POPULARITY_DESC'] });
  return { media: d.Page.media.map(toAnime), hasNext: d.Page.pageInfo.hasNextPage };
}
/** Shows of the season before that are still airing (AniChart's «leftovers»). */
export async function leftovers(season: Season, year: number, adult = false): Promise<Anime[]> {
  const d = await gql<{ Page: { media: Raw[] } }>(`query ($season: MediaSeason, $year: Int, $adult: Boolean) { Page(perPage: 50) { media(type: ANIME, season: $season, seasonYear: $year, status_in: [RELEASING, HIATUS], isAdult: $adult, sort: [POPULARITY_DESC]) { ${CARD} } } }`, { season, year, adult: adult ? undefined : false });
  return d.Page.media.map(toAnime);
}
export interface AiringItem { airingAt: number; episode: number; media: Anime }
/** Episodes airing between two moments (seconds), in order — the day's schedule. */
export async function airing(start: number, end: number): Promise<AiringItem[]> {
  const out: AiringItem[] = [];
  for (let page = 1; page <= 6; page++) {
    const d = await gql<{ Page: { pageInfo: { hasNextPage: boolean }; airingSchedules: { airingAt: number; episode: number; media: Raw }[] } }>(`query ($start: Int, $end: Int, $page: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) { airingAt episode media { ${CARD} } } } }`, { start, end, page });
    out.push(...d.Page.airingSchedules.map((a) => ({ airingAt: a.airingAt, episode: a.episode, media: toAnime(a.media) })));
    if (!d.Page.pageInfo.hasNextPage) break;
  }
  return out;
}
/** The user's own list (one status, or everything that is current/repeating when none is given). */
export async function myList(status?: AlStatus): Promise<Anime[]> {
  const u = user(); if (!u) return [];
  const d = await gql<{ MediaListCollection: { lists: { entries: { media: Raw; status: AlStatus; progress: number; score: number; id: number; startedAt?: AlDate; completedAt?: AlDate }[] }[] } }>(`query ($user: Int, $status: [MediaListStatus]) { MediaListCollection(userId: $user, type: ANIME, status_in: $status, sort: [UPDATED_TIME_DESC]) { lists { entries { id status progress score startedAt { year month day } completedAt { year month day } media { ${CARD} } } } } }`, { user: u.id, status: status ? [status] : ['CURRENT', 'REPEATING'] });
  const out: Anime[] = [];
  for (const l of d.MediaListCollection.lists) for (const e of l.entries) { const a = toAnime(e.media); a.entry = { id: e.id, status: e.status, progress: e.progress, score: e.score, startedAt: e.startedAt, completedAt: e.completedAt }; out.push(a); }
  return out;
}

/* ---------- the entry ---------- */
const dateIn = (d?: AlDate) => (d && (d.year || d.month || d.day) ? { year: d.year ?? null, month: d.month ?? null, day: d.day ?? null } : null);
export async function save(mediaId: number, e: AlEntry): Promise<AlEntry> {
  const d = await gql<{ SaveMediaListEntry: NonNullable<RawEntry> }>('mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $score: Float, $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput) { SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, score: $score, startedAt: $startedAt, completedAt: $completedAt) { id status progress score startedAt { year month day } completedAt { year month day } } }',
    { mediaId, status: e.status, progress: Math.max(0, Math.round(e.progress)), score: e.score, startedAt: dateIn(e.startedAt), completedAt: dateIn(e.completedAt) });
  return entryOf(d.SaveMediaListEntry)!;
}
export async function remove(entryId: number): Promise<void> { await gql('mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }', { id: entryId }); }

/* ---------- changes made offline: kept and sent when AniList can be reached ---------- */
type Pending = Record<string, { entry: AlEntry; tries: number }>;
const pendingNow = (): Pending => getSettings().anilistPending as Pending;
const keepPending = (p: Pending) => updateSettings({ anilistPending: p });
/** The entry written — or, when AniList cannot be reached, queued and reported as not yet sent. */
export async function saveOrQueue(mediaId: number, entry: AlEntry): Promise<{ entry: AlEntry; sent: boolean }> {
  try { const e = await save(mediaId, entry); const p = pendingNow(); if (p[mediaId]) { delete p[mediaId]; keepPending(p); } return { entry: e, sent: true }; }
  catch (err) { if (!isLater(err)) throw err; const p = pendingNow(); p[mediaId] = { entry, tries: 0 }; keepPending(p); return { entry, sent: false }; }
}
let flushing = false;
export async function flushPending(): Promise<void> {
  if (flushing || !linked()) return; const p = pendingNow(); if (!Object.keys(p).length) return;
  flushing = true;
  try { for (const [id, q] of Object.entries(p)) { try { await save(Number(id), q.entry); delete p[id]; } catch (err) { if (!isLater(err) || ++q.tries >= 8) delete p[id]; } } keepPending(p); } finally { flushing = false; }
}
window.addEventListener('online', () => void flushPending());

/* ---------- helpers ---------- */
export const scoreMax = (f: ScoreFormat): number => (f === 'POINT_100' ? 100 : f === 'POINT_5' ? 5 : f === 'POINT_3' ? 3 : 10);
export const scoreStep = (f: ScoreFormat): number => (f === 'POINT_10_DECIMAL' ? 0.1 : 1);
export const today = (): AlDate => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }; };
export const SEASONS: Season[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
export function seasonOf(d = new Date()): { season: Season; year: number } { return { season: SEASONS[Math.floor(d.getMonth() / 3)], year: d.getFullYear() }; }
export function seasonShift({ season, year }: { season: Season; year: number }, by: number): { season: Season; year: number } { const i = SEASONS.indexOf(season) + by; return { season: SEASONS[((i % 4) + 4) % 4], year: year + Math.floor(i / 4) }; }
/** Titles to search torrents by: every name AniList has, the longest first, short synonyms left out. */
export function titlesOf(a: Anime): string[] { return [...new Set([a.titleRomaji, a.titleEnglish, a.title, a.titleNative, ...a.synonyms].filter((x): x is string => !!x && x.length > 3))]; }

/* ---------- other ids (Kitsu for Torrentio, AniDB for AnimeTosho, IMDb for subtitles) ---------- */
export interface IdMap { anidb?: number; kitsu?: number; mal?: number; imdb?: string; tmdb?: number; tvdb?: number; livechart?: number }
const idCache = new Map<number, IdMap>();
export async function idsOf(anilistId: number): Promise<IdMap> {
  const c = idCache.get(anilistId); if (c) return c;
  let out: IdMap = {};
  try { const r = await request(`https://arm.haglund.dev/api/v2/ids?source=anilist&id=${anilistId}`); if (r.status === 200) { const j = JSON.parse(r.body) as Record<string, number | string | null>; out = { anidb: num(j.anidb), kitsu: num(j.kitsu), mal: num(j.myanimelist), imdb: typeof j.imdb === 'string' ? j.imdb : undefined, tmdb: num(j.themoviedb), tvdb: num(j.thetvdb), livechart: num(j.livechart) }; } } catch { /* next source */ }
  if (!out.kitsu && !out.anidb) try { const r = await request(`https://api.ani.zip/mappings?anilist_id=${anilistId}`); if (r.status === 200) { const m = (JSON.parse(r.body) as { mappings?: Record<string, number | string | null> }).mappings ?? {}; out = { anidb: out.anidb ?? num(m.anidb_id), kitsu: out.kitsu ?? num(m.kitsu_id), mal: out.mal ?? num(m.mal_id), imdb: out.imdb ?? (typeof m.imdb_id === 'string' ? m.imdb_id : undefined), tmdb: out.tmdb ?? num(m.themoviedb_id), tvdb: out.tvdb ?? num(m.thetvdb_id), livechart: out.livechart ?? num(m.livechart_id) }; } } catch { /* none */ }
  idCache.set(anilistId, out); return out;
}
const num = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? v : undefined);

/* ---------- Discover ---------- */
export interface DiscoverData { trending: Anime[]; airing: (Anime & { sequel?: boolean })[]; season: Anime[]; top: Anime[]; movies: Anime[] }
let discoverCache: { at: number; key: string; v: DiscoverData } | null = null;
/** The Discover page's rows in one request: trending (with banners for the hero), airing now, this season, the best
 *  rated, the popular films. Kept ten minutes. */
export async function discover(adult = false): Promise<DiscoverData> {
  const { season, year } = seasonOf(); const key = `${season}${year}${adult}`;
  if (discoverCache && discoverCache.key === key && Date.now() - discoverCache.at < 10 * 60000) return discoverCache.v;
  const A = adult ? '' : ', isAdult: false';
  const d = await gql<{ trending: { media: Raw[] }; airing: { media: (Raw & { prequels?: { edges: { relationType: string }[] } })[] }; season: { media: Raw[] }; top: { media: Raw[] }; movies: { media: Raw[] } }>(`query ($season: MediaSeason, $year: Int) {
    trending: Page(perPage: 20) { media(type: ANIME, sort: [TRENDING_DESC]${A}) { ${CARD} bannerImage description(asHtml: false) duration studios(isMain: true) { nodes { id name } } } }
    airing: Page(perPage: 24) { media(type: ANIME, status: RELEASING, sort: [POPULARITY_DESC]${A}) { ${CARD} prequels: relations { edges { relationType(version: 2) } } } }
    season: Page(perPage: 24) { media(type: ANIME, season: $season, seasonYear: $year, sort: [POPULARITY_DESC]${A}) { ${CARD} } }
    top: Page(perPage: 20) { media(type: ANIME, sort: [SCORE_DESC], popularity_greater: 20000${A}) { ${CARD} } }
    movies: Page(perPage: 20) { media(type: ANIME, format: MOVIE, sort: [POPULARITY_DESC]${A}) { ${CARD} } } }`, { season, year });
  const v: DiscoverData = {
    trending: d.trending.media.map(toAnime), season: d.season.media.map(toAnime), top: d.top.media.map(toAnime), movies: d.movies.media.map(toAnime),
    airing: d.airing.media.map((m) => ({ ...toAnime(m), sequel: !!m.prequels?.edges.some((e) => e.relationType === 'PREQUEL') })),
  };
  discoverCache = { at: Date.now(), key, v }; return v;
}
export interface Art { image?: string; color?: string }
const ART_KEY = 'kt.anime.art';
/** A picture for each tile (the best known show of a genre, a season, a decade): asked for in one request, kept three days. */
export async function tileArt(want: { key: string; filter: string }[]): Promise<Record<string, Art>> {
  let kept: { at: number; v: Record<string, Art> } = { at: 0, v: {} }; try { kept = JSON.parse(localStorage.getItem(ART_KEY) ?? 'null') ?? kept; } catch { /* first time */ }
  const fresh = Date.now() - kept.at < 3 * 86400e3; const missing = want.filter((w) => !fresh || !(w.key in kept.v)); if (!missing.length) return kept.v;
  const alias = (k: string) => 'a' + k.replace(/[^a-zA-Z0-9]/g, '_');
  const q = `query { ${missing.map((w) => `${alias(w.key)}: Page(perPage: 1) { media(type: ANIME, sort: [POPULARITY_DESC], isAdult: false, ${w.filter}) { bannerImage coverImage { extraLarge color } } }`).join(' ')} }`;
  const d = await gql<Record<string, { media: { bannerImage?: string; coverImage?: { extraLarge?: string; color?: string } }[] }>>(q, {}, false);
  const v = fresh ? { ...kept.v } : {};
  for (const w of missing) { const m = d[alias(w.key)]?.media?.[0]; v[w.key] = { image: m?.bannerImage ?? m?.coverImage?.extraLarge, color: m?.coverImage?.color }; }
  try { localStorage.setItem(ART_KEY, JSON.stringify({ at: fresh ? kept.at : Date.now(), v })); } catch { /* full */ }
  return v;
}
/* ---------- studios ---------- */
export interface Studio { id: number; name: string; animation: boolean; favourites?: number; image?: string; color?: string; count?: number }
type RawStudio = { id: number; name: string; isAnimationStudio: boolean; favourites?: number; media?: { pageInfo?: { total?: number }; nodes: { bannerImage?: string; coverImage?: { extraLarge?: string; color?: string } }[] } };
const toStudio = (s: RawStudio): Studio => ({ id: s.id, name: s.name, animation: s.isAnimationStudio, favourites: s.favourites, image: s.media?.nodes?.[0]?.bannerImage ?? s.media?.nodes?.[0]?.coverImage?.extraLarge, color: s.media?.nodes?.[0]?.coverImage?.color, count: s.media?.pageInfo?.total });
const STUDIO_FIELDS = 'id name isAnimationStudio favourites media(sort: [POPULARITY_DESC], isMain: true, perPage: 1) { nodes { bannerImage coverImage { extraLarge color } } }';
/** Studios by name, the closest first (the animation studios before the producers). */
export async function searchStudios(q: string): Promise<Studio[]> {
  const d = await gql<{ Page: { studios: RawStudio[] } }>(`query ($q: String) { Page(perPage: 12) { studios(search: $q, sort: [SEARCH_MATCH]) { ${STUDIO_FIELDS} } } }`, { q }, false);
  const all = d.Page.studios.map(toStudio); return [...all.filter((s) => s.animation), ...all.filter((s) => !s.animation)];
}
const FAMOUS = ['MAPPA', 'ufotable', 'Kyoto Animation', 'Madhouse', 'Production I.G', 'Bones', 'Wit Studio', 'A-1 Pictures', 'CloverWorks', 'Trigger', 'Shaft', 'Pierrot', 'Toei Animation', 'Sunrise', 'David Production', 'Science SARU', 'P.A. Works', 'J.C.Staff', 'Studio Ghibli', 'Kinema Citrus'];
const STUDIOS_KEY = 'kt.anime.studios';
/** The best known studios, each with its id and its best known show's picture (asked once, kept a week). */
export async function famousStudios(): Promise<Studio[]> {
  try { const k = JSON.parse(localStorage.getItem(STUDIOS_KEY) ?? 'null') as { at: number; v: Studio[] } | null; if (k && Date.now() - k.at < 7 * 86400e3 && k.v.length) return k.v; } catch { /* first time */ }
  const d = await gql<Record<string, RawStudio | null>>(`query { ${FAMOUS.map((n, i) => `s${i}: Studio(search: ${JSON.stringify(n)}) { ${STUDIO_FIELDS} }`).join(' ')} }`, {}, false);
  const seen = new Set<number>(); const v: Studio[] = [];
  FAMOUS.forEach((_, i) => { const s = d[`s${i}`]; if (s && !seen.has(s.id)) { seen.add(s.id); v.push(toStudio(s)); } });
  try { localStorage.setItem(STUDIOS_KEY, JSON.stringify({ at: Date.now(), v })); } catch { /* full */ }
  return v;
}
/** A studio's works: the page asked for, in the order chosen, its own productions only or with the ones it helped on. */
export async function studioWorks(id: number, o: { page?: number; sort?: string; mainOnly?: boolean } = {}): Promise<{ studio: Studio; media: Anime[]; hasNext: boolean; total?: number }> {
  const d = await gql<{ Studio: RawStudio & { works: { pageInfo: { hasNextPage: boolean; total?: number }; nodes: Raw[] } } }>(`query ($id: Int, $page: Int, $sort: [MediaSort], $main: Boolean) { Studio(id: $id) { ${STUDIO_FIELDS} works: media(page: $page, perPage: 30, sort: $sort, isMain: $main) { pageInfo { hasNextPage total } nodes { ${CARD} } } } }`, { id, page: o.page ?? 1, sort: [o.sort ?? 'POPULARITY_DESC'], main: o.mainOnly ? true : undefined }, true);
  const s = d.Studio; return { studio: toStudio(s), media: s.works.nodes.filter((m) => m.siteUrl).map(toAnime), hasNext: s.works.pageInfo.hasNextPage, total: s.works.pageInfo.total };
}
