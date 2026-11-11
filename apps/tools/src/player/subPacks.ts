// A show's subtitle pack: a folder or an archive (.zip read here; .7z/.rar through the Archives code) of its subtitle
// files, assigned once — from the show's page or the player — and each episode's file then loaded by itself when it
// plays (./subMatch decides which). Kept per show (AniList id, IMDb id, else the title) in localStorage
// 'kt.subPacks': where it is, whether it is on, the kind of file chosen when an episode has several, the user's own
// shift, and files chosen by hand for single episodes.
import { ktPlugin } from '../native';
import { readLocal } from './files';
import { SUB_RE, FONT_RE, packItems, matchEpisode, pickCandidate, type PackItem, type Want } from './subMatch';

export interface PackSource { path: string; kind: 'folder' | 'archive' }
export interface SubPack extends PackSource { at: number; on: boolean; title?: string; /** The kind of file (./subMatch variantOf) chosen when an episode has several. */ filter?: string; /** File number = episode + shift (set by hand). */ shift?: number; /** Files chosen by hand: «season:episode» → the file's id (./packFileId). */ manual?: Record<string, string>; /** More places (the show's downloaded subtitles folder beside another pack). */ more?: PackSource[]; /** Episodes per season ('' for a show without seasons), told by the show's page. */ lengths?: Record<string, number> }
export interface PackFile extends PackItem { src: PackSource; /** The entry inside an archive / the full path in a folder. */ ref: string }
export interface PackScan { files: PackFile[]; fonts: PackFile[] }
type ShowMeta = { anilistId?: number; imdbId?: string; title?: string } | undefined;

const KEY = 'kt.subPacks';
const all = (): Record<string, SubPack> => { try { return (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, SubPack>) ?? {}; } catch { return {}; } };
const save = (x: Record<string, SubPack>) => { try { localStorage.setItem(KEY, JSON.stringify(x)); } catch { /* full */ } };
const normTitle = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** The show's key: its AniList id, its IMDb id, else its title made plain. */
export function showKey(m: ShowMeta): string | null { if (m?.anilistId) return `al:${m.anilistId}`; if (m?.imdbId) return `imdb:${m.imdbId}`; const n = normTitle(m?.title ?? ''); return n ? `t:${n}` : null; }
export const packOf = (key: string | null): SubPack | null => (key ? all()[key] ?? null : null);
export function setPack(key: string, p: SubPack | null): void { const x = all(); if (p) x[key] = p; else delete x[key]; save(x); scans.clear(); }
export function updatePack(key: string, patch: Partial<SubPack>): SubPack | null { const x = all(); const cur = x[key]; if (!cur) return null; x[key] = { ...cur, ...patch }; save(x); return x[key]; }
export const epKey = (season: number | undefined, episode: number) => `${season ?? ''}:${episode}`;
export const packFileId = (f: PackFile) => `${f.src.path}|${f.ref}`;
export function setManual(key: string, season: number | undefined, episode: number, f: PackFile | null): void { const p = packOf(key); if (!p) return; const manual = { ...(p.manual ?? {}) }; if (f) manual[epKey(season, episode)] = packFileId(f); else delete manual[epKey(season, episode)]; updatePack(key, { manual }); }
/** Adds a place to a show's pack (or makes it the pack when it has none). */
export function addToPack(key: string, src: PackSource, title?: string): void {
  const p = packOf(key); if (!p) { setPack(key, { ...src, at: Date.now(), on: true, title }); return; }
  if (p.path === src.path || p.more?.some((m) => m.path === src.path)) { updatePack(key, { on: true }); scans.clear(); return; }
  updatePack(key, { on: true, more: [...(p.more ?? []), src] }); scans.clear();
}

