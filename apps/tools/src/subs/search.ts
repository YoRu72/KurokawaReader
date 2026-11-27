// Subtitles from every installed source at once (the Subtitles add-on's children, kind `subtitle-source`):
// each module exports `search(query, ctx)` and may export `resolve(result, query, ctx)` for a link that is
// only handed out on request. Results are normalised, deduplicated and ranked: the wanted languages in the
// user's order, then matching episode, then popularity.
import { loadIndex, installed, moduleUrl, addonSettings, type AddonEntry } from '../addons';
import { addonFetch } from '../http';
import { getSettings } from '../settings';
import type { TitleCard } from './lookup';

export interface SubQuery { title: string; titles: string[]; year?: number; kind: 'anime' | 'movie' | 'series'; imdbId?: string; anilistId?: number; malId?: number; tvdbId?: number; anidbAid?: number; season?: number; episode?: number; /** An anime's own episode number (episode/season above follow IMDb when known). */ animeEpisode?: number; languages: string[]; fetch: (u: string, i?: RequestInit) => Promise<Response> }
export interface SubResult { title: string; note?: string; language?: string; site: string; url?: string; page?: string; hi?: boolean; partial?: boolean; ai?: boolean; downloads?: number; rating?: number; season?: number; episode?: number; archive?: 'zip' | 'rar' | '7z' | 'xz'; size?: number; resolve?: Record<string, unknown>; addon: string }
type Mod = { search(q: SubQuery, ctx: { settings: Record<string, unknown>; lang: string }): Promise<SubResult[]>; resolve?(r: SubResult, q: SubQuery, ctx: { settings: Record<string, unknown> }): Promise<{ url: string; name?: string }> };

const mods = new Map<string, Promise<Mod>>();
// (An add-on updated while the app runs: its module is loaded afresh next time — addons.ts says which.)
addEventListener('kt:addon-updated', (e) => { mods.delete(String((e as CustomEvent<string>).detail)); });
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
  const mapped = c.kind === 'anime' && episode ? c.epMap?.[episode] : undefined;
  return { title: c.title, titles: c.titles, year: c.year, kind: c.kind, imdbId: c.ids.imdb, anilistId: c.ids.anilist, malId: c.ids.mal, tvdbId: c.ids.tvdb, anidbAid: c.ids.anidb, season: mapped ? mapped.s : c.kind === 'series' ? season ?? 1 : season, episode: mapped ? mapped.e : episode, animeEpisode: c.kind === 'anime' ? episode : undefined, languages, fetch: addonFetch() as SubQuery['fetch'] };
}
const timeout = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out`)), ms))]);

/** Every source asked at once; each one's results (or error) reported as it answers. */
export async function searchSubtitles(q: SubQuery, onEach: (a: AddonEntry, res: SubResult[] | Error) => void, only?: (a: AddonEntry) => boolean): Promise<SubResult[]> {
  const srcs = (await subtitleSources()).filter((a) => !only || only(a)); const all: SubResult[] = []; const seen = new Set<string>();
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
  const ep = (r: SubResult) => (episode && r.episode !== undefined ? (r.episode === episode ? 0 : 1) : 0);  // (the anime number, or the IMDb one — either counts as the episode)
  return [...rs].sort((a, b) => li(a.language) - li(b.language) || ep(a) - ep(b) || (a.partial ? 1 : 0) - (b.partial ? 1 : 0) || (b.downloads ?? 0) - (a.downloads ?? 0));
}

/* ---------- the player's search: ranked like a pack's files (../player/subMatch) ---------- */
export interface RankedSub { r: SubResult; score: number; /** a season's (or a range's) archive */ pack: boolean; /** in a language the user did not ask for */ otherLang: boolean; applied: boolean; format?: string }
const APPLIED = 'kt.subApplied';
const appliedKey = (show: string, season: number | undefined, episode: number | undefined) => `${show}|${season ?? ''}|${episode ?? ''}`;
const resultId = (r: SubResult) => `${r.addon}|${r.url ?? r.page ?? JSON.stringify(r.resolve ?? r.title)}`;
/** The result applied for an episode, kept (the newest 300). */
export function rememberApplied(show: string, season: number | undefined, episode: number | undefined, r: SubResult): void {
  try { const all = JSON.parse(localStorage.getItem(APPLIED) ?? '{}') as Record<string, { id: string; at: number }>; all[appliedKey(show, season, episode)] = { id: resultId(r), at: Date.now() }; const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 300); localStorage.setItem(APPLIED, JSON.stringify(Object.fromEntries(keep))); } catch { /* full */ }
}
export function appliedFor(show: string, season: number | undefined, episode: number | undefined): string | undefined { try { return (JSON.parse(localStorage.getItem(APPLIED) ?? '{}') as Record<string, { id: string }>)[appliedKey(show, season, episode)]?.id; } catch { return undefined; } }
/** Results ranked for the episode being watched: the one applied before first; this episode's, then a season's pack,
 *  then others; the user's languages in order (others last, marked); the video's own group; .ass before .srt; then
 *  popularity. Duplicates (the same name and language from two sources) kept once. */
export async function rankForEpisode(rs: SubResult[], o: { langs: string[]; episode?: number; season?: number; videoName?: string; applied?: string }): Promise<RankedSub[]> {
  const M = await import('../player/subMatch'); const vg = o.videoName ? M.groupOf(o.videoName) : undefined;
  const seen = new Map<string, RankedSub>(); const out: RankedSub[] = [];
  for (const r of rs) {
    const read = M.subEpisode(`${r.title}${/\.(srt|ass|ssa|vtt)$/i.test(r.title) ? '' : '.srt'}`); const ep = r.episode ?? (read.batch ? undefined : read.episode);
    const pack = read.batch || (!!r.archive && r.episode === undefined && (o.episode === undefined || ep === undefined));
    const lang = r.language ?? M.langOfName(r.title); const li = lang ? o.langs.indexOf(lang) : -1; const otherLang = !!lang && li < 0 && o.langs.length > 0;
    const format = /\bass\b|\.ass$|\.ssa$/i.test(r.title) ? 'ASS' : /\bvtt\b|\.vtt$/i.test(r.title) ? 'VTT' : /\bsrt\b|\.srt$/i.test(r.title) ? 'SRT' : undefined;
    const applied = !!o.applied && resultId(r) === o.applied;
    let sc = applied ? 1000 : 0;
    if (o.episode !== undefined) sc += pack ? 50 : ep === o.episode ? 100 : ep === undefined ? 20 : -50;
    if (o.season !== undefined && r.season !== undefined && r.season !== o.season) sc -= 40;
    sc += li >= 0 ? 40 - 10 * li : otherLang ? -30 : 0;
    const g = M.groupOf(r.title); if (g && vg && g === vg) sc += 10;
    if (format === 'ASS') sc += 3; if (r.partial) sc -= 20; if (r.ai) sc -= 5; sc += Math.min(9, Math.log10((r.downloads ?? 0) + 1) * 2);
    const x: RankedSub = { r, score: sc, pack, otherLang, applied, format };
    const dk = `${r.title.toLowerCase().replace(/\s+/g, ' ').trim()}|${lang ?? ''}|${r.archive ?? ''}`; const was = seen.get(dk);
    if (was) { if (x.score > was.score) { out[out.indexOf(was)] = x; seen.set(dk, x); } continue; }
    seen.set(dk, x); out.push(x);
  }
  return out.sort((a, b) => Number(a.otherLang) - Number(b.otherLang) || b.score - a.score);
}
