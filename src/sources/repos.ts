// Repositories of extensions, as the novel apps keep them: the reader adds a repo (its page on GitHub or
// GitLab, its index file, or the install link an app's wiki offers), the index is fetched and read, and
// its format tells which app it was made for — LNReader's plugins and Mangayomi's JavaScript novel
// extensions run here; the others (Shosetsu's Lua, IReader's and Mihon's APKs, Sora's and Suwatte's iOS
// modules…) are recognised and listed so the reader knows what the repo is. Every repo is a section of its
// own in Sources; a repo already added — under any of its addresses — is refused.
import { db } from '../db';
import { fetchText, request } from './http';
import { SourceError } from './types';

export type RepoKind = 'lnreader' | 'mangayomi' | 'shosetsu' | 'ireader' | 'mihon' | 'sora' | 'suwatte' | 'aidoku' | 'paperback' | 'kotatsu' | 'unknown';
export const KIND_APP: Record<RepoKind, string> = { lnreader: 'LNReader', mangayomi: 'Mangayomi', shosetsu: 'Shosetsu', ireader: 'IReader', mihon: 'Mihon / Tachiyomi', sora: 'Sora', suwatte: 'Suwatte', aidoku: 'Aidoku', paperback: 'Paperback', kotatsu: 'Kotatsu', unknown: '?' };
/** The kinds whose extensions run in this reader. */
export const RUNNABLE: RepoKind[] = ['lnreader', 'mangayomi'];

export interface ExtItem {
  id: string;             // the plugin's own id (unique within its repo)
  name: string;
  lang: string;           // a language name or code
  site: string;
  version: string;
  icon?: string;
  url: string;            // the code
  kind: RepoKind;
  runnable: boolean;
  note?: string;          // why it does not run here (a Dart extension, a manga source…)
  itemType?: 'novel' | 'manga' | 'anime' | 'other';
  nsfw?: boolean;
  source?: Record<string, unknown>;   // Mangayomi: the source record the extension is given
}
export interface Repo {
  key: string;            // a short stable hash of the index URL
  url: string;            // the index as fetched
  given: string;          // what the reader typed
  name: string;
  kind: RepoKind;
  addedAt: number;
  fetchedAt?: number;
  items: ExtItem[];
  count?: { novel: number; other: number };
  error?: string;
}

const META = 'sources:repos';
let cache: Repo[] | null = null;

export async function listRepos(): Promise<Repo[]> {
  if (cache) return cache;
  cache = (await db.getMeta<Repo[]>(META)) ?? [];
  return cache;
}
async function saveRepos(list: Repo[]): Promise<void> { cache = list; await db.setMeta(META, list); }

