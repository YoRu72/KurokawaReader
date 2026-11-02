// Anime torrent providers: where an episode's torrents are looked for. Three shapes run here —
//  • the repository's own modules (ESM exporting `single/batch/movie` — the Hayase interface);
//  • Hayase extensions (a repository is a JSON array of manifests; `code` is a bundled ESM file whose default
//    export has `test/single/batch/movie(query, options)`; the app's fetch is handed in on the query);
//  • Seanime extensions (a marketplace array or `{urls:[…]}` or one manifest; the payload defines a global
//    class `Provider` — a torrent source's `search/smartSearch/getLatest/getSettings`, a streaming one's
//    `search/findEpisodes/findEpisodeServer` — TypeScript compiled first; the globals it expects — `fetch` with
//    synchronous `text()/json()`, `LoadDoc`/`Doc`, `CryptoJS`, `Buffer`, `$habari`, `$goFeed`, `$store`,
//    `$getUserPreference` — are shimmed).
// Every provider is installed by the user from a repository URL (Settings → Anime), kept in IndexedDB, and
// run with a timeout; results are sanitised the Hayase way (a 40/64-hex hash is required).
import { db } from '../db';
import { addonFetch, request } from '../http';
import { getSettings, updateSettings } from '../settings';
import { parseFilename } from './anitomy';
import { idsOf, titlesOf, type Anime } from '../anilist';
import { CryptoJS } from './cryptojs';
import { toJs } from './tsjs';

export type Accuracy = 'high' | 'medium' | 'low';
export interface AnimeQuery {
  media: Anime; anilistId: number; anidbAid?: number; anidbEid?: number; kitsuId?: number; imdbId?: string; tmdbId?: number; tvdbId?: number;
  titles: string[]; episode: number; episodeCount?: number; absoluteEpisodeNumber?: number;
  resolution: '' | '2160' | '1080' | '720' | '540' | '480'; exclusions: string[];
  /** A name typed by hand: the sources search by it instead of telling the show by its ids. */
  query?: string;
}
export interface TorrentResult {
  title: string; link: string; hash: string; size: number; seeders: number; leechers: number; downloads: number;
  accuracy: Accuracy; date?: Date; type?: 'batch' | 'best' | 'alt'; provider: string; resolution?: string; episode?: number; group?: string; fileIdx?: number;
  /** A direct URL (a debrid-resolved stream) instead of a torrent. */
  url?: string;
}

