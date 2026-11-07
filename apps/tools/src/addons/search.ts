// The torrent-search add-ons run together: each module exports `search(query, ctx)` → results; when a work has
// been picked (from AniList or IMDb), `ctx.title` carries its ids, season and episode so a source that can
// search by id (Torrentio, EZTV, YTS) does, and the others are asked by name. Only add-ons of kind
// `torrent-search` are asked here (subtitle and anime sources have their own pages and shapes).
import { toast } from '../ui/dom';
import { t } from '../i18n';
import { getEngine } from '../engine';
import { moduleUrl, loadIndex, installed, addonSettings, type AddonEntry } from '../addons';
import { getLang } from '../i18n';
import { addonFetch } from '../http';
import { getSettings } from '../settings';

export interface TitleCtx { kind: 'anime' | 'movie' | 'series'; title: string; titles: string[]; year?: number; imdb?: string; anilist?: number; mal?: number; kitsu?: number; season?: number; episode?: number }
export interface SearchResult { title: string; magnet?: string; url?: string; torrent?: string; size?: number; seeds?: number; peers?: number; date?: string; source: string; link?: string; quality?: string; meta?: Record<string, unknown> }
export interface SearchModule { search(query: string, ctx: { fetch: typeof fetch; lang: string; settings: Record<string, string | number | boolean>; title?: TitleCtx }): Promise<SearchResult[]> }

export async function searchSources(): Promise<AddonEntry[]> {
  const ix = await loadIndex().catch(() => null); if (!ix) return [];
  return ix.addons.filter((a) => a.kind === 'torrent-search' && !!a.module && installed(a.id));
}
const mods = new Map<string, Promise<SearchModule>>();
async function load(id: string): Promise<SearchModule> {
  let m = mods.get(id);
  if (!m) { m = (async () => { const u = await moduleUrl(id); if (!u) throw new Error('not installed'); try { const mod = (await import(/* @vite-ignore */ u)) as SearchModule & { default?: SearchModule }; return mod.default ?? mod; } finally { URL.revokeObjectURL(u); } })(); mods.set(id, m); m.catch(() => mods.delete(id)); }
  return m;
}
const timeout = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: ${t('timedOut')}`)), ms))]);

/** The sources' modules loaded ahead (the search page opening), so the first search does not wait on them. */
export async function warmSources(): Promise<void> { for (const a of await searchSources()) void load(a.id).catch(() => undefined); }
// (What a source answered for a query, kept ten minutes: the same search again — back, a picked work dropped — is
// drawn at once.)
const answered = new Map<string, { at: number; rows: SearchResult[] }>();
const ANSWER_MS = 10 * 60_000;

/** Every source at once; each one's results (or its error) reported as it answers; one copy of a torrent kept. */
export async function runSearch(query: string, title: TitleCtx | undefined, onEach: (a: AddonEntry, res: SearchResult[] | Error) => void): Promise<SearchResult[]> {
  const srcs = await searchSources(); const all: SearchResult[] = []; const seen = new Map<string, SearchResult>();
  const hashOf = (r: SearchResult) => (/btih:([a-z0-9]{32,40})/i.exec(r.magnet ?? '')?.[1] ?? '').toLowerCase();
  await Promise.all(srcs.map(async (a) => {
    try {
      const key = `${a.id}|${a.version ?? ''}|${JSON.stringify(addonSettings(a))}|${query}|${JSON.stringify(title ?? null)}`; const kept = answered.get(key);
      let rows: SearchResult[];
      if (kept && Date.now() - kept.at < ANSWER_MS) rows = kept.rows;
      else {
        const m = await load(a.id); if (typeof m.search !== 'function') { onEach(a, []); return; }
        rows = (await timeout(m.search(query, { fetch: addonFetch() as unknown as typeof fetch, lang: getLang(), settings: addonSettings(a), title }), 25000, a.name)) ?? [];
        answered.set(key, { at: Date.now(), rows }); if (answered.size > 200) answered.delete(answered.keys().next().value!);
      }
      const fresh: SearchResult[] = [];
      for (const r of rows ?? []) { if (!r?.title || !(r.magnet || r.url || r.torrent)) continue; const k = hashOf(r) || r.url || r.torrent || r.title; const had = seen.get(k); if (had) { had.seeds = Math.max(had.seeds ?? 0, r.seeds ?? 0); continue; } const x = { ...r, source: r.source || a.id }; seen.set(k, x); fresh.push(x); all.push(x); }
      onEach(a, fresh);
    } catch (e) { onEach(a, e as Error); }
  }));
  return all;
}
export async function addResult(r: SearchResult, meta: Record<string, unknown> = {}): Promise<void> {
  try {
    const m = { addon: r.source, title: r.title, quality: r.quality, ...meta };
    if ((r.magnet || r.torrent) && getSettings().debridDefault && getSettings().addons.includes('debrid')) { const { sendToDebrid } = await import('../debrid/transfers'); const d = await sendToDebrid(r.magnet ? { magnet: r.magnet } : { torrent: r.torrent! }, { meta: m }); toast(d.kind === 'cloud' ? t('debridSent', { name: d.name }) : t('taskAdded', { name: d.name })); return; }
    // (A torrent of several files: which of them, asked first — a single file goes straight in.)
    const source = r.magnet ? { magnet: r.magnet } : r.torrent ? { torrent: r.torrent } : { url: r.url! }; let files: number[] | undefined;
    const eng = getEngine();
    if ((r.magnet || r.torrent) && eng.torrentInfo && eng.can.pickFiles) { const { pickFiles } = await import('../views/pickFiles'); const got = await pickFiles(source, r.title); if (got === null) return; files = got === 'all' ? undefined : got; }
    const tk = await eng.add({ source, name: r.magnet || r.torrent ? undefined : r.title, sequential: true, files, meta: m });
    toast(t('taskAdded', { name: tk.name || r.title }));
  } catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); }
}