/* ---------- addresses ---------- */
export function hashKey(s: string): string {
  let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
/** One canonical form of an address, so a repo given twice (with or without a scheme, a trailing slash,
 *  raw.githubusercontent for github.com/…/blob/…) is seen as the same. */
export function normalizeUrl(u: string): string {
  let s = u.trim();
  if (!/^[a-z]+:/i.test(s)) s = 'https://' + s;
  try {
    const url = new URL(s);
    url.hash = '';
    let host = url.host.toLowerCase(); let path = url.pathname.replace(/\/+$/, '').replace(/\/(tree|blob)\//, '/').replace(/\.git$/, '');
    if (host === 'www.github.com') host = 'github.com';
    if (host === 'raw.githubusercontent.com') { host = 'github.com'; path = path.replace(/^\/([^/]+)\/([^/]+)\/refs\/heads\//, '/$1/$2/'); }
    if (host === 'gitlab.com') path = path.replace(/\/-\/raw\//, '/');
    return `${url.protocol}//${host}${path}${url.search}`.toLowerCase();
  } catch { return s.toLowerCase(); }
}

/** Where the index might be, for what the reader gave: the address itself when it is a file, the install
 *  links the apps' wikis offer, and the usual places in a GitHub/GitLab repo. */
export function candidates(given: string): string[] {
  const s = given.trim();
  const out: string[] = [];
  const add = (u: string) => { if (u && !out.includes(u)) out.push(u); };
  // An app's install link (mangayomi://add-repo?novel_url=…, lnreader://repo/add?url=…, shosetsu://…, aidoku://…).
  const m = /^([a-z]+):\/\/(.*)$/i.exec(s);
  if (m && !/^https?$/i.test(m[1])) {
    try {
      const u = new URL('https://x/' + m[2].replace(/^\/+/, ''));
      for (const k of ['novel_url', 'url', 'repo_url', 'manga_url', 'anime_url', 'src', 'repo']) for (const v of u.searchParams.getAll(k)) add(v);
    } catch { /* not a link */ }
    // (The install links sometimes carry the index in the path itself.)
    const direct = /https?:\/\/\S+/.exec(decodeURIComponent(m[2])); if (direct) add(direct[0]);
    return out;
  }
  let url = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  const gh = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:\/(?:tree|blob)\/([^/#?]+)(\/[^#?]*)?)?\/?$/i.exec(url);
  const raw = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(?:refs\/heads\/)?([^/]+)(\/.*)?$/i.exec(url);
  const gl = /^https?:\/\/gitlab\.com\/([^/]+)\/([^/#?]+)(?:\/-\/(?:tree|raw|blob)\/([^/#?]+)(\/[^#?]*)?)?\/?$/i.exec(url);
  if (/\.(json|pb|txt)(\?.*)?$/i.test(url) && !gh) { if (/^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/blob\//i.test(url)) url = url.replace(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\//i, 'https://raw.githubusercontent.com/$1/$2/'); add(url); return out; }
  if (gh && gh[4] && /\.(json|pb)$/i.test(gh[4])) { add(`https://raw.githubusercontent.com/${gh[1]}/${gh[2].replace(/\.git$/, '')}/${gh[3]}${gh[4]}`); return out; }
  if (gh || raw) {
    const owner = (gh ?? raw)![1], repo = (gh ?? raw)![2].replace(/\.git$/, ''); const branch = (gh ?? raw)![3];
    const base = (b: string) => `https://raw.githubusercontent.com/${owner}/${repo}/${b}`;
    const branches = branch ? [branch] : ['main', 'master'];
    if (!branch && /lnreader/i.test(repo)) branches.unshift('plugins/v3.0.0');
    for (const b of branches) {
      add(`${base(b)}/novel_index.json`); add(`${base(b)}/index.json`);
      add(`${base(b)}/.dist/plugins.min.json`); add(`${base(b)}/plugins.min.json`); add(`${base(b)}/plugins.json`);
      add(`${base(b)}/index.min.json`); add(`${base(b)}/runners.json`); add(`${base(b)}/sources.json`); add(`${base(b)}/modules.json`); add(`${base(b)}/repo.json`);
    }
    if (!branch) { add(`${base('plugins/v3.0.0')}/.dist/plugins.min.json`); add(`${base('plugins/v2.0.0')}/.dist/plugins.min.json`); }
    add(`https://${owner}.github.io/${repo}/index.json`); add(`https://${owner}.github.io/${repo}/novel_index.json`); add(`https://${owner}.github.io/${repo}/index.min.json`);
    return out;
  }
  if (gl) {
    const owner = gl[1], repo = gl[2].replace(/\.git$/, ''); const branches = gl[3] ? [gl[3]] : ['main', 'master', 'dev'];
    for (const b of branches) { add(`https://gitlab.com/${owner}/${repo}/-/raw/${b}/index.json`); add(`https://gitlab.com/${owner}/${repo}/-/raw/${b}/plugins.min.json`); add(`https://gitlab.com/${owner}/${repo}/-/raw/${b}/index.min.json`); }
    return out;
  }
  // A site of its own (repo.shosetsu.app/universe, a Pages site): the index at the usual names.
  const bare = url.replace(/\/+$/, '');
  add(bare); add(`${bare}/novel_index.json`); add(`${bare}/index.json`); add(`${bare}/plugins.min.json`); add(`${bare}/.dist/plugins.min.json`); add(`${bare}/index.min.json`); add(`${bare}/runners.json`);
  return out;
}

/* ---------- reading an index ---------- */
interface Parsed { kind: RepoKind; name?: string; items: ExtItem[]; count: { novel: number; other: number } }
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export function parseIndex(url: string, text: string): Parsed | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  const base = url.replace(/[^/]*$/, '');
  const abs = (u: string) => { if (!u) return ''; try { return new URL(u, base).href; } catch { return u; } };
  // LNReader: [{id, name, site, lang, version, url, iconUrl}]
  if (Array.isArray(data) && data.length && data.every((e) => e && typeof e === 'object' && typeof (e as Record<string, unknown>).id === 'string' && 'site' in (e as object) && 'url' in (e as object))) {
    const items = (data as Record<string, unknown>[]).map((e): ExtItem => ({ id: str(e.id), name: str(e.name), lang: str(e.lang), site: str(e.site), version: str(e.version), icon: abs(str(e.iconUrl)), url: abs(str(e.url)), kind: 'lnreader', runnable: true, itemType: 'novel' }));
    return { kind: 'lnreader', items, count: { novel: items.length, other: 0 } };
  }
  // Mangayomi: [{name, lang, baseUrl, sourceCodeUrl, itemType (0 manga, 1 anime, 2 novel), sourceCodeLanguage (0 dart, 1 js), …}]
  if (Array.isArray(data) && data.length && data.every((e) => e && typeof e === 'object' && 'baseUrl' in (e as object) && ('sourceCodeUrl' in (e as object) || 'apiUrl' in (e as object)))) {
    const items = (data as Record<string, unknown>[]).map((e): ExtItem => {
      const itemType = Number(e.itemType ?? (e.isManga === false ? 1 : 0)); const js = Number(e.sourceCodeLanguage ?? 0) === 1 || /\.js(\?|$)/i.test(str(e.sourceCodeUrl));
      const type: ExtItem['itemType'] = itemType === 2 ? 'novel' : itemType === 1 ? 'anime' : 'manga';
      const runnable = type === 'novel' && js;
      return { id: str(e.id || `${e.name}-${e.lang}`), name: str(e.name), lang: str(e.lang), site: str(e.baseUrl), version: str(e.version), icon: abs(str(e.iconUrl)), url: abs(str(e.sourceCodeUrl)), kind: 'mangayomi', runnable, itemType: type, nsfw: !!e.isNsfw, note: runnable ? undefined : type !== 'novel' ? 'notNovel' : 'dartExtension', source: e };
    });
    return { kind: 'mangayomi', items, count: { novel: items.filter((i) => i.itemType === 'novel').length, other: items.filter((i) => i.itemType !== 'novel').length } };
  }
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    // Shosetsu: {libraries:[…], scripts:[{id, name, fileName, imageURL, lang, ver, libVer}]}
    const scripts = (o.scripts ?? o.extensions) as Record<string, unknown>[] | undefined;
    if (Array.isArray(scripts) && 'libraries' in o) {
      const items = scripts.map((e): ExtItem => ({ id: str(e.id), name: str(e.name), lang: str(e.lang), site: '', version: str(e.ver ?? e.version), icon: abs(str(e.imageURL)), url: abs(`src/${e.lang}/${e.fileName}.lua`), kind: 'shosetsu', runnable: false, note: 'luaExtension', itemType: 'novel' }));
      return { kind: 'shosetsu', name: str(o.name), items, count: { novel: items.length, other: 0 } };
    }
    // Suwatte: {runners:[{id, name, version, …}]}
    if (Array.isArray(o.runners)) {
      const items = (o.runners as Record<string, unknown>[]).map((e): ExtItem => ({ id: str(e.id), name: str(e.name), lang: str(e.lang ?? ''), site: str(e.website ?? ''), version: str(e.version), icon: abs(str(e.thumbnail)), url: abs(str(e.path ?? '')), kind: 'suwatte', runnable: false, note: 'iosModule', itemType: 'other' }));
      return { kind: 'suwatte', name: str(o.name), items, count: { novel: 0, other: items.length } };
    }
    // Aidoku: {sources:[{id, name, lang, version, file, icon, …}]} (or a Mihon-like list under "sources")
    if (Array.isArray(o.sources)) {
      const list = o.sources as Record<string, unknown>[];
      const sora = list.length && list.every((e) => 'scriptUrl' in e || 'sourceName' in e);
      const items = list.map((e): ExtItem => ({ id: str(e.id ?? e.sourceName ?? e.name), name: str(e.sourceName ?? e.name), lang: str(e.language ?? e.lang ?? ''), site: str(e.baseUrl ?? e.website ?? ''), version: str(e.version), icon: abs(str(e.iconUrl ?? e.icon ?? '')), url: abs(str(e.scriptUrl ?? e.file ?? '')), kind: sora ? 'sora' : 'aidoku', runnable: false, note: sora ? 'iosModule' : 'iosModule', itemType: sora ? (/novel|light/i.test(str(e.type)) ? 'novel' : 'other') : 'manga' }));
      return { kind: sora ? 'sora' : 'aidoku', name: str(o.name), items, count: { novel: items.filter((i) => i.itemType === 'novel').length, other: items.filter((i) => i.itemType !== 'novel').length } };
    }
  }
  // Sora's module lists: [{sourceName, iconUrl, scriptUrl, language, type, …}]
  if (Array.isArray(data) && data.length && data.every((e) => e && typeof e === 'object' && ('scriptUrl' in (e as object) || 'sourceName' in (e as object)))) {
    const items = (data as Record<string, unknown>[]).map((e): ExtItem => ({ id: str(e.sourceName ?? e.name), name: str(e.sourceName ?? e.name), lang: str(e.language ?? ''), site: str(e.baseUrl ?? ''), version: str(e.version), icon: abs(str(e.iconUrl)), url: abs(str(e.scriptUrl)), kind: 'sora', runnable: false, note: 'iosModule', itemType: /novel/i.test(str(e.type)) ? 'novel' : 'other' }));
    return { kind: 'sora', items, count: { novel: items.filter((i) => i.itemType === 'novel').length, other: items.filter((i) => i.itemType !== 'novel').length } };
  }
  // Mihon / Tachiyomi / IReader / Kotatsu-like: [{name, pkg, apk, lang, code, version, nsfw, sources:[…]}]
  if (Array.isArray(data) && data.length && data.every((e) => e && typeof e === 'object' && ('apk' in (e as object) || 'pkg' in (e as object)))) {
    const ireader = (data as Record<string, unknown>[]).some((e) => /ireader/i.test(str(e.pkg)) || /ireader/i.test(url));
    const items = (data as Record<string, unknown>[]).map((e): ExtItem => ({ id: str(e.pkg ?? e.name), name: str(e.name).replace(/^(Tachiyomi|Mihon|IReader):\s*/i, ''), lang: str(e.lang), site: str(((e.sources as Record<string, unknown>[] | undefined)?.[0])?.baseUrl ?? ''), version: str(e.version), icon: abs(`icon/${str(e.pkg)}.png`), url: abs(str(e.apk)), kind: ireader ? 'ireader' : 'mihon', runnable: false, note: 'apkExtension', itemType: ireader ? 'novel' : 'manga', nsfw: Number(e.nsfw) === 1 }));
    return { kind: ireader ? 'ireader' : 'mihon', items, count: { novel: items.filter((i) => i.itemType === 'novel').length, other: items.filter((i) => i.itemType !== 'novel').length } };
  }
  // Mangayomi's repo.json (a name only; the indexes sit beside it).
  if (data && typeof data === 'object' && 'website' in (data as object) && !('items' in (data as object))) return { kind: 'unknown', name: str((data as Record<string, unknown>).name), items: [], count: { novel: 0, other: 0 } };
  return null;
}

/** Fetch the index behind what the reader gave: the first candidate that reads as a repo. */
export async function resolveRepo(given: string): Promise<{ url: string; parsed: Parsed }> {
  const list = candidates(given);
  if (!list.length) throw new SourceError('badRepoUrl', 'parse');
  let lastError: unknown = null; let sawSomething = false;
  for (const url of list) {
    let text: string;
    try { text = await fetchText(url, { retries: 0 }); }
    catch (e) { lastError = e; if ((e as SourceError).kind === 'offline' || (e as SourceError).kind === 'cors') throw e; continue; }
    sawSomething = true;
    const parsed = parseIndex(url, text);
    if (parsed && (parsed.items.length || parsed.kind !== 'unknown')) {
      // (Mangayomi keeps the novels apart in novel_index.json: when the index found has none, the one beside
      // it is looked for; a repo.json names the repo and nothing more.)
      if ((parsed.kind === 'unknown' || (parsed.kind === 'mangayomi' && !parsed.count.novel)) && !/novel_index\.json$/.test(url)) {
        const sib = url.replace(/[^/]*$/, 'novel_index.json');
        try { const t2 = await fetchText(sib, { retries: 0 }); const p2 = parseIndex(sib, t2); if (p2 && p2.items.length) return { url: sib, parsed: { ...p2, name: parsed.name ?? p2.name } }; } catch { /* no novels index beside it */ }
        if (parsed.kind === 'unknown') continue;
      }
      return { url, parsed };
    }
  }
  if (lastError && !sawSomething) throw lastError;
  throw new SourceError('noIndex', 'parse');
}

/** Add a repo; refuses one already added (the same index under any address, or the very same list). */
export async function addRepo(given: string): Promise<{ repo: Repo; added: boolean }> {
  const repos = await listRepos();
  const { url, parsed } = await resolveRepo(given);
  const norm = normalizeUrl(url);
  const dup = repos.find((r) => normalizeUrl(r.url) === norm || normalizeUrl(r.given) === normalizeUrl(given) || (r.items.length && r.items.length === parsed.items.length && r.kind === parsed.kind && r.items.every((it, i) => it.id === parsed.items[i]?.id && it.url === parsed.items[i]?.url)));
  if (dup) return { repo: dup, added: false };
  const name = parsed.name || nameOf(url, parsed.kind);
  const repo: Repo = { key: hashKey(norm), url, given, name, kind: parsed.kind, addedAt: Date.now(), fetchedAt: Date.now(), items: parsed.items, count: parsed.count };
  await saveRepos([...repos, repo]);
  return { repo, added: true };
}
function nameOf(url: string, kind: RepoKind): string {
  const m = /^https?:\/\/(?:raw\.githubusercontent\.com|github\.com|gitlab\.com)\/([^/]+)\/([^/]+)/i.exec(url);
  if (m) return `${m[1]}/${m[2]}`;
  try { return new URL(url).host; } catch { return KIND_APP[kind]; }
}
export async function removeRepo(key: string): Promise<void> {
  const repos = await listRepos();
  const repo = repos.find((r) => r.key === key);
  await saveRepos(repos.filter((r) => r.key !== key));
  if (repo) for (const it of repo.items) { await db.deleteMeta(codeKey(key, it.id)); try { localStorage.removeItem(`kr.ext.store.${pluginKey(key, it.id)}`); localStorage.removeItem(`kr.ext.filters.${pluginKey(key, it.id)}`); } catch { /* ignore */ } }
}
export async function renameRepo(key: string, name: string): Promise<void> {
  const repos = await listRepos(); const r = repos.find((x) => x.key === key); if (!r) return; r.name = name; await saveRepos([...repos]);
}
/** Fetch the index again; the items change, the key stays. Returns the items whose version moved. */
export async function refreshRepo(key: string): Promise<{ repo: Repo; updated: ExtItem[] }> {
  const repos = await listRepos(); const r = repos.find((x) => x.key === key); if (!r) throw new SourceError('noRepo', 'parse');
  const text = await fetchText(r.url);
  const parsed = parseIndex(r.url, text); if (!parsed) throw new SourceError('noIndex', 'parse');
  const updated: ExtItem[] = [];
  for (const it of parsed.items) { const code = await db.getMeta<CodeCache>(codeKey(key, it.id)); if (code && code.version !== it.version) updated.push(it); }
  r.items = parsed.items; r.count = parsed.count; r.fetchedAt = Date.now(); r.error = undefined; if (parsed.name) r.name = parsed.name;
  await saveRepos([...repos]);
  return { repo: r, updated };
}

/* ---------- the plugins' code ---------- */
export interface CodeCache { version: string; code: string; at: number; url: string }
export const pluginKey = (repoKey: string, pluginId: string) => `${repoKey}:${pluginId}`;
const codeKey = (repoKey: string, pluginId: string) => `ext:code:${repoKey}:${pluginId}`;

/** The plugin's code, from the device when it was fetched before (an update is fetched when `fresh`). */
export async function pluginCode(repo: Repo, item: ExtItem, fresh = false): Promise<CodeCache> {
  const key = codeKey(repo.key, item.id);
  const had = await db.getMeta<CodeCache>(key);
  if (had && !fresh && had.version === item.version) return had;
  if (had && !fresh) return had;   // (an older version runs until the reader updates it)
  const r = await request(item.url, { headers: { accept: 'text/javascript, application/javascript, */*' }, retries: 1 });
  if (r.status >= 400) throw new SourceError(`HTTP ${r.status}`, 'http', r.status);
  const code = r.body;
  if (!code || code.length < 20) throw new SourceError('parse', 'parse');
  const entry: CodeCache = { version: item.version, code, at: Date.now(), url: item.url };
  await db.setMeta(key, entry);
  return entry;
}
export async function cachedVersion(repo: Repo, item: ExtItem): Promise<string | null> { return (await db.getMeta<CodeCache>(codeKey(repo.key, item.id)))?.version ?? null; }
export async function hasCode(repo: Repo, item: ExtItem): Promise<boolean> { return !!(await db.getMeta<CodeCache>(codeKey(repo.key, item.id))); }

/** The extensions whose repo lists a newer version than the one on the device. */
export async function extensionUpdates(): Promise<{ repo: Repo; item: ExtItem; from: string }[]> {
  const out: { repo: Repo; item: ExtItem; from: string }[] = [];
  for (const repo of await listRepos()) for (const item of repo.items) {
    if (!item.runnable) continue;
    const v = await cachedVersion(repo, item);
    if (v && v !== item.version && newer(item.version, v)) out.push({ repo, item, from: v });
  }
  return out;
}
export function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] ?? 0, y = pb[i] ?? 0; if (x !== y) return x > y; }
  return false;
}
/** Short language label for a badge. */
export function langLabel(lang: string): string {
  const s = lang.replace(/[‎‏]/g, '').trim();
  const known: Record<string, string> = { english: 'EN', 'العربية': 'AR', 'русский': 'RU', 'español': 'ES', 'français': 'FR', 'türkçe': 'TR', 'português': 'PT', 'bahasa indonesia': 'ID', 'tiếng việt': 'VI', '日本語': 'JA', 'ไทย': 'TH', 'українська': 'UK', 'বাংলা': 'BN', 'polski': 'PL', multi: 'ALL', all: 'ALL' };
  if (/^[a-z]{2,3}([-_][a-z]{2,4})?$/i.test(s)) return s.slice(0, 2).toUpperCase();
  const k = s.toLowerCase(); if (known[k]) return known[k];
  if (/中文|汉语|漢語/.test(s)) return 'ZH'; if (/한국어|조선말/.test(s)) return 'KO';
  return s.slice(0, 3).toUpperCase();
}
