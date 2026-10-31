// Anime torrent providers: where an episode's torrents are looked for. Three shapes run here —
//  • the repository's own modules (ESM exporting `single/batch/movie` — the Hayase interface);
//  • Hayase extensions (a repository is a JSON array of manifests; `code` is a bundled ESM file whose default
//    export has `test/single/batch/movie(query, options)`; the app's fetch is handed in on the query);
//  • Seanime extensions (a marketplace array or `{urls:[…]}` or one manifest; the payload defines a global
//    class `Provider` with `search/smartSearch/getLatest/getSettings`; the globals it expects — `fetch` with
//    synchronous `text()/json()`, `LoadDoc`, `$habari`, `$goFeed`, `$store`, `$getUserPreference` — are shimmed).
// Every provider is installed by the user from a repository URL (Settings → Anime), kept in IndexedDB, and
// run with a timeout; results are sanitised the Hayase way (a 40/64-hex hash is required).
import { db } from '../db';
import { addonFetch, request } from '../http';
import { getSettings, updateSettings } from '../settings';
import { parseFilename } from './anitomy';
import { idsOf, titlesOf, type Anime } from '../anilist';

export type Accuracy = 'high' | 'medium' | 'low';
export interface AnimeQuery {
  media: Anime; anilistId: number; anidbAid?: number; anidbEid?: number; kitsuId?: number; imdbId?: string; tmdbId?: number; tvdbId?: number;
  titles: string[]; episode: number; episodeCount?: number; absoluteEpisodeNumber?: number;
  resolution: '' | '2160' | '1080' | '720' | '540' | '480'; exclusions: string[];
}
export interface TorrentResult {
  title: string; link: string; hash: string; size: number; seeders: number; leechers: number; downloads: number;
  accuracy: Accuracy; date?: Date; type?: 'batch' | 'best' | 'alt'; provider: string; resolution?: string; episode?: number; group?: string; fileIdx?: number;
  /** A direct URL (a debrid-resolved stream) instead of a torrent. */
  url?: string;
}

export type ProviderFormat = 'module' | 'hayase' | 'seanime';
export interface ProviderEntry {
  id: string; name: string; description?: string; version: string; format: ProviderFormat; icon?: string;
  /** Where the code is (and, for Hayase/Seanime, where the manifest came from). */
  code: string; manifest?: string; repo?: string;
  options?: Record<string, { type: string; description?: string; label?: string; default?: string | number | boolean; values?: unknown[] }>;
  accuracy?: Accuracy; media?: string; languages?: string[]; enabled: boolean; builtin?: boolean;
}
const KEY = 'anime:providers';
let list: ProviderEntry[] | null = null;
export async function providers(): Promise<ProviderEntry[]> { list ??= (await db.getMeta<ProviderEntry[]>(KEY)) ?? []; return list; }
async function keep(l: ProviderEntry[]): Promise<void> { list = l; await db.setMeta(KEY, l); }

/* ---------- installing ---------- */
type HayaseManifest = { manifestVersion: number; id: string; name: string; description?: string; version: string; type: string; accuracy?: Accuracy; icon?: string; media?: string; languages?: string[]; code: string; options?: ProviderEntry['options'] };
type SeanimeManifest = { id: string; name: string; description?: string; version: string; type: string; language?: string; author?: string; icon?: string; manifestURI?: string; payload?: string; payloadURI?: string; userConfig?: { fields?: { type: string; name: string; label: string; default?: string; options?: { value: string; label: string }[] }[] } };
const ghCode = (c: string) => (c.startsWith('gh:') ? `https://esm.sh/gh/${c.slice(3)}/es2022/${c.split('/').slice(3).join('/') || 'index'}.mjs` : c.startsWith('npm:') ? `https://esm.sh/${c.slice(4)}/es2022/index.mjs` : c);

