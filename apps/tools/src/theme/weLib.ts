// Wallpaper Engine's wallpapers on this computer, READ ONLY (Settings → Appearance → Your pictures and videos →
// Wallpaper Engine): no Steam API, no network, nothing run or loaded from a wallpaper's folder — only its project.json
// (read as data, capped), its preview picture (decoded with the custom covers' pixel cap) and, when the reader picks a
// VIDEO wallpaper, its video file, which is then copied into the app's own library (theme/bgLib.ts).
// Where: the Steam libraries — Steam's usual folders (Windows: Program Files and the drives' Steam/SteamLibrary
// folders; Linux: ~/.steam, ~/.local/share/Steam and the Flatpak's), each one's steamapps/libraryfolders.vdf for the
// others (the registry is not read: the shells offer no way to read it) — and in each, the Workshop's
// steamapps/workshop/content/431960/<id>/ and Wallpaper Engine's own projects/myprojects and projects/defaultprojects;
// or a folder the reader chooses. Every path is built from a detected (or chosen) folder and names that are checked:
// no «..», no absolute path, no drive, no separator in a folder's name — nothing outside that folder can be reached.
// Uses only the shells' existing file methods: listDir, pathInfo, readFile, pickDir, homeDir/filesRoots/roots.
import { sniffImage, imageSize, MAX_PIXELS } from '../anime/covers';

export interface WeBridge {
  listDir(p: string): Promise<{ entries: { name: string; path: string; dir: boolean; size: number; mtime: number }[]; exists: boolean }>;
  pathInfo(p: string): Promise<{ exists: boolean; dir?: boolean; size?: number; name?: string; parent?: string }>;
  readFile(p: string): Promise<ArrayBuffer>;
  pickDir?(): Promise<string | null>;
  homeDir?(): Promise<string>;
  filesRoots?(): Promise<{ roots?: { kind?: string; path?: string }[] }>;
  roots?(): Promise<{ roots?: string[] }>;
  os?: string;
}
/** The shell's bridge when it has what this needs (a computer's shell), else null (the web build). */
export function weBridge(): WeBridge | null {
  const b = (window as unknown as { kurokawaTools?: Partial<WeBridge> }).kurokawaTools;
  return b && typeof b.listDir === 'function' && typeof b.pathInfo === 'function' && typeof b.readFile === 'function' ? (b as WeBridge) : null;
}

/* ---------- caps ---------- */
/** project.json: at most 256 KB; a libraryfolders.vdf at most 512 KB; at most 32 Steam libraries; at most 5000
 *  wallpapers listed; a preview picture at most 16 MB (and 40 megapixels); at most 32 tags of 40 characters each. */
export const PROJECT_MAX = 256 * 1024, VDF_MAX = 512 * 1024, MAX_LIBS = 32, MAX_WALLPAPERS = 5000, PREVIEW_MAX = 16 * 1024 * 1024, TAGS_MAX = 32, TAG_LEN = 40, TITLE_LEN = 120;
export type WeType = 'video' | 'scene' | 'web' | 'application' | 'unknown';
export type SourceKind = 'workshop' | 'mine' | 'default' | 'chosen';
export interface WeSource { kind: SourceKind; path: string }
export interface WeItem {
  /** Unique in the list: the source and the folder's name. */
  key: string; dir: string; folder: string; source: SourceKind; title: string; type: WeType;
  /** The video (or other) file and the preview picture: full paths inside the wallpaper's folder, or null. */
  file: string | null; preview: string | null; tags: string[]; mtime: number;
  /** What was refused in its project.json (a path leaving the folder, a wrong type). */
  refused: string[];
}

