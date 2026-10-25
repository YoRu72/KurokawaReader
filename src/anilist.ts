// AniList tracking: the reader's own AniList account (a token they paste after signing in), searching the
// catalogue for the book being read, and the list entry — status, progress, score, dates — read and written.
// Off unless turned on in settings; nothing is sent anywhere until a book is linked.
import { localHttp } from './localai';
import { getSettings } from './settings';

const API = 'https://graphql.anilist.co';
const TOKEN_KEY = 'kr.anilist.token';
const USER_KEY = 'kr.anilist.user';

export type AlStatus = 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'DROPPED' | 'PAUSED' | 'REPEATING';
export const AL_STATUSES: AlStatus[] = ['CURRENT', 'PLANNING', 'COMPLETED', 'PAUSED', 'DROPPED', 'REPEATING'];
export type ScoreFormat = 'POINT_100' | 'POINT_10_DECIMAL' | 'POINT_10' | 'POINT_5' | 'POINT_3';
export interface AlUser { id: number; name: string; avatar?: string; scoreFormat: ScoreFormat }
export interface AlDate { year?: number | null; month?: number | null; day?: number | null }
export interface AlMedia { id: number; title: string; titleNative?: string; cover?: string; format?: string; status?: string; year?: number; score?: number; chapters?: number | null; volumes?: number | null; description?: string; url: string }
export interface AlEntry { id?: number; status: AlStatus; progress: number; score: number; startedAt?: AlDate; completedAt?: AlDate }
/** What a book keeps about its AniList entry. */
export interface Track { service: 'anilist'; media: AlMedia; entry: AlEntry; updatedAt: number }