/** Everything a repository URL offers: a Hayase array, a Seanime marketplace array, `{urls:[…]}`, or one manifest. */
export async function readRepo(url: string): Promise<ProviderEntry[]> {
  const r = await request(url); if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  let j: unknown; try { j = JSON.parse(r.body); } catch { throw new Error('not JSON'); }
  const out: ProviderEntry[] = [];
  const takeSea = async (m: SeanimeManifest, from: string) => {
    if (m.type !== 'anime-torrent-provider') return;
    if (!m.payload && !m.payloadURI) { if (m.manifestURI) { const rr = await request(m.manifestURI); if (rr.status === 200) { try { m = { ...m, ...(JSON.parse(rr.body) as SeanimeManifest) }; } catch { return; } } } }
    if (!m.payload && !m.payloadURI) return;
    const options: ProviderEntry['options'] = {};
    for (const f of m.userConfig?.fields ?? []) options[f.name] = { type: f.type === 'switch' ? 'boolean' : f.type === 'select' ? 'select' : 'string', label: f.label, default: f.default, values: f.options?.map((o) => o.value) };
    out.push({ id: `sea:${m.id}`, name: m.name, description: m.description, version: m.version, format: 'seanime', icon: m.icon, code: m.payloadURI ?? `inline:${m.payload}`, manifest: m.manifestURI ?? from, repo: from, options, enabled: true });
  };
  const takeHay = (m: HayaseManifest, from: string) => { if (m.type !== 'torrent' || !m.code) return; out.push({ id: `hay:${m.id}`, name: m.name, description: m.description, version: m.version, format: 'hayase', icon: m.icon, code: ghCode(m.code), repo: from, options: m.options, accuracy: m.accuracy, media: m.media, languages: m.languages, enabled: true }); };
  if (Array.isArray(j)) { for (const m of j as (HayaseManifest & SeanimeManifest)[]) { if ('manifestVersion' in m) takeHay(m, url); else await takeSea(m, url); } }
  else if (j && typeof j === 'object' && Array.isArray((j as { urls?: string[] }).urls)) { for (const u of (j as { urls: string[] }).urls) { try { out.push(...(await readRepo(u))); } catch { /* one bad manifest */ } } }
  else if (j && typeof j === 'object') { const m = j as HayaseManifest & SeanimeManifest; if ('manifestVersion' in m) takeHay(m, url); else await takeSea(m, url); }
  return out;
}
/** Installs (or updates) the providers of a repository: their code fetched and kept. */
export async function installRepo(url: string): Promise<ProviderEntry[]> {
  const found = await readRepo(url); if (!found.length) throw new Error('no anime torrent providers there');
  const cur = await providers();
  for (const p of found) {
    const code = p.code.startsWith('inline:') ? p.code.slice(7) : await (async () => { const r = await request(p.code); if (r.status !== 200) throw new Error(`${p.name}: HTTP ${r.status}`); return r.body; })();
    await db.putFile(`provider:${p.id}`, new Blob([code], { type: 'text/javascript' }));
    const i = cur.findIndex((x) => x.id === p.id); const merged = { ...p, enabled: i >= 0 ? cur[i].enabled : true }; if (i >= 0) cur[i] = merged; else cur.push(merged);
  }
  await keep([...cur]);
  const repos = getSettings().animeRepos; if (!repos.includes(url)) updateSettings({ animeRepos: [...repos, url] });
  return found;
}
export async function removeProvider(id: string): Promise<void> { await db.deleteFile(`provider:${id}`).catch(() => undefined); await keep((await providers()).filter((x) => x.id !== id)); modules.delete(id); }
export async function setEnabled(id: string, on: boolean): Promise<void> { const l = await providers(); const p = l.find((x) => x.id === id); if (p) { p.enabled = on; await keep([...l]); } }
export async function updateAll(): Promise<number> { let n = 0; for (const u of getSettings().animeRepos) { try { n += (await installRepo(u)).length; } catch { /* offline */ } } return n; }
export const optionsOf = (p: ProviderEntry): Record<string, string | number | boolean> => { const out: Record<string, string | number | boolean> = {}; for (const [k, v] of Object.entries(p.options ?? {})) if (v.default !== undefined) out[k] = v.default as string; return { ...out, ...(getSettings().addonSettings[p.code.startsWith('addon:') ? p.code.slice(6) : p.id] ?? {}) }; };

/* ---------- running ---------- */
type HayaseModule = { test?: () => Promise<boolean>; single?: (q: unknown, o?: unknown) => Promise<unknown[]>; batch?: (q: unknown, o?: unknown) => Promise<unknown[]>; movie?: (q: unknown, o?: unknown) => Promise<unknown[]> };
const modules = new Map<string, Promise<HayaseModule | SeanimeClass>>();
type SeanimeClass = { new (): { search(o: unknown): Promise<unknown[]>; smartSearch?(o: unknown): Promise<unknown[]>; getLatest?(): Promise<unknown[]>; getSettings?(): { canSmartSearch?: boolean; smartSearchFilters?: string[] } }; __seanime: true };