/* ---------- reading a pack ---------- */
type Ent = { name: string; path: string; dir: boolean; size: number };
async function listFolder(path: string): Promise<Ent[]> {
  const d = window.kurokawaTools as unknown as { listDir?(p: string): Promise<{ entries: Ent[] }> } | undefined;
  if (d?.listDir) return (await d.listDir(path)).entries ?? [];
  const p = ktPlugin() as unknown as { filesList?(o: { path: string; hidden?: boolean }): Promise<{ entries: Ent[] }> } | null;
  if (p?.filesList) return (await p.filesList({ path, hidden: false })).entries ?? [];
  throw new Error('unsupported');
}
const zips = new Map<string, Blob>(); const scans = new Map<string, Promise<PackScan>>();
async function scanOne(src: PackSource): Promise<PackScan> {
  const subs: { rel: string; ref: string }[] = []; const fonts: { rel: string; ref: string }[] = [];
  const take = (rel: string, ref: string) => { if (/(^|\/)__MACOSX\//.test(rel)) return; if (SUB_RE.test(rel)) subs.push({ rel, ref }); else if (FONT_RE.test(rel)) fonts.push({ rel, ref }); };
  if (src.kind === 'folder') {
    // (Three levels: «Season 2/Arabic/05.ass», «Fonts/»; a few thousand files at most.)
    const walk = async (dir: string, rel: string, depth: number) => { for (const e of await listFolder(dir)) { if (subs.length + fonts.length > 4000) return; const r = rel ? `${rel}/${e.name}` : e.name; if (e.dir) { if (depth < 3 && !e.name.startsWith('.')) await walk(e.path, r, depth + 1); } else take(r, e.path); } };
    await walk(src.path, '', 0);
  } else if (/\.zip$/i.test(src.path)) {
    const bytes = await readLocal(src.path); if (!bytes) throw new Error('unreadable');
    const blob = new Blob([bytes as BlobPart]); zips.set(src.path, blob);
    const { zipEntries } = await import('../ipa/zip'); for (const e of await zipEntries(blob)) if (!e.name.endsWith('/') && e.usize < 40e6) take(e.name, e.name);
  } else {
    const { listArchive } = await import('../archives'); for (const e of (await listArchive(src.path)).entries) if (!e.dir) take(e.path, e.path);
  }
  const items = packItems(subs.map((s) => s.rel)); const byRel = new Map(subs.map((s) => [s.rel, s.ref]));
  return { files: items.map((i) => ({ ...i, src, ref: byRel.get(i.path)! })), fonts: fonts.map((f) => ({ path: f.rel, batch: false, src, ref: f.ref })) };
}
/** Every subtitle and font file of a pack (all its places), kept for the session. */
export function scanPack(p: SubPack, fresh = false): Promise<PackScan> {
  const k = [p.path, ...(p.more ?? []).map((m) => m.path)].join('\n'); if (fresh) scans.delete(k);
  let s = scans.get(k);
  if (!s) { s = (async () => { const out: PackScan = { files: [], fonts: [] }; for (const src of [p as PackSource, ...(p.more ?? [])]) { try { const r = await scanOne(src); out.files.push(...r.files); out.fonts.push(...r.fonts); } catch (e) { if (src === p) throw e; } } return out; })(); scans.set(k, s); s.catch(() => scans.delete(k)); }
  return s;
}
/** One file of a pack, read (taken out of an archive when it is in one). */
export async function readPackFile(f: PackFile): Promise<Uint8Array | null> {
  if (f.src.kind === 'folder') return readLocal(f.ref);
  if (/\.zip$/i.test(f.src.path)) {
    let blob = zips.get(f.src.path); if (!blob) { const b = await readLocal(f.src.path); if (!b) return null; blob = new Blob([b as BlobPart]); zips.set(f.src.path, blob); }
    const { zipEntries, zipRead } = await import('../ipa/zip'); const e = (await zipEntries(blob)).find((x) => x.name === f.ref); return e ? zipRead(blob, e) : null;
  }
  const { extractArchiveJob } = await import('../archives'); const r = await extractArchiveJob({ path: f.src.path, dest: 'cache:', only: [f.ref], replace: 'replace' }).done;
  return readLocal(`${r.dest.replace(/[\\/]$/, '')}/${f.ref}`);
}
/** What is wanted of the pack for an episode: its season's length and the episodes before it (when the show's page
 *  told them), and the user's shift. */
export function wantFor(p: SubPack, season: number | undefined, episode: number): Want {
  const L = p.lengths ?? {}; const seasonLength = L[season !== undefined ? String(season) : ''] ?? L[''];
  let offset: number | undefined; if (season !== undefined && season > 1) { offset = 0; for (let s = 1; s < season; s++) { if (L[String(s)] === undefined) { offset = undefined; break; } offset += L[String(s)]; } }
  return { episode, season, seasonLength, offset, shift: p.shift };
}
/** The file for an episode: the one chosen by hand, else the match (the kind chosen before, the languages); with every
 *  candidate, for switching. */
export function fileFor(p: SubPack, scan: PackScan, w: Want, langs: string[]): { file?: PackFile; cands: PackFile[]; manual: boolean } {
  const man = p.manual?.[epKey(w.season, w.episode)]; const mf = man ? scan.files.find((f) => packFileId(f) === man) : undefined;
  const cands = matchEpisode(scan.files, w) as PackFile[];
  if (mf) return { file: mf, cands: cands.includes(mf) ? cands : [mf, ...cands], manual: true };
  return { file: pickCandidate(cands, p.filter, langs), cands, manual: false };
}

/* ---------- choosing one ---------- */
/** A folder or an archive picked on the device; null when none was. */
export async function pickPackSource(kind: 'folder' | 'archive'): Promise<PackSource | null> {
  if (kind === 'folder') {
    const d = window.kurokawaTools as unknown as { pickDir?(): Promise<string | null> } | undefined; let p: string | null | undefined;
    if (d?.pickDir) p = await d.pickDir(); else p = await (ktPlugin() as unknown as { pickDir?(): Promise<{ dir: string }> } | null)?.pickDir?.().then((r) => r.dir).catch(() => null);
    return p ? { path: p, kind: 'folder' } : null;
  }
  const { pickFiles } = await import('../archives'); const [p] = await pickFiles(false).catch(() => [] as string[]);
  return p ? { path: p, kind: /\.(zip|7z|rar)$/i.test(p) ? 'archive' : 'folder' } : null;
}
export const canPickPacks = (): boolean => !!((window.kurokawaTools as unknown as { pickDir?: unknown } | undefined)?.pickDir || ktPlugin());

/* ---------- the show's own subtitles folder ---------- */
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Show';
/** «<downloads>/Subtitles/<Show>», made when missing. */
export async function showFolder(title: string): Promise<string> {
  const { getSettings } = await import('../settings'); let base = getSettings().downloadDir;
  const d = window.kurokawaTools as unknown as { defaultDir?(): Promise<string>; writeText?(o: { path: string; text: string }): Promise<unknown> } | undefined; const pl = ktPlugin() as unknown as { defaultDir?(): Promise<{ dir: string }>; filesMkdir?(o: { path: string }): Promise<unknown> } | null;
  if (!base) base = d?.defaultDir ? await d.defaultDir() : (await pl?.defaultDir?.())?.dir ?? '';
  if (!base) throw new Error('unsupported');
  const dir = `${base.replace(/[\\/]$/, '')}/Subtitles/${safeName(title)}`; await pl?.filesMkdir?.({ path: dir }).catch(() => undefined); return dir;
}
/** A subtitle's text written into a folder (UTF-8). */
export async function writeSubText(dir: string, name: string, text: string): Promise<string> {
  const path = `${dir}/${safeName(name)}`;
  const pl = ktPlugin() as unknown as { filesWrite?(o: { path: string; text: string }): Promise<unknown> } | null; if (pl?.filesWrite) { await pl.filesWrite({ path, text }); return path; }
  const d = window.kurokawaTools as unknown as { writeText?(o: { path: string; text: string }): Promise<unknown> } | undefined; if (d?.writeText) { await d.writeText({ path, text }); return path; }
  throw new Error('unsupported');
}