export const anilistOn = (): boolean => getSettings().anilistEnabled;
export function token(): string { try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; } }
export function user(): AlUser | null { try { return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') as AlUser | null; } catch { return null; } }
export const linked = (): boolean => !!token() && !!user();
export function unlink(): void { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch { /* private mode */ } }

/** Where the reader signs in: AniList shows the token on its own page when the client's redirect is its pin page. */
export function authUrl(): string {
  const id = getSettings().anilistClientId.trim();
  return `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(id)}&response_type=token`;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}, auth = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const tk = token(); if (auth && tk) headers.Authorization = `Bearer ${tk}`;
  const r = await localHttp(API, { method: 'POST', headers, body: JSON.stringify({ query, variables }), timeoutMs: 20000 });
  let json: { data?: T; errors?: { message: string; status?: number }[] } = {};
  try { json = JSON.parse(r.body); } catch { throw new Error(`AniList: HTTP ${r.status}`); }
  if (json.errors?.length) { const e = json.errors[0]; if (e.status === 400 && /invalid token|unauthorized/i.test(e.message) || r.status === 401) unlink(); throw new Error(e.message); }
  if (r.status >= 400) throw new Error(`AniList: HTTP ${r.status}`);
  return json.data as T;
}

/** Sign in with a pasted token: the account is looked up and remembered. */
export async function link(tk: string): Promise<AlUser> {
  const clean = tk.trim().replace(/^Bearer\s+/i, '');
  if (!clean) throw new Error('empty');
  try { localStorage.setItem(TOKEN_KEY, clean); } catch { /* private mode */ }
  try {
    const d = await gql<{ Viewer: { id: number; name: string; avatar?: { medium?: string }; mediaListOptions?: { scoreFormat?: ScoreFormat } } }>('query { Viewer { id name avatar { medium } mediaListOptions { scoreFormat } } }');
    const u: AlUser = { id: d.Viewer.id, name: d.Viewer.name, avatar: d.Viewer.avatar?.medium, scoreFormat: d.Viewer.mediaListOptions?.scoreFormat ?? 'POINT_10' };
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    return u;
  } catch (e) { unlink(); throw e; }
}

const strip = (html?: string | null) => (html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
type RawMedia = { id: number; title: { romaji?: string; english?: string; native?: string }; coverImage?: { medium?: string; large?: string }; format?: string; status?: string; startDate?: AlDate; averageScore?: number; chapters?: number | null; volumes?: number | null; description?: string; siteUrl: string; mediaListEntry?: { id: number; status: AlStatus; progress: number; score: number; startedAt?: AlDate; completedAt?: AlDate } | null };
const toMedia = (m: RawMedia): AlMedia => ({ id: m.id, title: m.title.english || m.title.romaji || m.title.native || '', titleNative: m.title.native ?? undefined, cover: m.coverImage?.large ?? m.coverImage?.medium, format: m.format, status: m.status, year: m.startDate?.year ?? undefined, score: m.averageScore, chapters: m.chapters, volumes: m.volumes, description: strip(m.description), url: m.siteUrl });
const MEDIA = 'id title { romaji english native } coverImage { medium large } format status startDate { year } averageScore chapters volumes description(asHtml: false) siteUrl mediaListEntry { id status progress score startedAt { year month day } completedAt { year month day } }';

/** Manga and novels matching a title. */
export async function search(q: string): Promise<{ media: AlMedia; entry?: AlEntry }[]> {
  const d = await gql<{ Page: { media: RawMedia[] } }>(`query ($q: String) { Page(perPage: 15) { media(search: $q, type: MANGA, sort: SEARCH_MATCH) { ${MEDIA} } } }`, { q });
  return d.Page.media.map((m) => ({ media: toMedia(m), entry: m.mediaListEntry ? { id: m.mediaListEntry.id, status: m.mediaListEntry.status, progress: m.mediaListEntry.progress, score: m.mediaListEntry.score, startedAt: m.mediaListEntry.startedAt, completedAt: m.mediaListEntry.completedAt } : undefined }));
}

/** The entry as it is on AniList now (and the media, in case it changed). */
export async function refresh(mediaId: number): Promise<{ media: AlMedia; entry?: AlEntry }> {
  const d = await gql<{ Media: RawMedia }>(`query ($id: Int) { Media(id: $id, type: MANGA) { ${MEDIA} } }`, { id: mediaId });
  const m = d.Media;
  return { media: toMedia(m), entry: m.mediaListEntry ? { id: m.mediaListEntry.id, status: m.mediaListEntry.status, progress: m.mediaListEntry.progress, score: m.mediaListEntry.score, startedAt: m.mediaListEntry.startedAt, completedAt: m.mediaListEntry.completedAt } : undefined };
}

const dateIn = (d?: AlDate) => d && (d.year || d.month || d.day) ? { year: d.year ?? null, month: d.month ?? null, day: d.day ?? null } : null;
/** Write the entry to the reader's list. */
export async function save(mediaId: number, e: AlEntry): Promise<AlEntry> {
  const d = await gql<{ SaveMediaListEntry: { id: number; status: AlStatus; progress: number; score: number; startedAt?: AlDate; completedAt?: AlDate } }>(
    'mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $score: Float, $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput) { SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, score: $score, startedAt: $startedAt, completedAt: $completedAt) { id status progress score startedAt { year month day } completedAt { year month day } } }',
    { mediaId, status: e.status, progress: Math.max(0, Math.round(e.progress)), score: e.score, startedAt: dateIn(e.startedAt), completedAt: dateIn(e.completedAt) });
  const r = d.SaveMediaListEntry;
  return { id: r.id, status: r.status, progress: r.progress, score: r.score, startedAt: r.startedAt, completedAt: r.completedAt };
}

/** Take the entry off the reader's list. */
export async function remove(entryId: number): Promise<void> {
  await gql('mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }', { id: entryId });
}

export const scoreMax = (f: ScoreFormat): number => (f === 'POINT_100' ? 100 : f === 'POINT_5' ? 5 : f === 'POINT_3' ? 3 : 10);
export const scoreStep = (f: ScoreFormat): number => (f === 'POINT_10_DECIMAL' ? 0.1 : 1);
export const dateOf = (d?: AlDate): string => (d?.year ? `${d.year}-${String(d.month ?? 1).padStart(2, '0')}-${String(d.day ?? 1).padStart(2, '0')}` : '');
export const toAlDate = (iso: string): AlDate | undefined => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return m ? { year: +m[1], month: +m[2], day: +m[3] } : undefined; };
export const today = (): AlDate => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }; };