/* ---------- paths ---------- */
export const isWinPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
const sepOf = (p: string): string => (isWinPath(p) ? '\\' : '/');
export function join(base: string, ...parts: string[]): string { const s = sepOf(base); return [base.replace(/[\\/]+$/, ''), ...parts].join(s); }
const norm = (p: string, win: boolean): string => { const x = p.replace(/[\\/]+/g, '/').replace(/\/+$/, ''); return win ? x.toLowerCase() : x; };
/** `p` inside `root` (or `root` itself): compared segment by segment, case-blind on Windows. */
export function inside(root: string, p: string): boolean {
  const win = isWinPath(root); const r = norm(root, win), q = norm(p, win);
  if (q.split('/').some((s) => s === '..' || s === '.')) return false;
  return q === r || q.startsWith(r + '/');
}
/** A folder's name from a listing: one plain name (no separator, not «.» or «..», no control character). */
export const plainName = (n: unknown): n is string => typeof n === 'string' && n.length > 0 && n.length <= 255 && !/[\\/\u0000-\u001f]/.test(n) && n !== '.' && n !== '..';
/** A path written in a project.json: relative, inside its folder — the names it is made of, or null. */
export function safeRel(v: unknown): string[] | null {
  if (typeof v !== 'string' || !v.length || v.length > 260 || /[\u0000-\u001f:*?"<>|]/.test(v) || /^[\\/]/.test(v)) return null;
  const segs = v.split(/[\\/]+/).filter(Boolean);
  if (!segs.length || segs.some((s) => s === '.' || s === '..' || s.length > 255 || /^\s|\s$/.test(s))) return null;
  return segs;
}
const clean = (v: string, n: number): string => [...v.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, n).join('').trim();
const VIDEO_EXT = /\.(mp4|webm|m4v|mov|mkv)$/i, PIC_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** A project.json (its text) read as data: what can be shown, every field checked; null when it is not one. */
export function parseProject(text: string, dir: string, folder: string, source: SourceKind, mtime: number): WeItem | null {
  let raw: unknown; try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>; const refused: string[] = [];
  const title = typeof o.title === 'string' && clean(o.title, TITLE_LEN) ? clean(o.title, TITLE_LEN) : clean(folder, TITLE_LEN);
  const t = typeof o.type === 'string' ? o.type.trim().toLowerCase() : '';
  const type: WeType = t === 'video' || t === 'scene' || t === 'web' || t === 'application' ? t : 'unknown';
  if (o.type !== undefined && type === 'unknown') refused.push('type');
  const path = (field: 'file' | 'preview', ext: RegExp): string | null => {
    if (o[field] === undefined) return null;
    const segs = safeRel(o[field]); if (!segs || !ext.test(segs[segs.length - 1])) { refused.push(field); return null; }
    const full = join(dir, ...segs); if (!inside(dir, full)) { refused.push(field); return null; }
    return full;
  };
  const file = path('file', type === 'video' ? VIDEO_EXT : /\.[a-z0-9]{1,8}$/i);
  const preview = path('preview', PIC_EXT);
  const tags: string[] = [];
  if (Array.isArray(o.tags)) for (const x of o.tags) { if (typeof x === 'string') { const c = clean(x, TAG_LEN); if (c && !tags.includes(c)) tags.push(c); } if (tags.length >= TAGS_MAX) break; }
  else if (o.tags !== undefined) refused.push('tags');
  return { key: `${source}:${folder}`, dir, folder, source, title, type, file, preview, tags, mtime: Number.isFinite(mtime) ? mtime : 0, refused };
}
/** The libraries a libraryfolders.vdf names (its «path» values): absolute, no «..», at most MAX_LIBS. */
export function vdfLibraries(text: string, win: boolean): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/gi)) {
    const p = m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    if (p.length > 1024 || /[\u0000-\u001f]/.test(p) || p.split(/[\\/]+/).some((s) => s === '..')) continue;
    if (win ? !/^[A-Za-z]:[\\/]/.test(p) : !p.startsWith('/')) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= MAX_LIBS) break;
  }
  return out;
}

