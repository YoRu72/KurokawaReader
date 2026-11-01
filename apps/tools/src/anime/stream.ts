// Seanime's online-streaming extensions, run here: a show looked for on the extension's site (matched to the
// AniList entry by its titles and year, the match remembered and changeable), its episodes listed, and an
// episode's server asked for its video links — an MP4 or an HLS playlist, with the headers the site wants and
// any subtitles. What comes back is played in the app's player (through the local server that adds those
// headers) or downloaded with yt-dlp.
import { providers, load, type ProviderEntry, type SeanimeClass } from './providers';
import { similar } from './anitomy';
import { titlesOf, type Anime } from '../anilist';
import { ktPlugin } from '../native';

export interface StreamHit { id: string; title: string; url: string; subOrDub: 'sub' | 'dub' | 'both' }
export interface StreamEpisode { id: string; number: number; url: string; title?: string }
export interface StreamSource { url: string; type: 'mp4' | 'm3u8' | 'unknown'; quality: string; label?: string; subtitles: { id: string; url: string; language: string; isDefault: boolean }[] }
export interface StreamServer { server: string; headers: Record<string, string>; videoSources: StreamSource[] }
type Inst = InstanceType<SeanimeClass>;

export async function streamProviders(): Promise<ProviderEntry[]> { return (await providers()).filter((p) => p.enabled && p.role === 'stream'); }
const insts = new Map<string, Inst>();
async function inst(p: ProviderEntry): Promise<Inst> {
  let i = insts.get(p.id); if (i) return i;
  const cls = await load(p); if (!(cls as SeanimeClass).__seanime) throw new Error(`${p.name}: not a streaming extension`);
  i = new (cls as SeanimeClass)(); insts.set(p.id, i); return i;
}
const timeout = <T>(x: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([x, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out`)), ms))]);
export async function settingsOf(p: ProviderEntry): Promise<{ episodeServers: string[]; supportsDub: boolean }> { const s = (await inst(p)).getSettings?.() ?? {}; return { episodeServers: s.episodeServers ?? [], supportsDub: !!s.supportsDub }; }

const mediaOf = (a: Anime) => ({ id: a.id, idMal: a.idMal, status: a.status, format: a.format, englishTitle: a.titleEnglish, romajiTitle: a.titleRomaji, episodeCount: a.episodes ?? -1, absoluteSeasonOffset: 0, synonyms: a.synonyms ?? [], isAdult: a.isAdult, startDate: a.startDate });
export async function search(p: ProviderEntry, a: Anime, dub: boolean, query?: string): Promise<StreamHit[]> {
  const i = await inst(p); const q = query ?? (a.titleRomaji || a.title);
  const r = await timeout(i.search({ media: mediaOf(a), query: q, dub, year: a.startDate?.year }), 25000, p.name);
  return (r as StreamHit[]).filter((x) => x && x.id).map((x) => ({ id: String(x.id), title: String(x.title ?? ''), url: String(x.url ?? ''), subOrDub: x.subOrDub ?? 'sub' }));
}
/** The best hit for a show: its titles compared with each hit's (a season number has to agree), a dub wanted or not. */
export function bestHit(hits: StreamHit[], a: Anime, dub: boolean): StreamHit | null {
  const titles = titlesOf(a); const season = (s: string) => Number(/(?:season|s)\s*(\d+)|(\d+)(?:st|nd|rd|th)\s+season/i.exec(s)?.slice(1).find(Boolean) ?? 1);
  const want = Math.max(...titles.map(season));
  const scored = hits.map((h) => ({ h, sc: Math.max(...titles.map((t) => similar(t, h.title))) - (season(h.title) !== want ? 0.3 : 0) + (dub ? (h.subOrDub !== 'sub' ? 0.05 : -0.2) : h.subOrDub !== 'dub' ? 0.05 : -0.2) })).sort((x, y) => y.sc - x.sc);
  return scored[0] && scored[0].sc >= 0.55 ? scored[0].h : null;
}
/* the match per show, extension and dub: kept so a wrong one is corrected once */
const MKEY = 'kt.stream.match';
type Matches = Record<string, StreamHit>;
const readM = (): Matches => { try { return JSON.parse(localStorage.getItem(MKEY) ?? '{}') as Matches; } catch { return {}; } };
const mk = (p: ProviderEntry, a: Anime, dub: boolean) => `${p.id}|${a.id}|${dub ? 'dub' : 'sub'}`;
export const savedMatch = (p: ProviderEntry, a: Anime, dub: boolean): StreamHit | undefined => readM()[mk(p, a, dub)];
export function saveMatch(p: ProviderEntry, a: Anime, dub: boolean, h: StreamHit): void { const m = readM(); m[mk(p, a, dub)] = h; try { localStorage.setItem(MKEY, JSON.stringify(m)); } catch { /* full */ } }
/** The show on this extension: the saved match, else the best search hit (saved). Null when nothing fits. */
export async function matchShow(p: ProviderEntry, a: Anime, dub: boolean): Promise<{ hit: StreamHit | null; hits: StreamHit[] }> {
  const had = savedMatch(p, a, dub); if (had) return { hit: had, hits: [] };
  let hits = await search(p, a, dub);
  if (!hits.length && a.titleEnglish && a.titleEnglish !== (a.titleRomaji || a.title)) hits = await search(p, a, dub, a.titleEnglish);
  const hit = bestHit(hits, a, dub); if (hit) saveMatch(p, a, dub, hit);
  return { hit, hits };
}
const epCache = new Map<string, Promise<StreamEpisode[]>>();
export function episodes(p: ProviderEntry, id: string): Promise<StreamEpisode[]> {
  const k = `${p.id}|${id}`; let e = epCache.get(k);
  if (!e) { e = (async () => { const i = await inst(p); if (!i.findEpisodes) throw new Error(`${p.name}: no episodes`); const r = (await timeout(i.findEpisodes(id), 25000, p.name)) as StreamEpisode[]; return r.filter((x) => x && x.id).map((x) => ({ id: String(x.id), number: Number(x.number) || 0, url: String(x.url ?? ''), title: x.title })).sort((x, y) => x.number - y.number); })(); epCache.set(k, e); e.catch(() => epCache.delete(k)); }
  return e;
}
export async function server(p: ProviderEntry, ep: StreamEpisode, name: string): Promise<StreamServer> {
  const i = await inst(p); if (!i.findEpisodeServer) throw new Error(`${p.name}: no servers`);
  const r = (await timeout(i.findEpisodeServer(ep, name), 30000, p.name)) as StreamServer;
  const sources = (r?.videoSources ?? []).filter((v) => v && v.url).map((v) => ({ url: String(v.url), type: (['mp4', 'm3u8'].includes(v.type) ? v.type : /\.m3u8(\?|$)/i.test(v.url) ? 'm3u8' : 'unknown') as StreamSource['type'], quality: String(v.quality ?? ''), label: v.label, subtitles: (v.subtitles ?? []).filter((s) => s && s.url) }));
  if (!sources.length) throw new Error(`${p.name}: no video on ${name || 'this server'}`);
  return { server: r.server || name, headers: r.headers ?? {}, videoSources: sources.sort((x, y) => (parseInt(y.quality) || 0) - (parseInt(x.quality) || 0)) };
}
/** The first server that answers with a video, the servers tried in the extension's order (the chosen first). */
export async function anyServer(p: ProviderEntry, ep: StreamEpisode, prefer?: string): Promise<StreamServer> {
  const { episodeServers } = await settingsOf(p); const order = [...new Set([prefer ?? '', ...episodeServers].filter(Boolean))]; if (!order.length) order.push('');
  let last: unknown = null; for (const s of order) { try { return await server(p, ep, s); } catch (e) { last = e; } }
  throw last instanceof Error ? last : new Error(String(last));
}

/** The address a player reads: the source through the local server that sends its headers (and, on the desktop,
 *  turns HLS into MP4); as it is when it needs nothing and plays by itself. */
export async function playableUrl(src: StreamSource, headers: Record<string, string>): Promise<string> {
  const needs = Object.keys(headers).length > 0; const hls = src.type === 'm3u8';
  const d = window.kurokawaTools as unknown as { proxyUrl?: (o: { url: string; headers: Record<string, string> }) => Promise<string> } | undefined;
  if (d?.proxyUrl) {
    // (HLS is turned into MP4 by ffmpeg on the computer.)
    if (hls) { const { ensurePacks } = await import('../packs'); const { t } = await import('../i18n'); if (!(await ensurePacks(['ffmpeg'], t('packWhyStream')))) throw new Error(t('cancelled')); }
    return needs || hls ? d.proxyUrl({ url: src.url, headers }) : src.url;
  }
  const p = ktPlugin() as unknown as { proxyUrl?: (o: { url: string; headers: Record<string, string> }) => Promise<{ url: string }> } | null;
  if (p?.proxyUrl && needs) return (await p.proxyUrl({ url: src.url, headers })).url;
  return src.url;
}
