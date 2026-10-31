// Discover (LNReader's): light novels trending on AniList, the most popular and the best rated — each a tap away
// from a search of every source the reader has for it. Asked once every few hours and kept meanwhile.
import { localHttp } from '../localai';

export interface Found { id: number; title: string; alt?: string; cover?: string; score?: number }
export type Row = 'trending' | 'popular' | 'top';
const SORT: Record<Row, string> = { trending: 'TRENDING_DESC', popular: 'POPULARITY_DESC', top: 'SCORE_DESC' };
const KEY = 'kr.discover'; const AGE = 6 * 3600000;

export async function discover(): Promise<Record<Row, Found[]>> {
  try { const k = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { at: number; rows: Record<Row, Found[]> } | null; if (k && Date.now() - k.at < AGE && k.rows.trending?.length) return k.rows; } catch { /* asked again */ }
  const part = (r: Row) => `${r}: Page(perPage: 24) { media(type: MANGA, format: NOVEL, sort: ${SORT[r]}, isAdult: false) { id title { romaji english } coverImage { large } averageScore } }`;
  const query = `query { ${(Object.keys(SORT) as Row[]).map(part).join(' ')} }`;
  const res = await localHttp('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query }), timeoutMs: 20000 });
  if (res.status >= 400) throw new Error(`AniList: HTTP ${res.status}`);
  type M = { id: number; title: { romaji?: string; english?: string }; coverImage?: { large?: string }; averageScore?: number };
  const j = JSON.parse(res.body) as { data?: Record<Row, { media?: M[] }> };
  const rows = {} as Record<Row, Found[]>;
  for (const r of Object.keys(SORT) as Row[]) rows[r] = (j.data?.[r]?.media ?? []).map((m) => ({ id: m.id, title: m.title.english || m.title.romaji || '', alt: m.title.english && m.title.romaji && m.title.romaji !== m.title.english ? m.title.romaji : undefined, cover: m.coverImage?.large, score: m.averageScore })).filter((x) => x.title);
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), rows })); } catch { /* asked again next time */ }
  return rows;
}