/* ---------- finding ---------- */
async function isDir(b: WeBridge, p: string): Promise<boolean> { try { const i = await b.pathInfo(p); return !!i?.exists && !!i.dir; } catch { return false; } }
async function readText(b: WeBridge, p: string, max: number): Promise<string | null> {
  try {
    const i = await b.pathInfo(p); if (!i?.exists || i.dir || typeof i.size !== 'number' || i.size > max) return null;
    const buf = await b.readFile(p); if (!(buf instanceof ArrayBuffer) || buf.byteLength > max) return null;
    return new TextDecoder('utf-8').decode(buf);
  } catch { return null; }
}
/** The home folder, as the shell gives it. */
async function homeOf(b: WeBridge): Promise<string> {
  try { const h = await b.homeDir?.(); if (typeof h === 'string' && h) return h; } catch { /* none */ }
  try { const r = await b.roots?.(); const l = r?.roots ?? []; const h = l[l.length - 1]; if (typeof h === 'string') return h; } catch { /* none */ }
  return '';
}
/** Where Steam usually is, on this computer's kind. */
async function steamGuesses(b: WeBridge, home: string, win: boolean): Promise<string[]> {
  if (!win) return home ? ['.steam/steam', '.steam/root', '.local/share/Steam', '.var/app/com.valvesoftware.Steam/.local/share/Steam', '.var/app/com.valvesoftware.Steam/data/Steam'].map((x) => join(home, ...x.split('/'))) : [];
  let drives: string[] = [];
  try { const r = await b.filesRoots?.(); drives = (r?.roots ?? []).filter((x) => x?.kind === 'drive' && typeof x.path === 'string' && /^[A-Za-z]:[\\/]?$/.test(x.path)).map((x) => x.path!.slice(0, 2) + '\\'); } catch { drives = []; }
  if (!drives.length) { const all = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`); const ok = await Promise.all(all.map((d) => isDir(b, d))); drives = all.filter((_, i) => ok[i]); }
  const out = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
  for (const d of drives) for (const x of ['Steam', 'SteamLibrary', 'Program Files (x86)\\Steam', 'Program Files\\Steam', 'Games\\Steam', 'Games\\SteamLibrary']) out.push(d + x);
  return [...new Set(out)];
}
/** The places of a Steam library (or Wallpaper Engine's own folder) that hold wallpapers. */
async function sourcesIn(b: WeBridge, lib: string): Promise<WeSource[]> {
  const cands: WeSource[] = [{ kind: 'workshop', path: join(lib, 'steamapps', 'workshop', 'content', '431960') }, { kind: 'mine', path: join(lib, 'steamapps', 'common', 'wallpaper_engine', 'projects', 'myprojects') }, { kind: 'default', path: join(lib, 'steamapps', 'common', 'wallpaper_engine', 'projects', 'defaultprojects') }];
  const ok = await Promise.all(cands.map((c) => isDir(b, c.path))); return cands.filter((_, i) => ok[i]);
}
const keyOf = (p: string) => norm(p, isWinPath(p));
/** Steam's libraries and the wallpaper folders in them, found on this computer (read only). */
export async function detect(b: WeBridge): Promise<{ libraries: string[]; sources: WeSource[] }> {
  const home = await homeOf(b); const win = /^win/i.test(b.os ?? '') || isWinPath(home);
  const guesses = await steamGuesses(b, home, win);
  const roots = (await Promise.all(guesses.map(async (g) => ((await isDir(b, join(g, 'steamapps'))) ? g : null)))).filter((x): x is string => !!x);
  const libs: string[] = []; const seen = new Set<string>();
  const add = (p: string) => { const k = keyOf(p); if (!seen.has(k) && libs.length < MAX_LIBS) { seen.add(k); libs.push(p); } };
  for (const r of roots) {
    add(r);
    const vdf = await readText(b, join(r, 'steamapps', 'libraryfolders.vdf'), VDF_MAX);
    if (vdf) for (const l of vdfLibraries(vdf, win)) if (await isDir(b, join(l, 'steamapps'))) add(l);
  }
  const sources: WeSource[] = []; const sk = new Set<string>();
  for (const l of libs) for (const s of await sourcesIn(b, l)) { const k = keyOf(s.path); if (!sk.has(k)) { sk.add(k); sources.push(s); } }
  return { libraries: libs, sources };
}
/** A folder the reader chose: a Steam library, Wallpaper Engine's folder, its projects folder, a folder of wallpapers,
 *  or one wallpaper's folder. */
export async function sourcesFromChosen(b: WeBridge, p: string): Promise<WeSource[]> {
  if (typeof p !== 'string' || !p || /[\u0000]/.test(p) || p.split(/[\\/]+/).some((s) => s === '..')) return [];
  if (await isDir(b, join(p, 'steamapps'))) return sourcesIn(b, p);
  for (const sub of [['projects'], []]) {
    const base = sub.length ? join(p, ...sub) : p;
    const mine = join(base, 'myprojects'), def = join(base, 'defaultprojects'); const [m, d] = await Promise.all([isDir(b, mine), isDir(b, def)]);
    if (m || d) return [...(m ? [{ kind: 'mine' as const, path: mine }] : []), ...(d ? [{ kind: 'default' as const, path: def }] : [])];
  }
  try { const i = await b.pathInfo(join(p, 'project.json')); if (i?.exists && !i.dir && i.parent) return [{ kind: 'chosen', path: p }]; } catch { /* none */ }
  return (await isDir(b, p)) ? [{ kind: 'chosen', path: p }] : [];
}
/** One wallpaper's folder read (its project.json only). */
async function readOne(b: WeBridge, dir: string, folder: string, source: SourceKind, mtime: number): Promise<WeItem | null> {
  const text = await readText(b, join(dir, 'project.json'), PROJECT_MAX); if (text === null) return null;
  return parseProject(text, dir, folder, source, mtime);
}
/** Every wallpaper in the sources (at most MAX_WALLPAPERS), read a few at a time; `progress(done, total)` as it goes;
 *  `stop()` true ends it early (the sheet closed). How many folders had no readable project.json is counted. */
export async function listAll(b: WeBridge, sources: WeSource[], progress?: (done: number, total: number) => void, stop?: () => boolean): Promise<{ items: WeItem[]; unreadable: number }> {
  const jobs: { dir: string; folder: string; source: SourceKind; mtime: number }[] = [];
  for (const s of sources) {
    // (A chosen folder that is itself one wallpaper.)
    if (s.kind === 'chosen') { try { const i = await b.pathInfo(join(s.path, 'project.json')); if (i?.exists && !i.dir) { const name = s.path.split(/[\\/]+/).filter(Boolean).pop() ?? 'wallpaper'; jobs.push({ dir: s.path, folder: plainName(name) ? name : 'wallpaper', source: s.kind, mtime: 0 }); continue; } } catch { /* a folder of them */ } }
    let list: Awaited<ReturnType<WeBridge['listDir']>>; try { list = await b.listDir(s.path); } catch { continue; }
    for (const e of list?.entries ?? []) {
      if (jobs.length >= MAX_WALLPAPERS) break;
      if (!e?.dir || !plainName(e.name)) continue;
      const dir = join(s.path, e.name); if (!inside(s.path, dir)) continue;
      jobs.push({ dir, folder: e.name, source: s.kind, mtime: typeof e.mtime === 'number' ? e.mtime : 0 });
    }
  }
  const items: WeItem[] = []; const keys = new Set<string>(); let done = 0, unreadable = 0, next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length && !stop?.()) {
      const j = jobs[next++]; const it = await readOne(b, j.dir, j.folder, j.source, j.mtime);
      if (it && !keys.has(it.key)) { keys.add(it.key); items.push(it); } else if (!it) unreadable++;
      done++; if (done % 16 === 0 || done === jobs.length) progress?.(done, jobs.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  return { items, unreadable };
}

/* ---------- reading what is picked ---------- */
export type WeFault = 'missing' | 'tooLarge' | 'notImage' | 'tooBig' | 'decode' | 'outside';
export class WeError extends Error { constructor(public fault: WeFault) { super(fault); } }
/** A file of a wallpaper read whole (at most `max` bytes), only when it is inside that wallpaper's folder. */
export async function readInside(b: WeBridge, it: WeItem, p: string | null, max: number): Promise<Uint8Array> {
  if (!p) throw new WeError('missing'); if (!inside(it.dir, p)) throw new WeError('outside');
  let i: Awaited<ReturnType<WeBridge['pathInfo']>>; try { i = await b.pathInfo(p); } catch { throw new WeError('missing'); }
  if (!i?.exists || i.dir) throw new WeError('missing');
  if (typeof i.size !== 'number' || i.size > max) throw new WeError('tooLarge');
  let buf: ArrayBuffer; try { buf = await b.readFile(p); } catch { throw new WeError('missing'); }
  if (!(buf instanceof ArrayBuffer) || buf.byteLength > max) throw new WeError('tooLarge');
  return new Uint8Array(buf);
}
/** A wallpaper's preview as a small still picture (`w`×`h`, the middle of it): the custom covers' pixel cap; an
 *  animated preview gives its first frame. */
export async function previewBitmap(b: WeBridge, it: WeItem, w = 320, h = 180): Promise<ImageBitmap> {
  const bytes = await readInside(b, it, it.preview, PREVIEW_MAX);
  const type = sniffImage(bytes); if (!type) throw new WeError('notImage');
  const dim = imageSize(bytes); if (dim && dim.w * dim.h > MAX_PIXELS) throw new WeError('tooBig');
  let full: ImageBitmap; try { full = await createImageBitmap(new Blob([bytes as BlobPart], { type })); } catch { throw new WeError('decode'); }
  try {
    if (full.width * full.height > MAX_PIXELS) throw new WeError('tooBig');
    const s = Math.max(w / full.width, h / full.height); const sw = w / s, sh = h / s;
    return await createImageBitmap(full, Math.max(0, (full.width - sw) / 2), Math.max(0, (full.height - sh) / 2), Math.min(full.width, sw), Math.min(full.height, sh), { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
  } finally { full.close(); }
}
