// A show's subtitle pack: a folder or an archive (.zip read here; .7z/.rar through the Archives code) of its subtitle
// files, assigned once — from the show's page or the player — and each episode's file then loaded by itself when it
// plays (./subMatch decides which). Kept per show (AniList id, IMDb id, else the title) in localStorage
// 'kt.subPacks': where it is, whether it is on, the kind of file chosen when an episode has several, the user's own
// shift, and files chosen by hand for single episodes.
import { ktPlugin } from '../native';
import { readLocal } from './files';
import { SUB_RE, FONT_RE, packItems, rankFiles, learnCorrection, learnKey, groupOf, langOfName, type PackItem, type Want, type Ranked, type Learned } from './subMatch';

/** A place of a show's subtitles: a folder by its path (read live: files added later are found), a folder tree the
 *  phone granted (`tree`: its content: address, read live through the Files code's kept grants), or an archive. */
export interface PackSource { path: string; kind: 'folder' | 'archive' | 'tree'; /** A tree's name, as the phone shows it. */ label?: string }
export interface SubPack extends PackSource { at: number; on: boolean; /** A film's: one file plays (no episodes), the others kept beside it as languages. */ movie?: boolean; title?: string; /** The kind of file (./subMatch variantOf) chosen when an episode has several. */ filter?: string; /** File number = episode + shift (set by hand). */ shift?: number; /** Files chosen by hand: «season:episode» → the file's id (./packFileId). */ manual?: Record<string, string>; /** More places (the show's downloaded subtitles folder beside another pack, a second group, a second language), in order. */ more?: PackSource[]; /** Episodes per season ('' for a show without seasons), told by the show's page. */ lengths?: Record<string, number>;
  /** What corrections taught, by ./subMatch learnKey(source, season). */ learned?: Record<string, Learned>; /** The release group chosen last. */ lastGroup?: string }
export interface PackFile extends PackItem { src: PackSource; /** The entry inside an archive / the full path in a folder. */ ref: string }
export interface PackScan { files: PackFile[]; fonts: PackFile[]; /** Sources that could not be read, with why. */ errors?: { src: PackSource; why: string }[] }
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

/** The pack's places, in order (the first one first). */
export const sourcesOf = (p: SubPack): PackSource[] => [{ path: p.path, kind: p.kind, label: p.label }, ...(p.more ?? [])];
/** The pack with its places set anew (none left: the pack goes). */
function setSources(key: string, list: PackSource[]): void {
  const p = packOf(key); if (!p) return; if (!list.length) { setPack(key, null); return; }
  const [first, ...rest] = list; const learned = Object.fromEntries(Object.entries(p.learned ?? {}).filter(([k]) => list.some((x) => k.startsWith(`${x.path}|`))));
  setPack(key, { ...p, path: first.path, kind: first.kind, label: first.label, more: rest.length ? rest : undefined, learned });
}
export function removeSource(key: string, path: string): void { const p = packOf(key); if (p) setSources(key, sourcesOf(p).filter((x) => x.path !== path)); }
/** A place moved one up (earlier places win a tie). */
export function raiseSource(key: string, path: string): void { const p = packOf(key); if (!p) return; const l = sourcesOf(p); const i = l.findIndex((x) => x.path === path); if (i > 0) { [l[i - 1], l[i]] = [l[i], l[i - 1]]; setSources(key, l); } }
/** «Forget corrections»: the files chosen by hand, the shifts and kinds learned from them. */
export function forgetCorrections(key: string): void { updatePack(key, { manual: undefined, learned: undefined, shift: undefined, filter: undefined, lastGroup: undefined }); }
export const hasCorrections = (p: SubPack): boolean => !!(Object.keys(p.manual ?? {}).length || Object.keys(p.learned ?? {}).length || p.shift || p.filter);

