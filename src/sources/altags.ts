// Genres and tags for a web folder of light novels that has none of its own (OTL): each series found on AniList
// by its name — the novel, not the manga or the anime — and its genres and best tags kept with the folder, so
// its shelf can be filtered by genre and searched by tag ("isekai", "villainess"). Asked out of sight, a few
// series a request and a request every couple of seconds (AniList allows some thirty a minute), and kept for a
// month; a series AniList does not know is remembered as such and not asked again for a week.
import { localHttp } from '../localai';
import { db } from '../db';
import { searchName, buildQuery, pick, type Raw, type Tag } from './altagsmatch';
export { searchName, type Tag };

export interface SeriesTags { id: number; genres: string[]; tags: Tag[]; score?: number; country?: string }
type Kept = { v: 2; at: Record<string, number>; tags: Record<string, SeriesTags | null> };

const API = 'https://graphql.anilist.co';
// (v2: every tag with its rank and category, and the country the series comes from; the first kept only the
// best few, and is asked again.)
const KEY = (repoKey: string) => `al:tags2:${repoKey}`;
const MONTH = 30 * 86400000, WEEK = 7 * 86400000;
const mem = new Map<string, Kept>();
const running = new Set<string>();

export async function loadTags(repoKey: string): Promise<Kept> {
  const had = mem.get(repoKey); if (had) return had;
  const k = (await db.getMeta<Kept>(KEY(repoKey)).catch(() => undefined)) ?? { v: 2, at: {}, tags: {} };
  mem.set(repoKey, k);
  return k;
}
/** What is known now, without waiting (null before the first load). */
export const tagsNow = (repoKey: string): Kept | null => mem.get(repoKey) ?? null;

/** One request for several series (each its own search under an alias). */
async function ask(names: string[]): Promise<{ results: (Raw[] | null)[]; others?: (Raw[] | null)[]; wait?: number }> {
  const { query, variables } = buildQuery(names);
  const r = await localHttp(API, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }), timeoutMs: 25000 });
  if (r.status === 429) return { results: [], wait: Math.min(90, Number((r as { headers?: Record<string, string> }).headers?.['retry-after'] ?? 60) || 60) * 1000 };
  if (r.status >= 400) throw new Error(`AniList: HTTP ${r.status}`);
  const json = JSON.parse(r.body) as { data?: Record<string, { media?: Raw[] } | null> };
  return { results: names.map((_, i) => json.data?.[`s${i}`]?.media ?? null), others: names.map((_, i) => json.data?.[`t${i}`]?.media ?? null) };
}

/** The series of a folder that are not yet known (or known too long ago) looked up, a few at a time; `changed`
 *  is told after each answer that taught something. Runs once at a time per folder; stops when `live` says so. */
export async function fillTags(repoKey: string, series: { rel: string; name: string }[], changed: () => void, live: () => boolean = () => true): Promise<void> {
  if (running.has(repoKey)) return;
  running.add(repoKey);
  try {
    const k = await loadTags(repoKey);
    const now = Date.now();
    const due = series.filter((s) => { const at = k.at[s.rel]; if (!at) return true; return now - at > (k.tags[s.rel] ? MONTH : WEEK); });
    const BATCH = 8;
    for (let i = 0; i < due.length && live(); ) {
      const batch = due.slice(i, i + BATCH);
      let got: Awaited<ReturnType<typeof ask>>;
      try { got = await ask(batch.map((s) => searchName(s.name))); }
      catch { await new Promise((r) => setTimeout(r, 15000)); i += BATCH; continue; }
      if (got.wait) { await new Promise((r) => setTimeout(r, got.wait)); continue; }
      let learnt = false;
      batch.forEach((s, j) => {
        const found = pick(searchName(s.name), got.results[j], s.name, got.others?.[j]);
        k.at[s.rel] = Date.now(); k.tags[s.rel] = found; if (found) learnt = true;
      });
      await db.setMeta(KEY(repoKey), k).catch(() => undefined);
      if (learnt) changed();
      i += BATCH;
      await new Promise((r) => setTimeout(r, (globalThis as { krTagsPace?: number }).krTagsPace ?? 2200));
    }
  } finally { running.delete(repoKey); }
}

/** Every tag a folder's series have (those that give a story away left out), by name. */
export function tagsOfAll(k: Kept): string[] {
  const n = new Set<string>();
  for (const v of Object.values(k.tags)) for (const tg of v?.tags ?? []) if (!tg.s) n.add(tg.n);
  return [...n].sort((a, b) => a.localeCompare(b));
}
/** The countries a folder's series come from, as the shelf's Type filter offers them. */
export const ORIGINS = ['JP', 'KR', 'CN', 'OTHER'] as const;
export const originOf = (t: SeriesTags | null | undefined): (typeof ORIGINS)[number] | undefined => (!t?.country ? undefined : t.country === 'JP' || t.country === 'KR' ? t.country : t.country === 'CN' || t.country === 'TW' || t.country === 'HK' ? 'CN' : 'OTHER');

/** The genres a folder's series have, the most common first. */
export function genresOf(k: Kept): string[] {
  const n = new Map<string, number>();
  for (const v of Object.values(k.tags)) for (const g of v?.genres ?? []) n.set(g, (n.get(g) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g);
}