export type ProviderFormat = 'module' | 'hayase' | 'seanime' | 'stremio';
export interface ProviderEntry {
  id: string; name: string; description?: string; version: string; format: ProviderFormat; icon?: string;
  /** Where the code is (and, for Hayase/Seanime, where the manifest came from). */
  code: string; manifest?: string; repo?: string;
  options?: Record<string, { type: string; description?: string; label?: string; default?: string | number | boolean; values?: unknown[] }>;
  accuracy?: Accuracy; media?: string; languages?: string[]; enabled: boolean; builtin?: boolean;
  /** A Seanime online-streaming extension (search → episodes → a server's video links) rather than a torrent source. */
  role?: 'stream';
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
    if (m.type !== 'anime-torrent-provider' && m.type !== 'onlinestream-provider') return;
    if (!m.payload && !m.payloadURI) { if (m.manifestURI) { const rr = await request(m.manifestURI); if (rr.status === 200) { try { m = { ...m, ...(JSON.parse(rr.body) as SeanimeManifest) }; } catch { return; } } } }
    if (!m.payload && !m.payloadURI) return;
    const options: ProviderEntry['options'] = {};
    for (const f of m.userConfig?.fields ?? []) options[f.name] = { type: f.type === 'switch' ? 'boolean' : f.type === 'select' ? 'select' : 'string', label: f.label, default: f.default, values: f.options?.map((o) => o.value) };
    out.push({ id: `sea:${m.id}`, name: m.name, description: m.description, version: m.version, format: 'seanime', icon: m.icon, code: m.payloadURI ?? `inline:${m.payload}`, manifest: m.manifestURI ?? from, repo: from, options, enabled: true, ...(m.type === 'onlinestream-provider' ? { role: 'stream' as const } : {}) });
  };
  const takeHay = (m: HayaseManifest, from: string) => { if (m.type !== 'torrent' || !m.code) return; out.push({ id: `hay:${m.id}`, name: m.name, description: m.description, version: m.version, format: 'hayase', icon: m.icon, code: ghCode(m.code), repo: from, options: m.options, accuracy: m.accuracy, media: m.media, languages: m.languages, enabled: true }); };
  if (Array.isArray(j)) { for (const m of j as (HayaseManifest & SeanimeManifest)[]) { if ('manifestVersion' in m) takeHay(m, url); else await takeSea(m, url); } }
  else if (j && typeof j === 'object' && Array.isArray((j as { urls?: string[] }).urls)) { for (const u of (j as { urls: string[] }).urls) { try { out.push(...(await readRepo(u))); } catch { /* one bad manifest */ } } }
  else if (j && typeof j === 'object' && Array.isArray((j as { resources?: unknown[] }).resources)) { const m = j as StremioManifest; if (stremioStreams(m)) out.push({ id: `stremio:${m.id}`, name: m.name, description: m.description, version: m.version ?? '0', format: 'stremio', icon: m.logo, code: url.replace(/\/manifest\.json(\?.*)?$/, ''), repo: url, media: (m.idPrefixes ?? []).join(','), enabled: true }); }
  else if (j && typeof j === 'object') { const m = j as HayaseManifest & SeanimeManifest; if ('manifestVersion' in m) takeHay(m, url); else await takeSea(m, url); }
  return out;
}
/** A Stremio add-on that hands out streams for series (Torrentio, AIOStreams, Comet, MediaFusion, …). */
type StremioManifest = { id: string; name: string; version?: string; description?: string; logo?: string; resources: (string | { name: string; types?: string[]; idPrefixes?: string[] })[]; types?: string[]; idPrefixes?: string[] };
const stremioStreams = (m: StremioManifest): boolean => m.resources.some((r) => (typeof r === 'string' ? r : r.name) === 'stream');
/** One entry of a marketplace installed by itself (the user picks from the list instead of taking everything). */
export async function installEntry(p: ProviderEntry): Promise<void> {
  if (p.format !== 'stremio') {
    const code = p.code.startsWith('inline:') ? p.code.slice(7) : await (async () => { const r = await request(p.code); if (r.status !== 200) throw new Error(`${p.name}: HTTP ${r.status}`); return r.body; })();
    await db.putFile(`provider:${p.id}`, new Blob([p.format === 'seanime' ? await toJs(code) : code], { type: 'text/javascript' }));
  }
  const cur = await providers(); const i = cur.findIndex((x) => x.id === p.id); const merged = { ...p, enabled: i >= 0 ? cur[i].enabled : true };
  if (i >= 0) cur[i] = merged; else cur.push(merged); modules.delete(p.id); await keep([...cur]);
}
/** Installs (or updates) the providers of a repository: their code fetched and kept. */
export async function installRepo(url: string): Promise<ProviderEntry[]> {
  const found = await readRepo(url); if (!found.length) throw new Error('no anime sources there');
  const cur = await providers();
  for (const p of found) {
    if (p.format !== 'stremio') {
      const code = p.code.startsWith('inline:') ? p.code.slice(7) : await (async () => { const r = await request(p.code); if (r.status !== 200) throw new Error(`${p.name}: HTTP ${r.status}`); return r.body; })();
      await db.putFile(`provider:${p.id}`, new Blob([p.format === 'seanime' ? await toJs(code) : code], { type: 'text/javascript' }));
    }
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
export type SeanimeClass = { new (): { search(o: unknown): Promise<unknown[]>; smartSearch?(o: unknown): Promise<unknown[]>; getLatest?(): Promise<unknown[]>; getSettings?(): { canSmartSearch?: boolean; smartSearchFilters?: string[]; episodeServers?: string[]; supportsDub?: boolean }; findEpisodes?(id: string): Promise<unknown[]>; findEpisodeServer?(ep: unknown, server: string): Promise<unknown> }; __seanime: true };

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
export async function load(p: ProviderEntry): Promise<HayaseModule | SeanimeClass> {
  let m = modules.get(p.id);
  if (!m) {
    m = (async () => {
      const b = await db.getFile(p.code.startsWith('addon:') ? p.code : `provider:${p.id}`); if (!b) throw new Error('not installed');
      if (p.format === 'seanime') return seanimeClass(await toJs(await b.text()), p);
      const u = URL.createObjectURL(b.type === 'text/javascript' ? b : new Blob([b], { type: 'text/javascript' }));
      try { const mod = (await import(/* @vite-ignore */ u)) as { default?: HayaseModule } & HayaseModule; return mod.default ?? mod; } finally { URL.revokeObjectURL(u); }
    })();
    modules.set(p.id, m);
  }
  return m;
}

/** Seanime's payload (already JavaScript: see tsjs.ts), run with its globals shimmed. */
function seanimeClass(js: string, p: ProviderEntry): SeanimeClass {
  const shim = seanimeGlobals(p);
  const fn = new Function(...Object.keys(shim), `${js}\n;return typeof Provider !== 'undefined' ? Provider : undefined;`);
  const cls = fn(...Object.values(shim)) as SeanimeClass | undefined;
  if (!cls) throw new Error('no Provider class');
  (cls as { __seanime: boolean }).__seanime = true; return cls;
}
function seanimeGlobals(p: ProviderEntry): Record<string, unknown> {
  const f = addonFetch(); const store = new Map<string, unknown>();
  // Seanime's fetch: `text()`/`json()` synchronous, an object body sent as JSON, headers and cookies flattened.
  const fetchShim = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; redirect?: RequestRedirect; timeout?: number } = {}) => {
    const body = init.body === undefined || init.body === null || typeof init.body === 'string' || init.body instanceof FormData || init.body instanceof URLSearchParams || init.body instanceof Blob || init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body) ? (init.body as BodyInit | undefined) : JSON.stringify(init.body);
    const headers = { ...(init.headers ?? {}) }; if (body && typeof init.body === 'object' && typeof body === 'string' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), (init.timeout ?? 35) * 1000);
    try {
      const r = await f(url, { method: init.method ?? 'GET', headers, body, redirect: init.redirect ?? 'follow', signal: ctl.signal }); const text = await r.text();
      const hs = Object.fromEntries(r.headers.entries()); const cookies: Record<string, string> = {}; for (const c of (r.headers.get('set-cookie') ?? '').split(/,(?=[^;]+=)/)) { const m = /^\s*([^=;]+)=([^;]*)/.exec(c); if (m) cookies[m[1]] = m[2]; }
      return { status: r.status, statusText: r.statusText, method: init.method ?? 'GET', ok: r.ok, url: r.url || url, redirected: r.redirected, headers: hs, rawHeaders: Object.fromEntries(Object.entries(hs).map(([k, v]) => [k, [v]])), cookies, contentType: hs['content-type'] ?? '', contentLength: Number(hs['content-length'] ?? text.length), text: () => text, json: () => JSON.parse(text) };
    } finally { clearTimeout(tm); }
  };
  const prefs = optionsOf(p);
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
  function Doc(this: unknown, html: string) { return selection([parse(html).documentElement]); }
  const toStr = (v: unknown): string => (typeof v === 'string' ? v : v instanceof Uint8Array ? new TextDecoder().decode(v) : v instanceof ArrayBuffer ? new TextDecoder().decode(new Uint8Array(v)) : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return {
    fetch: fetchShim, console, CryptoJS, Buffer: SeaBuffer, Doc,
    LoadDoc: (html: string) => { const doc = parse(html); return (sel: string) => selection(Array.from(doc.querySelectorAll(sel))); },
    __isOffline__: !navigator.onLine,
    $toString: toStr, $toBytes: (v: unknown) => (v instanceof Uint8Array ? v : new TextEncoder().encode(toStr(v))),
    $clone: <T>(v: T): T => structuredClone(v), $replace: (a: Record<string, unknown>, b: Record<string, unknown>) => { if (a && b && typeof a === 'object') { for (const k of Object.keys(a)) delete a[k]; Object.assign(a, b); } },
    $await: (x: unknown) => x, $arrayOf: () => [], $unmarshalJSON: (d: unknown, dst: Record<string, unknown>) => { Object.assign(dst, typeof d === 'string' ? JSON.parse(d) : JSON.parse(toStr(d))); },
    $habari: { parse: parseFilename }, $goFeed: { parse: parseFeed },
    $store: { set: (k: string, v: unknown) => store.set(k, v), get: (k: string) => store.get(k), getUnsafe: (k: string) => store.get(k), has: (k: string) => store.has(k), getOrSet: (k: string, v: () => unknown) => { if (!store.has(k)) store.set(k, v()); return store.get(k); }, reset: () => store.clear(), values: () => [...store.values()], getAll: () => Object.fromEntries(store) },
    $getUserPreference: (k: string) => (prefs[k] === undefined ? undefined : String(prefs[k])), $sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    $torrentUtils: { getMagnetLinkFromTorrentData: () => '' }, $isOffline: () => !navigator.onLine,
    // (A headless browser is not something a phone app can carry: the extensions that need one say so.)
    ChromeDP: { newBrowser: () => { throw new Error('ChromeDP is not available in Kurokawa Tools'); } },
    $scannerUtils: { normalizeTitle: (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim(), buildSeasonQuery: (t: string, s: number) => `(${t} S${String(s).padStart(2, '0')} | ${t} Season ${s})`, sanitizeQuery: (s: string) => s.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim() },
  };
}
/** The Node-style Buffer Seanime gives its extensions (from/alloc/toString with utf8, base64, hex, latin1). */
class SeaBuf extends Uint8Array {
  equals(o: Uint8Array): boolean { return o.length === this.length && this.every((v, i) => v === o[i]); }
  override toString(enc = 'utf8'): string {
    const e = String(enc).toLowerCase().replace('-', ''); const u = new Uint8Array(this);
    return e === 'base64' ? CryptoJS.enc.Base64.stringify(u) : e === 'base64url' ? CryptoJS.enc.Base64.stringify(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : e === 'hex' ? CryptoJS.enc.Hex.stringify(u) : e === 'latin1' || e === 'binary' || e === 'ascii' ? CryptoJS.enc.Latin1.stringify(u) : CryptoJS.enc.Utf8.stringify(u);
  }
}
const SeaBuffer = {
  poolSize: 8192, isBuffer: (x: unknown) => x instanceof SeaBuf,
  from(x: string | ArrayLike<number> | ArrayBuffer, enc = 'utf8'): SeaBuf {
    if (typeof x !== 'string') return new SeaBuf(x instanceof ArrayBuffer ? new Uint8Array(x) : Array.from(x));
    const e = enc.toLowerCase().replace('-', '');
    return new SeaBuf(e === 'base64' || e === 'base64url' ? CryptoJS.enc.Base64.parse(x.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(x.length / 4) * 4, '=')) : e === 'hex' ? CryptoJS.enc.Hex.parse(x) : e === 'latin1' || e === 'binary' || e === 'ascii' ? CryptoJS.enc.Latin1.parse(x) : CryptoJS.enc.Utf8.parse(x));
  },
  alloc(n: number, fill: number | string = 0): SeaBuf { const b = new SeaBuf(n); b.fill(typeof fill === 'number' ? fill : fill.charCodeAt(0) || 0); return b; },
};
type Pred = string | ((i: number, s: Sel) => boolean);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sel = Record<string, (...a: any[]) => any>;
/** goquery's selection (what Seanime's `LoadDoc` and `Doc` hand out), over DOM elements. */
function selection(els: Element[], prevSel?: Sel): Sel {
  const uniq = (a: (Element | null | undefined)[]) => [...new Set(a.filter((x): x is Element => !!x))];
  const test = (p: Pred) => (e: Element, i: number) => (typeof p === 'string' ? e.matches(p) : !!p(i, selection([e])));
  const sibs = (e: Element, dir: 'nextElementSibling' | 'previousElementSibling', stop?: string, filt?: string) => { const out: Element[] = []; for (let x = e[dir]; x; x = x[dir]) { if (stop && x.matches(stop)) break; if (!filt || x.matches(filt)) out.push(x); } return out; };
  const ups = (e: Element, stop?: string, filt?: string) => { const out: Element[] = []; for (let x = e.parentElement; x; x = x.parentElement) { if (stop && x.matches(stop)) break; if (!filt || x.matches(filt)) out.push(x); } return out; };
  const self: Sel = {
    length: () => els.length, size: () => els.length, first: () => S(els.slice(0, 1)), last: () => S(els.slice(-1)), eq: (i: number) => S(i < 0 ? els.slice(i, i === -1 ? undefined : i + 1) : els.slice(i, i + 1)),
    find: (sel: string) => S(uniq(els.flatMap((e) => Array.from(e.querySelectorAll(sel))))),
    children: (sel?: string) => S(els.flatMap((e) => Array.from(e.children).filter((c) => !sel || c.matches(sel)))),
    contents: () => S(els.flatMap((e) => Array.from(e.children))), contentsFiltered: (sel: string) => S(els.flatMap((e) => Array.from(e.children).filter((c) => c.matches(sel)))),
    parent: (sel?: string) => S(uniq(els.map((e) => e.parentElement)).filter((x) => !sel || x.matches(sel))), parents: (sel?: string) => S(uniq(els.flatMap((e) => ups(e, undefined, sel)))), parentsUntil: (stop: string, filt?: string) => S(uniq(els.flatMap((e) => ups(e, stop, filt)))),
    closest: (sel?: string) => S(uniq(els.map((e) => (sel ? e.closest(sel) : e)))),
    next: (sel?: string) => S(els.map((e) => e.nextElementSibling).filter((x): x is Element => !!x && (!sel || x.matches(sel)))), prev: (sel?: string) => S(els.map((e) => e.previousElementSibling).filter((x): x is Element => !!x && (!sel || x.matches(sel)))),
    nextAll: (sel?: string) => S(uniq(els.flatMap((e) => sibs(e, 'nextElementSibling', undefined, sel)))), prevAll: (sel?: string) => S(uniq(els.flatMap((e) => sibs(e, 'previousElementSibling', undefined, sel)))),
    nextUntil: (stop: string, filt?: string) => S(uniq(els.flatMap((e) => sibs(e, 'nextElementSibling', stop, filt)))), prevUntil: (stop: string, filt?: string) => S(uniq(els.flatMap((e) => sibs(e, 'previousElementSibling', stop, filt)))),
    siblings: (sel?: string) => S(uniq(els.flatMap((e) => Array.from(e.parentElement?.children ?? []).filter((c) => c !== e && (!sel || c.matches(sel)))))),
    text: () => els.map((e) => e.textContent ?? '').join(''), html: () => (els[0] ? els[0].innerHTML : null),
    attr: (n: string): string | undefined => { const v = els[0]?.getAttribute(n); return v === null || v === undefined ? undefined : v; },
    attrs: () => Object.fromEntries(Array.from(els[0]?.attributes ?? []).map((a) => [a.name, a.value])),
    data: (n?: string) => { const d = (els[0] as HTMLElement | undefined)?.dataset ?? {}; return n === undefined ? { ...d } : d[n.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())]; },
    each: (fn: (i: number, s: Sel) => unknown) => { for (let i = 0; i < els.length; i++) if (fn(i, S([els[i]])) === false) break; return self; },
    map: <T>(fn: (i: number, s: Sel) => T) => els.map((e, i) => fn(i, S([e]))),
    filter: (p: Pred) => S(els.filter(test(p))), not: (p: Pred) => S(els.filter((e, i) => !test(p)(e, i))), is: (p: Pred) => els.some(test(p)),
    has: (sel: string) => S(els.filter((e) => !!e.querySelector(sel))), end: () => prevSel ?? S([]),
  };
  function S(e: Element[]): Sel { return selection(e, self); }
  return self;
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
// (Some sources — AnimeTosho, the ElfHosted add-ons — take long to answer on a slow day.)
const TIMEOUT = 35000;
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out`)), ms))]);

/** Runs one provider for a query: `single` for an episode, `batch`/`movie` otherwise (Seanime's `smartSearch`/`search`). */
export async function runProvider(p: ProviderEntry, q: AnimeQuery): Promise<TorrentResult[]> {
  if (p.format === 'stremio') return runStremio(p, q);
  const mod = await load(p); const opts = optionsOf(p);
  const isMovie = q.media.format === 'MOVIE' || (q.media.episodes === 1 && q.episode <= 1);
  let raw: unknown[] = [];
  if ((mod as SeanimeClass).__seanime) {
    const inst = new (mod as SeanimeClass)();
    const m = { id: q.media.id, idMal: q.media.idMal, status: q.media.status ?? 'NOT_YET_RELEASED', format: q.media.format ?? 'TV', englishTitle: q.media.titleEnglish, romajiTitle: q.media.titleRomaji, episodeCount: q.media.episodes ?? -1, absoluteSeasonOffset: 0, synonyms: q.media.synonyms, isAdult: q.media.isAdult, startDate: q.media.startDate };
    const st = inst.getSettings?.() ?? {};
    if (q.query) raw = await withTimeout(inst.search({ media: m, query: `${q.query}${q.episode ? ` ${String(q.episode).padStart(2, '0')}` : ''}` }), TIMEOUT, p.name);
    else if (st.canSmartSearch && inst.smartSearch) raw = await withTimeout(inst.smartSearch({ media: m, query: '', batch: q.episode === 0 && !isMovie, episodeNumber: q.episode, resolution: q.resolution, anidbAID: q.anidbAid ?? 0, anidbEID: q.anidbEid ?? 0, bestReleases: false }), TIMEOUT, p.name);
    else raw = await withTimeout(inst.search({ media: m, query: `${q.titles[0]}${q.episode ? ` ${String(q.episode).padStart(2, '0')}` : ''}` }), TIMEOUT, p.name);
    return raw.map((t) => fromSeanime(t as Record<string, unknown>, p)).filter((x): x is TorrentResult => !!x);
  }
  const hm = mod as HayaseModule; const fq = { ...q, ...(q.query ? { anidbAid: undefined, anidbEid: undefined, kitsuId: undefined } : {}), fetch: addonFetch() };
  const fn = q.episode > 0 && !isMovie ? hm.single : isMovie ? hm.movie ?? hm.single : hm.batch ?? hm.single;
  if (!fn) return [];
  raw = await withTimeout(fn.call(hm, fq, opts), TIMEOUT, p.name);
  return (raw as Record<string, unknown>[]).map((t) => sanitize(t, p)).filter((x): x is TorrentResult => !!x);
}
/** A Stremio add-on asked for an episode: by Kitsu id when it takes them (anime numbering), else by IMDb id and
 *  episode (season 1 — the IMDb seasons of a long anime rarely line up with AniList's entries). */
async function runStremio(p: ProviderEntry, q: AnimeQuery): Promise<TorrentResult[]> {
  const prefixes = (p.media ?? '').split(',').filter(Boolean); const isMovie = q.media.format === 'MOVIE';
  const ep = q.episode || 1;
  const id = q.kitsuId && (!prefixes.length || prefixes.includes('kitsu')) ? `kitsu:${q.kitsuId}${isMovie ? '' : `:${ep}`}` : q.imdbId ? (isMovie ? q.imdbId : `${q.imdbId}:1:${ep}`) : null;
  if (!id) return [];
  const type = isMovie && !id.startsWith('kitsu:') ? 'movie' : 'series';
  const r = await withTimeout(request(`${p.code}/stream/${type}/${id}.json`), TIMEOUT, p.name); if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const streams = ((JSON.parse(r.body) as { streams?: { name?: string; title?: string; description?: string; infoHash?: string; fileIdx?: number; url?: string; sources?: string[]; behaviorHints?: { filename?: string; videoSize?: number } }[] }).streams ?? []);
  const out: TorrentResult[] = [];
  for (const st of streams) {
    const text = st.description || st.title || ''; const lines = text.split('\n'); const title = (st.behaviorHints?.filename || lines[0] || st.name || '').trim(); if (!title) continue;
    const info = text; const seeds = Number(/👤\s*(\d+)/.exec(info)?.[1]) || 0; const sz = /💾\s*([\d.]+)\s*(TB|GB|MB)/.exec(info);
    const size = st.behaviorHints?.videoSize || (sz ? Math.round(Number(sz[1]) * ({ TB: 1099511627776, GB: 1073741824, MB: 1048576 } as Record<string, number>)[sz[2]]) : 0);
    const hash = (st.infoHash ?? '').toLowerCase(); if (!HEX.test(hash) && !st.url) continue;
    const parsed = parseFilename(title);
    const trackers = (st.sources ?? []).filter((x) => x.startsWith('tracker:')).map((x) => `&tr=${encodeURIComponent(x.slice(8))}`).join('');
    out.push({ title, link: hash ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${trackers}` : st.url!, hash, size, seeders: seeds, leechers: 0, downloads: 0, accuracy: id.startsWith('kitsu:') ? 'high' : 'medium', provider: p.name, resolution: /\b(2160p|4k|1080p|720p|480p)\b/i.exec(`${st.name ?? ''} ${title}`)?.[1]?.toLowerCase().replace('4k', '2160p') ?? parsed.resolution, episode: parsed.episode, group: parsed.group, url: hash ? undefined : st.url, fileIdx: st.fileIdx });
  }
  return out;
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
  const ps = (await providers()).filter((p) => p.enabled && p.role !== 'stream');
  const all: TorrentResult[] = []; const seen = new Map<string, TorrentResult>();
  await Promise.all(ps.map(async (p) => {
    try { const r = await runProvider(p, q); const fresh: TorrentResult[] = []; for (const x of r) { const k = x.hash || x.url || x.link; const had = seen.get(k); if (had) { had.seeders = Math.max(had.seeders, x.seeders); if (x.accuracy === 'high') had.accuracy = 'high'; continue; } seen.set(k, x); fresh.push(x); all.push(x); } onEach(p, fresh); }
    catch (e) { onEach(p, e as Error); }
  }));
  return all;
}
/** A release's tags, read from its name (Seanime's and Hayase's badges): SeaDex's best, a batch, the quality, the
 *  source (BD, web), the video (HEVC, AV1, 10-bit, HDR, remux), the audio (dual, dubbed), subtitles, a fixed v2. */
