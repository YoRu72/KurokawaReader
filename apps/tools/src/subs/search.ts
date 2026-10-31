// Subtitles from every installed source at once (the Subtitles add-on's children, kind `subtitle-source`):
// each module exports `search(query, ctx)` and may export `resolve(result, query, ctx)` for a link that is
// only handed out on request. Results are normalised, deduplicated and ranked: the wanted languages in the
// user's order, then matching episode, then popularity.
import { loadIndex, installed, moduleUrl, addonSettings, type AddonEntry } from '../addons';
import { addonFetch } from '../http';
import { getSettings } from '../settings';
import type { TitleCard } from './lookup';

export interface SubQuery { title: string; titles: string[]; year?: number; kind: 'anime' | 'movie' | 'series'; imdbId?: string; anilistId?: number; malId?: number; tvdbId?: number; anidbAid?: number; season?: number; episode?: number; languages: string[]; fetch: (u: string, i?: RequestInit) => Promise<Response> }
export interface SubResult { title: string; note?: string; language?: string; site: string; url?: string; page?: string; hi?: boolean; partial?: boolean; ai?: boolean; downloads?: number; rating?: number; season?: number; episode?: number; archive?: 'zip' | 'rar' | '7z' | 'xz'; size?: number; resolve?: Record<string, unknown>; addon: string }
type Mod = { search(q: SubQuery, ctx: { settings: Record<string, unknown>; lang: string }): Promise<SubResult[]>; resolve?(r: SubResult, q: SubQuery, ctx: { settings: Record<string, unknown> }): Promise<{ url: string; name?: string }> };

const mods = new Map<string, Promise<Mod>>();
async function load(id: string): Promise<Mod> {
  let m = mods.get(id);
  if (!m) { m = (async () => { const u = await moduleUrl(id); if (!u) throw new Error('not installed'); try { const mod = (await import(/* @vite-ignore */ u)) as { default?: Mod } & Mod; return mod.default ?? mod; } finally { URL.revokeObjectURL(u); } })(); mods.set(id, m); }
  return m;
}
export async function subtitleSources(): Promise<AddonEntry[]> {
  const ix = await loadIndex().catch(() => null); if (!ix) return [];
  return ix.addons.filter((a) => a.kind === 'subtitle-source' && a.module && installed(a.id));
}
export function queryFor(c: TitleCard, season: number | undefined, episode: number | undefined, languages: string[]): SubQuery {
  return { title: c.title, titles: c.titles, year: c.year, kind: c.kind, imdbId: c.ids.imdb, anilistId: c.ids.anilist, malId: c.ids.mal, tvdbId: c.ids.tvdb, anidbAid: c.ids.anidb, season: c.kind === 'series' ? season ?? 1 : season, episode, languages, fetch: addonFetch() as SubQuery['fetch'] };
}
const timeout = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out`)), ms))]);

/** Every source asked at once; each one's results (or error) reported as it answers. */
export async function searchSubtitles(q: SubQuery, onEach: (a: AddonEntry, res: SubResult[] | Error) => void): Promise<SubResult[]> {
  const srcs = await subtitleSources(); const all: SubResult[] = []; const seen = new Set<string>();
  await Promise.all(srcs.map(async (a) => {
    try {
      const m = await load(a.id);
      const rows = await timeout(m.search(q, { settings: addonSettings(a), lang: getSettings().subLangs[0] ?? 'en' }), 25000, a.name);
      const fresh: SubResult[] = [];
      for (const r of rows) { if (!r || !r.title) continue; const k = `${a.id}|${r.url ?? r.page ?? JSON.stringify(r.resolve ?? r.title)}`; if (seen.has(k)) continue; seen.add(k); const x = { ...r, addon: a.id, language: r.language?.toLowerCase().slice(0, 2) }; fresh.push(x); all.push(x); }
      onEach(a, fresh);
    } catch (e) { onEach(a, e as Error); }
  }));
  return all;
}
/** The direct link of a result (asked of the source when it only hands them out on request). */
export async function resolveLink(r: SubResult, q: SubQuery): Promise<{ url: string; name?: string }> {
  if (r.url) return { url: r.url };
  const ix = await loadIndex(); const a = ix.addons.find((x) => x.id === r.addon); if (!a) throw new Error(r.site);
  const m = await load(a.id); if (!m.resolve) throw new Error(`${r.site}: no link`);
  return m.resolve(r, q, { settings: addonSettings(a) });
}
export function rankSubs(rs: SubResult[], langs: string[], episode?: number): SubResult[] {
  const li = (l?: string) => { const i = l ? langs.indexOf(l) : -1; return i < 0 ? 99 : i; };
  const ep = (r: SubResult) => (episode && r.episode !== undefined ? (r.episode === episode ? 0 : 1) : 0);
  return [...rs].sort((a, b) => li(a.language) - li(b.language) || ep(a) - ep(b) || (a.partial ? 1 : 0) - (b.partial ? 1 : 0) || (b.downloads ?? 0) - (a.downloads ?? 0));
}
