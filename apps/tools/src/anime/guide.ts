// What the Seanime community's Season Guide and Anime Diary plugins do, here in the Anime tab: a season sorted
// «for you» (each show's genres and tags weighed by how you scored what you finished, dropped or are watching),
// the season's top ten as S/A/B/C tiers (AniList's score weighted by how many voted, popularity early in a
// season), and the diary — every episode you logged on AniList as a calendar heatmap, the shows you left
// unfinished, and the year in review.
import * as al from '../anilist';

type ListRaw = { status: al.AlStatus; score: number; progress: number; updatedAt?: number; media: { id: number; genres?: string[]; tags?: { name: string; rank: number }[]; averageScore?: number; episodes?: number | null; duration?: number | null; studios?: { nodes: { name: string }[] }; title: { userPreferred?: string; romaji?: string }; coverImage?: { large?: string }; nextAiringEpisode?: { episode: number } | null; status?: string } };
let tasteCache: { at: number; w: Map<string, number> } | null = null;

/** The user's taste: each genre and tag, weighed by their scores (or by status when they do not score). */
export async function taste(): Promise<Map<string, number>> {
  if (tasteCache && Date.now() - tasteCache.at < 6 * 3600000) return tasteCache.w;
  const u = al.user(); const w = new Map<string, number>(); if (!u) return w;
  const d = await al.gql<{ MediaListCollection: { lists: { entries: ListRaw[] }[] } }>('query ($user: Int) { MediaListCollection(userId: $user, type: ANIME) { lists { entries { status score(format: POINT_100) progress media { id genres tags { name rank } } } } } }', { user: u.id });
  for (const l of d.MediaListCollection.lists) for (const e of l.entries) {
    const base = e.score ? (e.score - 60) / 40 : e.status === 'COMPLETED' ? 0.5 : e.status === 'CURRENT' || e.status === 'REPEATING' ? 0.4 : e.status === 'DROPPED' ? -0.6 : e.status === 'PAUSED' ? 0 : 0.1;
    for (const g of e.media.genres ?? []) w.set(`g:${g}`, (w.get(`g:${g}`) ?? 0) + base);
    for (const tg of e.media.tags ?? []) if (tg.rank >= 50) w.set(`t:${tg.name}`, (w.get(`t:${tg.name}`) ?? 0) + base * (tg.rank / 100) * 0.6);
  }
  const max = Math.max(1, ...[...w.values()].map(Math.abs)); for (const [k, v] of w) w.set(k, v / max);
  tasteCache = { at: Date.now(), w }; return w;
}
/** How well a show fits the taste, 0–100. */
export function fit(a: al.Anime & { tags?: { name: string; rank: number }[] }, w: Map<string, number>): number {
  let s = 0, n = 0; for (const g of a.genres) { s += w.get(`g:${g}`) ?? 0; n++; } for (const tg of a.tags ?? []) if (tg.rank >= 50) { s += (w.get(`t:${tg.name}`) ?? 0) * (tg.rank / 100); n += 0.5; }
  return Math.round(Math.max(0, Math.min(100, 50 + (n ? (s / n) * 50 : 0))));
}
/** The season's top ten in tiers: a Bayesian average of the score (so a few votes do not top the list), with
 *  popularity standing in while scores are still thin. */
export function tiers(list: al.Anime[]): { tier: 'S' | 'A' | 'B' | 'C'; a: al.Anime }[] {
  const scored = list.filter((a) => a.score || a.popularity); const mean = scored.reduce((s, a) => s + (a.score ?? 0), 0) / Math.max(1, scored.filter((a) => a.score).length) || 70;
  const maxPop = Math.max(1, ...scored.map((a) => a.popularity ?? 0));
  const val = (a: al.Anime) => { const votes = (a.popularity ?? 0) / 20; const bayes = a.score ? (votes * a.score + 400 * mean) / (votes + 400) : mean - 5; return bayes * 0.8 + ((a.popularity ?? 0) / maxPop) * 20; };
  return [...scored].sort((x, y) => val(y) - val(x)).slice(0, 10).map((a, i) => ({ tier: i < 2 ? 'S' : i < 5 ? 'A' : i < 8 ? 'B' : 'C', a }));
}