export interface ReleaseTag { id: string; label: string; good?: boolean }
export function releaseTags(r: TorrentResult): ReleaseTag[] {
  const n = ` ${r.title} `; const p = parseFilename(r.title); const out: ReleaseTag[] = [];
  const add = (id: string, label: string, good?: boolean) => { if (!out.some((x) => x.id === id)) out.push({ id, label, good }); };
  if (r.type === 'best') add('best', 'SeaDex', true);
  const res = r.resolution ?? p.resolution; if (res) add('res', /^2160|4k/i.test(res) ? '4K' : res);
  if (r.type === 'batch' || p.batch) add('batch', 'Batch');
  if (/\b(bd|bdrip|blu-?ray|bdremux)\b/i.test(n)) add('bd', 'BD', true); else if (/\bweb(-?dl|-?rip)?\b/i.test(n)) add('web', 'WEB'); else if (/\b(dvd|dvdrip)\b/i.test(n)) add('dvd', 'DVD');
  if (/\bremux\b/i.test(n)) add('remux', 'Remux', true);
  if (/\b(hevc|x265|h\.?265)\b/i.test(n)) add('hevc', 'HEVC'); else if (/\bav1\b/i.test(n)) add('av1', 'AV1'); else if (/\b(avc|x264|h\.?264)\b/i.test(n)) add('avc', 'AVC');
  if (/\b(10.?bit|hi10p?)\b/i.test(n)) add('10bit', '10-bit');
  if (/\b(hdr|hdr10\+?|dovi|dv)\b/i.test(n)) add('hdr', 'HDR');
  if (/\b(dual[ ._-]?audio|multi[ ._-]?audio)\b/i.test(n)) add('dual', 'Dual audio', true); else if (/\b(dub|dubbed|eng[ ._-]?dub)\b/i.test(n)) add('dub', 'Dub');
  if (/\b(multi[ ._-]?subs?)\b/i.test(n)) add('msubs', 'Multi-subs');
  if (/\b(uncensored|uncen)\b/i.test(n)) add('uncen', 'Uncensored');
  if (/\bv[2-9]\b/i.test(n)) add('fixed', 'v2', true);
  if (r.accuracy === 'high') add('match', '✓', true);
  return out;
}
/** How good a release looks beyond its quality (for the ones the choices leave level): SeaDex's best first, then
 *  Blu-ray and remuxes, a fixed version, 10-bit and dual audio, and the seeders (on a log scale, so a well-seeded
 *  web release does not lose to a dead Blu-ray). */