/** The providers that came with the Anime add-on (children of kind `anime-provider`): listed from what the
 *  add-on store holds, so installing or removing the add-on is all it takes. */
export async function syncBuiltins(): Promise<void> {
  const { loadIndex, installed } = await import('../addons');
  const ix = await loadIndex().catch(() => null); if (!ix) return;
  const cur = await providers(); let changed = false;
  for (const a of ix.addons) {
    if (a.kind !== 'anime-provider' || !a.module) continue;
    const id = `kurokawa:${a.id}`; const i = cur.findIndex((x) => x.id === id);
    if (installed(a.id)) { if (i < 0) { cur.push({ id, name: a.name, description: a.description, version: a.version, format: 'module', code: `addon:${a.id}`, enabled: true, builtin: true, options: Object.fromEntries((a.settings ?? []).map((f) => [f.id, { type: f.type, label: f.label, default: f.value, values: f.options }])) }); changed = true; } else if (cur[i].version !== a.version) { cur[i] = { ...cur[i], version: a.version, name: a.name, description: a.description }; modules.delete(id); changed = true; } }
    else if (i >= 0) { cur.splice(i, 1); modules.delete(id); changed = true; }
  }
  if (changed) await keep([...cur]);
}
async function load(p: ProviderEntry): Promise<HayaseModule | SeanimeClass> {
  let m = modules.get(p.id);
  if (!m) {
    m = (async () => {
      const b = await db.getFile(p.code.startsWith('addon:') ? p.code : `provider:${p.id}`); if (!b) throw new Error('not installed');
      if (p.format === 'seanime') return seanimeClass(await b.text(), p);
      const u = URL.createObjectURL(b.type === 'text/javascript' ? b : new Blob([b], { type: 'text/javascript' }));
      try { const mod = (await import(/* @vite-ignore */ u)) as { default?: HayaseModule } & HayaseModule; return mod.default ?? mod; } finally { URL.revokeObjectURL(u); }
    })();
    modules.set(p.id, m);
  }
  return m;
}

