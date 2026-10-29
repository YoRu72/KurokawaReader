// Genres and tags for a web folder of light novels that has none of its own (OTL): each series found on AniList
// by its name — the novel, not the manga or the anime — and its genres and best tags kept with the folder, so
// its shelf can be filtered by genre and searched by tag ("isekai", "villainess"). Asked out of sight, a few
// series a request and a request every couple of seconds (AniList allows some thirty a minute), and kept for a
// month; a series AniList does not know is remembered as such and not asked again for a week.
import { localHttp } from '../localai';
import { db } from '../db';
import { searchName, buildQuery, pick, type Raw, type Tag } from './altagsmatch';
export { searchName, type Tag };

export interface SeriesTags { id: number; genres: string[]; tags: Tag[]; score?: number; country?: string; /** AniList's cover: the series' own when its volumes give none */ cover?: string }
type Kept = { v: 2; at: Record<string, number>; tags: Record<string, SeriesTags | null> };

const API = 'https://graphql.anilist.co';
// (v2: every tag with its rank and category, and the country the series comes from; the first kept only the
// best few, and is asked again.)
const KEY = (repoKey: string) => `al:tags2:${repoKey}`;
const MONTH = 30 * 86400000, WEEK = 7 * 86400000;
const mem = new Map<string, Kept>();

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

/* ---------- the series asked for, a queue per folder ---------- */
// (One line per folder: the series on the screen — a card scrolled to, a series' page opened — go to its
// front; the rest of the folder behind them, so its whole shelf can be filtered by tag. What is learnt is kept
// after every answer: a folder half asked for in one session is finished in the next.)
interface Line { order: string[]; names: Map<string, string>; waiting: Map<string, ((t: SeriesTags | null) => void)[]>; changed: Set<(rels: string[]) => void>; running: boolean }
const lines = new Map<string, Line>();
const lineOf = (repoKey: string): Line => { let l = lines.get(repoKey); if (!l) { l = { order: [], names: new Map(), waiting: new Map(), changed: new Set(), running: false }; lines.set(repoKey, l); } return l; };
const due = (k: Kept, rel: string) => { const at = k.at[rel]; return !at || Date.now() - at > (k.tags[rel] ? MONTH : WEEK); };

/** Series to look up: at the back of the folder's line, or (`front`) at its front — those already known left
 *  out. `changed` is told the series each answer taught something about. */
export async function wantTags(repoKey: string, series: { rel: string; name: string }[], front = false, changed?: (rels: string[]) => void): Promise<void> {
  const k = await loadTags(repoKey);
  const l = lineOf(repoKey);
  if (changed) l.changed.add(changed);
  const fresh = series.filter((x) => due(k, x.rel));
  for (const x of fresh) l.names.set(x.rel, x.name);
  if (front) { const set = new Set(fresh.map((x) => x.rel)); l.order = [...fresh.map((x) => x.rel), ...l.order.filter((r) => !set.has(r))]; }
  else { const set = new Set(l.order); for (const x of fresh) if (!set.has(x.rel)) l.order.push(x.rel); }
  if (l.order.length && !l.running) void run(repoKey, l);
}
/** One series' tags: known at once, else asked for first in the line. */
export async function tagsFor(repoKey: string, rel: string, name: string): Promise<SeriesTags | null> {
  const k = await loadTags(repoKey);
  if (!due(k, rel)) return k.tags[rel] ?? null;
  const l = lineOf(repoKey);
  const p = new Promise<SeriesTags | null>((ok) => { const w = l.waiting.get(rel); if (w) w.push(ok); else l.waiting.set(rel, [ok]); });
  await wantTags(repoKey, [{ rel, name }], true);
  return p;
}
/** Whether a folder still has series waiting to be asked about (its shelf, filtered by tag, may grow). */
export const tagsPending = (repoKey: string): number => lines.get(repoKey)?.order.length ?? 0;

async function run(repoKey: string, l: Line): Promise<void> {
  if (l.running) return;
  l.running = true;
  try {
    const k = await loadTags(repoKey);
    const BATCH = 8;
    while (l.order.length) {
      const batch = l.order.slice(0, BATCH).filter((rel) => due(k, rel));
      if (!batch.length) { l.order.splice(0, BATCH); continue; }
      let got: Awaited<ReturnType<typeof ask>>;
      try { got = await ask(batch.map((rel) => searchName(l.names.get(rel) ?? rel))); }
      catch { await new Promise((r) => setTimeout(r, 15000)); l.order = l.order.filter((r) => !batch.includes(r)); l.order.push(...batch); if (!navigator.onLine) break; continue; }
      if (got.wait) { await new Promise((r) => setTimeout(r, got.wait)); continue; }
      const learnt: string[] = [];
      batch.forEach((rel, j) => {
        const name = l.names.get(rel) ?? rel;
        const found = pick(searchName(name), got.results[j], name, got.others?.[j]);
        k.at[rel] = Date.now(); k.tags[rel] = found; if (found) learnt.push(rel);
        for (const ok of l.waiting.get(rel) ?? []) ok(found);
        l.waiting.delete(rel);
      });
      const done = new Set(batch); l.order = l.order.filter((r) => !done.has(r));
      await db.setMeta(KEY(repoKey), k).catch(() => undefined);
      if (learnt.length) for (const fn of l.changed) { try { fn(learnt); } catch { /* a page gone */ } }
      if (l.order.length) await new Promise((r) => setTimeout(r, (globalThis as { krTagsPace?: number }).krTagsPace ?? 2100));
    }
  } finally {
    l.running = false;
    // (Those still waiting when the line stopped — offline — answered with nothing for now.)
    if (!l.order.length) for (const [rel, oks] of l.waiting) { for (const ok of oks) ok(null); l.waiting.delete(rel); }
  }
}

/** The series of a folder that are not yet known (or known too long ago) looked up, behind any asked for
 *  first (kept for the callers of before). */
export async function fillTags(repoKey: string, series: { rel: string; name: string }[], changed: () => void): Promise<void> {
  await wantTags(repoKey, series, false, () => changed());
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