export function releaseScore(r: TorrentResult): number {
  const tags = new Set(releaseTags(r).map((x) => x.id)); let s = 0;
  if (tags.has('best')) s += 100; if (tags.has('bd')) s += 6; if (tags.has('remux')) s += 2; if (tags.has('web')) s += 3; if (tags.has('fixed')) s += 1; if (tags.has('10bit')) s += 1; if (tags.has('dual')) s += 1;
  s += Math.log2(1 + Math.max(0, r.seeders)) * 1.5; if (r.seeders === 0) s -= 20;
  return s;
}
/** Results ordered the Hayase way: best releases, then accuracy, then the wanted resolution, then how good each
 *  looks (its tags and seeders). */
export function rank(rs: TorrentResult[], want: string): TorrentResult[] {
  const acc = { high: 2, medium: 1, low: 0 }; const res = (r: TorrentResult) => (want && r.resolution?.startsWith(want) ? 1 : 0);
  const sc = new Map(rs.map((r) => [r, releaseScore(r)]));
  return [...rs].sort((a, b) => (b.type === 'best' ? 1 : 0) - (a.type === 'best' ? 1 : 0) || acc[b.accuracy] - acc[a.accuracy] || res(b) - res(a) || sc.get(b)! - sc.get(a)! || b.seeders - a.seeders);
}