/** Seanime's payload: TypeScript stripped the cheap way (types only), run with its globals shimmed. */
function seanimeClass(code: string, p: ProviderEntry): SeanimeClass {
  const js = stripTypes(code);
  const shim = seanimeGlobals(p);
  const fn = new Function(...Object.keys(shim), `${js}\n;return typeof Provider !== 'undefined' ? Provider : undefined;`);
  const cls = fn(...Object.values(shim)) as SeanimeClass | undefined;
  if (!cls) throw new Error('no Provider class');
  (cls as { __seanime: boolean }).__seanime = true; return cls;
}
/** Type annotations dropped: enough for the providers seen in the wild (interfaces, `: T`, `as T`, generics on calls). */
function stripTypes(src: string): string {
  return src
    .replace(/^\s*\/\/\/\s*<reference[^\n]*$/gm, '')
    .replace(/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*(?:=\s*)?\{[\s\S]*?\n\}\s*;?/gm, '')
    .replace(/^\s*(?:export\s+)?type\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*=[^\n]*$/gm, '')
    .replace(/^\s*import\s[^\n]*$/gm, '').replace(/^\s*export\s+(?=class|function|const|let|var)/gm, '')
    .replace(/\)\s*:\s*(?:Promise<[^>]*>|[A-Za-z_$][\w$<>\[\]|, ]*)\s*(?={)/g, ') ')
    .replace(/(\b(?:const|let|var)\s+[A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>\[\]|, .]*(?=\s*=)/g, '$1')
    .replace(/\(([^()]*)\)\s*(?==>)/g, (m, a: string) => `(${a.replace(/:\s*[A-Za-z_$][\w$<>\[\]|, .]*(?=[,)]|$)/g, '')})`)
    .replace(/\s+as\s+(?:const|[A-Za-z_$][\w$<>\[\]|.]*)/g, '')
    .replace(/(?<=\w)!(?=[.\[)])/g, '')
    .replace(/(?<=[\w)])<[A-Za-z_$][\w$<>\[\]|, .]*>(?=\()/g, '')
    .replace(/^\s*(?:private|public|protected|readonly)\s+/gm, '');
}
function seanimeGlobals(p: ProviderEntry): Record<string, unknown> {
  const f = addonFetch(); const store = new Map<string, unknown>();
  const fetchShim = async (url: string, init: RequestInit = {}) => { const r = await f(url, init); const body = await r.text(); return { status: r.status, statusText: r.statusText, ok: r.ok, url: r.url || url, headers: Object.fromEntries(r.headers.entries()), text: () => body, json: () => JSON.parse(body) }; };
  const prefs = optionsOf(p);
  return {
    fetch: fetchShim, console,
    LoadDoc: (html: string) => { const doc = new DOMParser().parseFromString(html, 'text/html'); return (sel: string) => selection(Array.from(doc.querySelectorAll(sel))); },
    Doc: class { constructor(html: string) { return (new DOMParser().parseFromString(html, 'text/html') as unknown) as object; } },
    $habari: { parse: parseFilename }, $goFeed: { parse: parseFeed },
    $store: { set: (k: string, v: unknown) => store.set(k, v), get: (k: string) => store.get(k), getUnsafe: (k: string) => store.get(k), has: (k: string) => store.has(k), getOrSet: (k: string, v: () => unknown) => { if (!store.has(k)) store.set(k, v()); return store.get(k); }, reset: () => store.clear(), values: () => [...store.values()], getAll: () => Object.fromEntries(store) },
    $getUserPreference: (k: string) => (prefs[k] === undefined ? undefined : String(prefs[k])), $sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    $torrentUtils: { getMagnetLinkFromTorrentData: () => '' }, $isOffline: () => !navigator.onLine,
    $scannerUtils: { normalizeTitle: (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim(), buildSeasonQuery: (t: string, s: number) => `(${t} S${String(s).padStart(2, '0')} | ${t} Season ${s})`, sanitizeQuery: (s: string) => s.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim() },
  };
}
/** goquery-like selection over DOM elements (what Seanime's `LoadDoc` returns). */
function selection(els: Element[]): Record<string, unknown> {
  const S = (e: Element[]) => selection(e);
  return {
    length: () => els.length, first: () => S(els.slice(0, 1)), last: () => S(els.slice(-1)), eq: (i: number) => S(els.slice(i, i + 1)),
    find: (sel: string) => S(els.flatMap((e) => Array.from(e.querySelectorAll(sel)))), children: (sel?: string) => S(els.flatMap((e) => Array.from(e.children).filter((c) => !sel || c.matches(sel)))),
    parent: () => S(els.map((e) => e.parentElement).filter((x): x is HTMLElement => !!x)), next: () => S(els.map((e) => e.nextElementSibling).filter((x): x is Element => !!x)), prev: () => S(els.map((e) => e.previousElementSibling).filter((x): x is Element => !!x)),
    text: () => els.map((e) => e.textContent ?? '').join(''), html: () => els[0]?.innerHTML ?? '', attr: (n: string) => { const v = els[0]?.getAttribute(n); return v === null || v === undefined ? [undefined, false] : [v, true]; },
    each: (fn: (i: number, s: unknown) => void) => { els.forEach((e, i) => fn(i, S([e]))); }, map: (fn: (i: number, s: unknown) => unknown) => els.map((e, i) => fn(i, S([e]))), filter: (sel: string) => S(els.filter((e) => e.matches(sel))), is: (sel: string) => els.some((e) => e.matches(sel)), has: (sel: string) => S(els.filter((e) => !!e.querySelector(sel))), not: (sel: string) => S(els.filter((e) => !e.matches(sel))), closest: (sel: string) => S(els.map((e) => e.closest(sel)).filter((x): x is Element => !!x)),
  };
}
/** RSS/Atom items the way Seanime's `$goFeed.parse` hands them to providers. */
export function parseFeed(xml: string): { items: { title: string; link: string; published: string; description?: string; guid?: string; enclosures: { url: string; length: string; type?: string }[]; extensions?: Record<string, unknown> }[] } {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const items = Array.from(doc.querySelectorAll('item, entry')).map((it) => {
    const tx = (n: string) => it.getElementsByTagName(n)[0]?.textContent?.trim() ?? '';
    const ext: Record<string, unknown> = {}; for (const c of Array.from(it.children)) if (c.tagName.includes(':')) ext[c.tagName.split(':')[1]] = c.textContent?.trim();
    const enc = Array.from(it.getElementsByTagName('enclosure')).map((e) => ({ url: e.getAttribute('url') ?? '', length: e.getAttribute('length') ?? '0', type: e.getAttribute('type') ?? undefined }));
    return { title: tx('title'), link: tx('link') || it.querySelector('link')?.getAttribute('href') || '', published: tx('pubDate') || tx('published') || tx('updated'), description: tx('description') || undefined, guid: tx('guid') || tx('id') || undefined, enclosures: enc, extensions: ext };
  });
  return { items };
}

/* ---------- the search ---------- */
const HEX = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i;
const hashOf = (link: string): string => { const m = /btih:([a-z0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})/i.exec(link) ?? (HEX.test(link.trim()) ? [link, link.trim()] : null); if (!m) return ''; const h = m[1]; return h.length === 32 ? base32hex(h) : h.toLowerCase(); };
function base32hex(s: string): string { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0, out = ''; for (const ch of s.toUpperCase()) { const v = A.indexOf(ch); if (v < 0) return ''; val = (val << 5) | v; bits += 5; if (bits >= 8) { out += ((val >>> (bits - 8)) & 255).toString(16).padStart(2, '0'); bits -= 8; } } return out; }
export const magnetOf = (r: TorrentResult): string => (r.link?.startsWith('magnet:') ? r.link : `magnet:?xt=urn:btih:${r.hash}&dn=${encodeURIComponent(r.title)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce`);

/** The query for a show and an episode (0 = the whole thing / a batch / a movie), ids filled in from the mapping services. */
export async function buildQuery(media: Anime, episode: number): Promise<AnimeQuery> {
  const s = getSettings(); const ids = await idsOf(media.id).catch(() => ({} as Awaited<ReturnType<typeof idsOf>>));
  const ex: string[] = []; try { const v = document.createElement('video'); if (!v.canPlayType('video/mp4; codecs="hvc1"') && !v.canPlayType('video/mp4; codecs="hev1"') && !window.kurokawaTools) ex.push('HEVC', 'x265', 'H.265'); } catch { /* none */ }
  return { media, anilistId: media.id, anidbAid: ids.anidb, kitsuId: ids.kitsu, imdbId: ids.imdb, tmdbId: ids.tmdb, tvdbId: ids.tvdb, titles: titlesOf(media), episode, episodeCount: media.episodes ?? undefined, resolution: s.animeQuality, exclusions: ex };
}
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out`)), ms))]);

/** Runs one provider for a query: `single` for an episode, `batch`/`movie` otherwise (Seanime's `smartSearch`/`search`). */
export async function runProvider(p: ProviderEntry, q: AnimeQuery): Promise<TorrentResult[]> {
  const mod = await load(p); const opts = optionsOf(p);
  const isMovie = q.media.format === 'MOVIE' || (q.media.episodes === 1 && q.episode <= 1);
  let raw: unknown[] = [];
  if ((mod as SeanimeClass).__seanime) {
    const inst = new (mod as SeanimeClass)();
    const m = { id: q.media.id, idMal: q.media.idMal, status: q.media.status ?? 'NOT_YET_RELEASED', format: q.media.format ?? 'TV', englishTitle: q.media.titleEnglish, romajiTitle: q.media.titleRomaji, episodeCount: q.media.episodes ?? -1, absoluteSeasonOffset: 0, synonyms: q.media.synonyms, isAdult: q.media.isAdult, startDate: q.media.startDate };
    const st = inst.getSettings?.() ?? {};
    if (st.canSmartSearch && inst.smartSearch) raw = await withTimeout(inst.smartSearch({ media: m, query: '', batch: q.episode === 0 && !isMovie, episodeNumber: q.episode, resolution: q.resolution, anidbAID: q.anidbAid ?? 0, anidbEID: q.anidbEid ?? 0, bestReleases: false }), 20000, p.name);
    else raw = await withTimeout(inst.search({ media: m, query: `${q.titles[0]}${q.episode ? ` ${String(q.episode).padStart(2, '0')}` : ''}` }), 20000, p.name);
    return raw.map((t) => fromSeanime(t as Record<string, unknown>, p)).filter((x): x is TorrentResult => !!x);
  }
  const hm = mod as HayaseModule; const fq = { ...q, fetch: addonFetch() };
  const fn = q.episode > 0 && !isMovie ? hm.single : isMovie ? hm.movie ?? hm.single : hm.batch ?? hm.single;
  if (!fn) return [];
  raw = await withTimeout(fn.call(hm, fq, opts), 20000, p.name);
  return (raw as Record<string, unknown>[]).map((t) => sanitize(t, p)).filter((x): x is TorrentResult => !!x);
}
function sanitize(t: Record<string, unknown>, p: ProviderEntry): TorrentResult | null {
  const link = String(t.link ?? ''); const hash = String(t.hash ?? '').toLowerCase() || hashOf(link); if (!HEX.test(hash) && !t.url) return null;
  const parsed = parseFilename(String(t.title ?? ''));
  const acc = (['high', 'medium', 'low'] as const).includes(t.accuracy as Accuracy) ? (t.accuracy as Accuracy) : 'low';
  return { title: String(t.title ?? ''), link: link || magnetOf({ hash, title: String(t.title ?? '') } as TorrentResult), hash, size: Math.max(0, Number(t.size) || 0), seeders: Math.max(0, Number(t.seeders) || 0), leechers: Math.max(0, Number(t.leechers) || 0), downloads: Math.max(0, Number(t.downloads) || 0), accuracy: acc, date: t.date ? new Date(t.date as string) : undefined, type: ['batch', 'best', 'alt'].includes(String(t.type)) ? (t.type as 'batch') : undefined, provider: p.name, resolution: parsed.resolution, episode: parsed.episode, group: parsed.group, url: typeof t.url === 'string' ? t.url : undefined, fileIdx: typeof t.fileIdx === 'number' ? t.fileIdx : undefined };
}
function fromSeanime(t: Record<string, unknown>, p: ProviderEntry): TorrentResult | null {
  const link = String(t.magnetLink || t.downloadUrl || t.link || ''); const hash = String(t.infoHash ?? '').toLowerCase() || hashOf(link); if (!HEX.test(hash) && !/^https?:/.test(String(t.downloadUrl ?? ''))) return null;
  const parsed = parseFilename(String(t.name ?? ''));
  return { title: String(t.name ?? ''), link: link || magnetOf({ hash, title: String(t.name ?? '') } as TorrentResult), hash, size: Number(t.size) || 0, seeders: Number(t.seeders) || 0, leechers: Number(t.leechers) || 0, downloads: Number(t.downloadCount) || 0, accuracy: t.confirmed ? 'high' : 'medium', date: t.date ? new Date(t.date as string) : undefined, type: t.isBestRelease ? 'best' : t.isBatch ? 'batch' : undefined, provider: p.name, resolution: (t.resolution as string) || parsed.resolution, episode: typeof t.episodeNumber === 'number' && t.episodeNumber >= 0 ? t.episodeNumber : parsed.episode, group: (t.releaseGroup as string) || parsed.group };
}

/** All enabled providers at once; each one's results (or its error) reported as it answers. */
export async function searchAll(q: AnimeQuery, onEach: (p: ProviderEntry, res: TorrentResult[] | Error) => void): Promise<TorrentResult[]> {
  await syncBuiltins().catch(() => undefined);
  const ps = (await providers()).filter((p) => p.enabled);
  const all: TorrentResult[] = []; const seen = new Map<string, TorrentResult>();
  await Promise.all(ps.map(async (p) => {
    try { const r = await runProvider(p, q); const fresh: TorrentResult[] = []; for (const x of r) { const k = x.hash || x.url || x.link; const had = seen.get(k); if (had) { had.seeders = Math.max(had.seeders, x.seeders); if (x.accuracy === 'high') had.accuracy = 'high'; continue; } seen.set(k, x); fresh.push(x); all.push(x); } onEach(p, fresh); }
    catch (e) { onEach(p, e as Error); }
  }));
  return all;
}
/** Results ordered the Hayase way: best releases, then accuracy, then the wanted resolution, then seeders. */
export function rank(rs: TorrentResult[], want: string): TorrentResult[] {
  const acc = { high: 2, medium: 1, low: 0 }; const res = (r: TorrentResult) => (want && r.resolution?.startsWith(want) ? 1 : 0);
  return [...rs].sort((a, b) => (b.type === 'best' ? 1 : 0) - (a.type === 'best' ? 1 : 0) || acc[b.accuracy] - acc[a.accuracy] || res(b) - res(a) || b.seeders - a.seeders);
}