/* ---------- the diary ---------- */
export interface DiaryDay { date: string; items: { id: number; title: string; cover?: string; episodes: number[]; status: string }[] }
type Act = { createdAt: number; progress: string | null; status: string; media: { id: number; title: { userPreferred?: string }; coverImage?: { medium?: string }; duration?: number | null; genres?: string[]; studios?: { nodes: { name: string }[] } } };
/** Every list activity of the user (AniList keeps them), up to a few thousand, newest first. */
export async function activities(maxPages = 12): Promise<Act[]> {
  const u = al.user(); if (!u) return []; const out: Act[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const d = await al.gql<{ Page: { pageInfo: { hasNextPage: boolean }; activities: (Act | Record<string, never>)[] } }>('query ($user: Int, $page: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } activities(userId: $user, type: ANIME_LIST, sort: ID_DESC) { ... on ListActivity { createdAt progress status media { id title { userPreferred } coverImage { medium } duration genres studios(isMain: true) { nodes { name } } } } } } }', { user: u.id, page });
    for (const a of d.Page.activities) if ((a as Act).media) out.push(a as Act);
    if (!d.Page.pageInfo.hasNextPage) break;
  }
  return out;
}
/** «3 - 5» → [3, 4, 5]; «12» → [12]. */
const epsOf = (p: string | null): number[] => { if (!p) return []; const m = /(\d+)\s*-\s*(\d+)/.exec(p); if (m) { const a = Number(m[1]), b = Number(m[2]); return b >= a && b - a < 200 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [b]; } const n = Number(p); return n ? [n] : []; };
export function diaryDays(acts: Act[]): Map<string, DiaryDay> {
  const days = new Map<string, DiaryDay>();
  for (const a of acts) {
    const d = new Date(a.createdAt * 1000); const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const day = days.get(key) ?? days.set(key, { date: key, items: [] }).get(key)!;
    const eps = /watched episode|rewatched episode/.test(a.status) ? epsOf(a.progress) : [];
    let it = day.items.find((x) => x.id === a.media.id); if (!it) { it = { id: a.media.id, title: a.media.title.userPreferred ?? '', cover: a.media.coverImage?.medium, episodes: [], status: a.status }; day.items.push(it); }
    it.episodes.push(...eps); if (/completed|dropped/.test(a.status)) it.status = a.status;
  }
  return days;
}
export interface YearReview { year: number; episodes: number; minutes: number; shows: number; completed: number; longestStreak: number; busiest?: { date: string; episodes: number }; months: number[]; weekdays: number[]; genres: [string, number][]; studios: [string, number][]; top: [string, number][] }
export function yearReview(acts: Act[], year: number): YearReview {
  const r: YearReview = { year, episodes: 0, minutes: 0, shows: 0, completed: 0, longestStreak: 0, months: Array(12).fill(0), weekdays: Array(7).fill(0), genres: [], studios: [], top: [] };
  const shows = new Map<number, { title: string; eps: number }>(); const genres = new Map<string, number>(); const studios = new Map<string, number>(); const perDay = new Map<string, number>();
  for (const a of acts) {
    const d = new Date(a.createdAt * 1000); if (d.getFullYear() !== year) continue;
    const eps = /watched episode|rewatched episode/.test(a.status) ? epsOf(a.progress).length : 0; if (/completed/.test(a.status)) r.completed++;
    if (!eps) continue;
    r.episodes += eps; r.minutes += eps * (a.media.duration ?? 24); r.months[d.getMonth()] += eps; r.weekdays[d.getDay()] += eps;
    const key = d.toISOString().slice(0, 10); perDay.set(key, (perDay.get(key) ?? 0) + eps);
    const s = shows.get(a.media.id) ?? { title: a.media.title.userPreferred ?? '', eps: 0 }; s.eps += eps; shows.set(a.media.id, s);
    for (const g of a.media.genres ?? []) genres.set(g, (genres.get(g) ?? 0) + eps); for (const st of a.media.studios?.nodes ?? []) studios.set(st.name, (studios.get(st.name) ?? 0) + eps);
  }
  r.shows = shows.size; r.top = [...shows.values()].sort((a, b) => b.eps - a.eps).slice(0, 5).map((s) => [s.title, s.eps]);
  r.genres = [...genres].sort((a, b) => b[1] - a[1]).slice(0, 5); r.studios = [...studios].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const busiest = [...perDay].sort((a, b) => b[1] - a[1])[0]; if (busiest) r.busiest = { date: busiest[0], episodes: busiest[1] };
  const dates = [...perDay.keys()].sort(); let run = 0, prev = 0; for (const k of dates) { const t = Date.parse(k); run = prev && t - prev === 86400000 ? run + 1 : 1; prev = t; r.longestStreak = Math.max(r.longestStreak, run); }
  return r;
}
/** Shows started and left: watching or paused, by when last touched, with how far behind an airing one is. */
export async function unfinished(): Promise<{ a: al.Anime; behind: number; updatedAt: number }[]> {
  const u = al.user(); if (!u) return [];
  const d = await al.gql<{ MediaListCollection: { lists: { entries: (ListRaw & { updatedAt: number })[] }[] } }>('query ($user: Int) { MediaListCollection(userId: $user, type: ANIME, status_in: [CURRENT, PAUSED, REPEATING]) { lists { entries { status score progress updatedAt media { id title { userPreferred romaji } coverImage { large } episodes status nextAiringEpisode { episode } genres } } } } }', { user: u.id });
  const out: { a: al.Anime; behind: number; updatedAt: number }[] = [];
  for (const l of d.MediaListCollection.lists) for (const e of l.entries) {
    const aired = e.media.nextAiringEpisode ? e.media.nextAiringEpisode.episode - 1 : e.media.episodes ?? e.progress;
    const a = { id: e.media.id, title: e.media.title.userPreferred ?? e.media.title.romaji ?? '', cover: e.media.coverImage?.large, genres: e.media.genres ?? [], synonyms: [], isAdult: false, url: '', episodes: e.media.episodes, entry: { status: e.status, progress: e.progress, score: e.score } } as al.Anime;
    out.push({ a, behind: Math.max(0, aired - e.progress), updatedAt: e.updatedAt });
  }
  return out.sort((x, y) => y.updatedAt - x.updatedAt);
}