/* ---------- reading a pack ---------- */
type Ent = { name: string; path: string; dir: boolean; size: number };
async function listFolder(path: string): Promise<Ent[]> {
  const d = window.kurokawaTools as unknown as { listDir?(p: string): Promise<{ entries: Ent[] }> } | undefined;
  if (d?.listDir) return (await d.listDir(path)).entries ?? [];
  const p = ktPlugin() as unknown as { filesList?(o: { path: string; hidden?: boolean }): Promise<{ entries: Ent[] }> } | null;
  if (p?.filesList) return (await p.filesList({ path, hidden: false })).entries ?? [];
  throw new Error('unsupported');
}
type Vfs = { vfsRoots?(): Promise<{ trees: { id: number; uri: string; name: string }[] }>; vfsList?(o: { path: string }): Promise<{ entries: { name: string; dir: boolean; size: number }[] }>; vfsFetch?(o: { path: string; jobId?: string }): Promise<{ path: string }> };
/** A granted tree's place in the Files code's list (its number changes when another is forgotten): by its address. */
async function treeRoot(uri: string): Promise<string> {
  const v = ktPlugin() as unknown as Vfs | null; const r = await v?.vfsRoots?.(); const tr = r?.trees?.find((x) => x.uri === uri);
  if (!tr) throw new Error('tree'); return `saf://${tr.id}`;
}
/** The granted trees (their names, for the sheet). */
export async function treeName(uri: string): Promise<string | undefined> { try { const v = ktPlugin() as unknown as Vfs | null; return (await v?.vfsRoots?.())?.trees?.find((x) => x.uri === uri)?.name; } catch { return undefined; } }
const zips = new Map<string, Blob>(); const scans = new Map<string, { at: number; live: boolean; p: Promise<PackScan> }>();
/** (A folder is read live: its listing is kept a few seconds only.) */
const LIVE_MS = 15000;
async function scanOne(src: PackSource): Promise<PackScan> {
  const subs: { rel: string; ref: string }[] = []; const fonts: { rel: string; ref: string }[] = [];
  const take = (rel: string, ref: string) => { if (/(^|\/)__MACOSX\//.test(rel)) return; if (SUB_RE.test(rel)) subs.push({ rel, ref }); else if (FONT_RE.test(rel)) fonts.push({ rel, ref }); };
  if (src.kind === 'folder') {
    // (Three levels: «Season 2/Arabic/05.ass», «Fonts/»; a few thousand files at most.)
    const walk = async (dir: string, rel: string, depth: number) => { for (const e of await listFolder(dir)) { if (subs.length + fonts.length > 4000) return; const r = rel ? `${rel}/${e.name}` : e.name; if (e.dir) { if (depth < 3 && !e.name.startsWith('.')) await walk(e.path, r, depth + 1); } else take(r, e.path); } };
    await walk(src.path, '', 0);
  } else if (src.kind === 'tree') {
    const v = ktPlugin() as unknown as Vfs | null; if (!v?.vfsList) throw new Error('unsupported'); const root = await treeRoot(src.path);
    const walk = async (rel: string, depth: number) => { for (const e of (await v.vfsList!({ path: rel ? `${root}/${rel}` : `${root}/` })).entries ?? []) { if (subs.length + fonts.length > 4000) return; const r = rel ? `${rel}/${e.name}` : e.name; if (e.dir) { if (depth < 3 && !e.name.startsWith('.')) await walk(r, depth + 1); } else take(r, r); } };
    await walk('', 0);
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
  const list = sourcesOf(p); const k = list.map((m) => m.path).join('\n'); const c = scans.get(k);
  if (c && !fresh && !(c.live && Date.now() - c.at > LIVE_MS)) return c.p;
  const s = (async () => { const out: PackScan = { files: [], fonts: [], errors: [] }; let read = 0; for (const src of list) { try { const r = await scanOne(src); out.files.push(...r.files); out.fonts.push(...r.fonts); read++; } catch (e) { out.errors!.push({ src, why: String((e as Error)?.message ?? e) }); } } if (!read) throw new Error(out.errors![0]?.why ?? 'unreadable'); return out; })();
  scans.set(k, { at: Date.now(), live: list.some((x) => x.kind !== 'archive'), p: s }); s.catch(() => scans.delete(k));
  return s;
}
/** One file of a pack, read (taken out of an archive when it is in one). */
export async function readPackFile(f: PackFile): Promise<Uint8Array | null> {
  if (f.src.kind === 'folder') return readLocal(f.ref);
  if (f.src.kind === 'tree') { const v = ktPlugin() as unknown as Vfs | null; const r = await v?.vfsFetch?.({ path: `${await treeRoot(f.src.path)}/${f.ref}`, jobId: `sp${Date.now().toString(36)}` }); return r?.path ? readLocal(r.path) : null; }
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
/** What the player knows of the episode beyond its number: the video's own name, its length, the show's titles, the
 *  cue spans read of the candidates. */
export interface PickExtra { videoName?: string; duration?: number; titles?: string[]; spans?: Map<string, { first: number; last: number }> }
export interface PickResult { file?: PackFile; cands: PackFile[]; manual: boolean; /** Every candidate with its score and why. */ ranked: Ranked<PackFile & { source: string; first?: number; last?: number }>[]; /** The pick was a low-confidence guess. */ guess: boolean }
/** The file for an episode: the one chosen by hand, else the best of ./subMatch rankFiles (what corrections taught,
 *  the languages, the groups, the kind, the cue spans); with every candidate, for switching. */
export function fileFor(p: SubPack, scan: PackScan, w: Want, langs: string[], x: PickExtra = {}): PickResult {
  const man = p.manual?.[epKey(w.season, w.episode)]; const mf = man ? scan.files.find((f) => packFileId(f) === man) : undefined;
  const ins = scan.files.map((f) => Object.assign(f, { source: f.src.path, first: x.spans?.get(packFileId(f))?.first, last: x.spans?.get(packFileId(f))?.last }));
  const ranked = rankFiles(ins, { episode: w.episode, season: w.season, absolute: w.offset !== undefined ? w.offset + w.episode : undefined, seasonLength: w.seasonLength, titles: x.titles, videoName: x.videoName, duration: x.duration, langs, lastGroup: p.lastGroup, learned: p.learned, shift: p.shift ?? w.shift, filter: p.filter });
  const cands = ranked.map((r) => r.file as PackFile);
  if (mf) return { file: mf, cands: cands.includes(mf) ? cands : [mf, ...cands], manual: true, ranked, guess: false };
  return { file: cands[0], cands, manual: false, ranked, guess: !!ranked[0]?.guess };
}
/** A file chosen by hand for an episode (null: back to automatic): kept for it, and what it teaches — its source's
 *  shift, its kind, group and language — kept for that source's next episodes. The shift learned, when there is one. */
export function correct(key: string, w: Want, f: PackFile | null): Learned | null {
  setManual(key, w.season, w.episode, f); const p = packOf(key); if (!p) return null;
  // (Back to automatic: what this episode's correction taught goes with it.)
  if (!f) { const from = epKey(w.season, w.episode); const learned = Object.fromEntries(Object.entries(p.learned ?? {}).filter(([, v]) => v.from !== from)); updatePack(key, { learned }); return null; }
  const L = learnCorrection({ path: f.path, source: f.src.path }, { episode: w.episode, season: w.season, absolute: w.offset !== undefined ? w.offset + w.episode : undefined });
  const learned = { ...(p.learned ?? {}), [learnKey(f.src.path, w.season)]: { ...L, from: epKey(w.season, w.episode) } };
  updatePack(key, { learned, lastGroup: groupOf(f.path) ?? p.lastGroup, shift: undefined, filter: undefined });
  return L;
}
/** The files of each place: how many, how many are an episode's (for the episodes asked), the others. */
export function sourceStats(p: SubPack, scan: PackScan, wants: Want[], langs: string[]): { src: PackSource; files: number; matched: number; unmatched: PackFile[]; error?: string }[] {
  const hit = new Set<PackFile>(); for (const w of wants) for (const f of fileFor({ ...p, manual: undefined }, scan, w, langs).cands) hit.add(f);
  for (const id of Object.values(p.manual ?? {})) { const f = scan.files.find((x) => packFileId(x) === id); if (f) hit.add(f); }
  return sourcesOf(p).map((src) => { const mine = scan.files.filter((f) => f.src.path === src.path); const err = scan.errors?.find((e) => e.src.path === src.path)?.why; return { src, files: mine.length, matched: mine.filter((f) => hit.has(f)).length, unmatched: mine.filter((f) => !hit.has(f)), error: err }; });
}

/* ---------- choosing one ---------- */
/** A folder or an archive picked on the device; null when none was. */
export async function pickPackSource(kind: 'folder' | 'archive'): Promise<PackSource | null> {
  if (kind === 'folder') {
    const d = window.kurokawaTools as unknown as { pickDir?(): Promise<string | null> } | undefined; let p: string | null | undefined;
    if (d?.pickDir) p = await d.pickDir(); else p = await (ktPlugin() as unknown as { pickDir?(): Promise<{ dir: string }> } | null)?.pickDir?.().then((r) => r.dir).catch(() => null);
    // (A tree the phone has no path for: kept by its address, read live through the kept grant.)
    if (p && /^content:/.test(p)) return { path: p, kind: 'tree', label: await treeName(p) };
    return p ? { path: p, kind: 'folder' } : null;
  }
  const { pickFiles } = await import('../archives'); const [p] = await pickFiles(false).catch(() => [] as string[]);
  return p ? { path: p, kind: /\.(zip|7z|rar)$/i.test(p) ? 'archive' : 'folder' } : null;
}
/** A folder path typed or pasted (a computer): checked by listing it. */
export async function typedFolder(path: string): Promise<PackSource> {
  const p = path.trim().replace(/^["']|["']$/g, '').replace(/[\\/]+$/, ''); if (!p) throw new Error('empty');
  if (/\.(zip|7z|rar)$/i.test(p)) return { path: p, kind: 'archive' };
  const d = window.kurokawaTools as unknown as { listDir?(p: string): Promise<{ exists?: boolean; entries: Ent[] }> } | undefined;
  const r = await d?.listDir?.(p); if (!r || r.exists === false) throw new Error('missing'); return { path: p, kind: 'folder' };
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

/* ---------- a film's pack ---------- */
/** The film's files, best first: chosen by hand, else those whose name carries the film's title and year, then the
 *  user's languages. `several`: more than one fits as well as the first (the page offers the choice). */
export function movieFileFor(p: SubPack, scan: PackScan, title: string, year: number | undefined, langs: string[]): { file?: PackFile; cands: PackFile[]; manual: boolean; several: boolean } {
  const man = p.manual?.[epKey(undefined, 0)]; const mf = man ? scan.files.find((f) => packFileId(f) === man) : undefined;
  const words = normTitle(title).split(' ').filter((w) => w.length > 1);
  const fit = (f: PackFile) => { const n = normTitle(f.path.split(/[\\/]/).pop() ?? f.path); return words.filter((w) => n.includes(w)).length / Math.max(1, words.length) + (year && n.includes(String(year)) ? 0.5 : 0); };
  const li = (f: PackFile) => { const l = langOfName(f.path); const i = l ? langs.indexOf(l) : -1; return i < 0 ? 99 : i; };
  // (Forced-only and hearing-impaired files come after the plain ones of the same fit and language, unless asked for by hand.)
  const odd = (f: PackFile) => (/(^|[^a-z])(forced|sdh|hi|cc)([^a-z]|$)/i.test(f.path.split(/[\\/]/).pop() ?? '') ? 1 : 0);
  const cands = [...scan.files].sort((a, b) => fit(b) - fit(a) || li(a) - li(b) || odd(a) - odd(b) || a.path.localeCompare(b.path));
  const top = cands[0]; const several = !!top && cands.filter((c) => fit(c) === fit(top) && li(c) === li(top) && odd(c) === odd(top)).length > 1;
  if (mf) return { file: mf, cands: [mf, ...cands.filter((c) => c !== mf)], manual: true, several: false };
  return { file: top, cands, manual: false, several };
}
