// The player's own fonts for styled (ASS) subtitles: a folder of the user's (a computer's folder, or one on the
// phone the app can read) and fonts added to the app itself (kept in its storage — on a phone, where other apps'
// folders are closed to it, this is the way). Each font's family names are read from the file once (its «name»
// table) and kept; when a subtitle asks for a font by name, libass (JASSUB) is handed that file.
import { db, uid } from '../db';
import { getSettings } from '../settings';
import { readLocal } from './files';

export interface FontEntry { id: string; file: string; families: string[]; size: number }
const LIB = 'fonts:library'; const DIRIX = 'fonts:dir'; const SYSIX = 'fonts:system';
type DirIndex = { dir: string; files: { path: string; size: number; mtime: number; families: string[] }[] };
const FONT_RE = /\.(ttf|otf|ttc|otc|woff2?)$/i;

/* ---------- a font file's family names (sfnt «name» table: TrueType, OpenType, collections) ---------- */
export function familyNames(b: Uint8Array): string[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); const out = new Set<string>();
  const one = (off: number) => {
    if (off + 12 > b.length) return; const n = dv.getUint16(off + 4);
    for (let i = 0; i < n; i++) {
      const rec = off + 12 + i * 16; if (rec + 16 > b.length) return;
      if (String.fromCharCode(b[rec], b[rec + 1], b[rec + 2], b[rec + 3]) !== 'name') continue;
      const t = dv.getUint32(rec + 8); if (t + 6 > b.length) return;
      const count = dv.getUint16(t + 2), strs = t + dv.getUint16(t + 4);
      for (let j = 0; j < count; j++) {
        const r = t + 6 + j * 12; if (r + 12 > b.length) break;
        const pid = dv.getUint16(r), eid = dv.getUint16(r + 2), nid = dv.getUint16(r + 6), len = dv.getUint16(r + 8), so = strs + dv.getUint16(r + 10);
        if (![1, 4, 16].includes(nid) || so + len > b.length) continue;
        let s = '';
        if (pid === 3 || pid === 0) { for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(dv.getUint16(so + k)); }
        else if (pid === 1 && eid === 0) { for (let k = 0; k < len; k++) s += String.fromCharCode(b[so + k]); }
        s = s.replace(/\0/g, '').trim(); if (s) out.add(s);
      }
    }
  };
  if (b.length < 12) return [];
  const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
  if (tag === 'ttcf') { const n = dv.getUint32(8); for (let i = 0; i < Math.min(n, 64); i++) one(dv.getUint32(12 + i * 4)); }
  else one(0);
  return [...out];
}
const byFileName = (file: string) => [file.replace(/\.[^.]+$/, '').replace(/[-_](regular|bold|italic|medium|light|semibold|black|thin)$/i, '').replace(/[-_]+/g, ' ')];

/* ---------- the app's own fonts ---------- */
export async function library(): Promise<FontEntry[]> { return (await db.getMeta<FontEntry[]>(LIB)) ?? []; }
export async function addFonts(files: File[]): Promise<number> {
  const lib = await library(); let n = 0;
  for (const f of files) {
    if (!FONT_RE.test(f.name) || lib.some((x) => x.file === f.name && x.size === f.size)) continue;
    const bytes = new Uint8Array(await f.arrayBuffer()); const fam = /\.woff2?$/i.test(f.name) ? byFileName(f.name) : familyNames(bytes);
    const id = uid(); await db.putFile(`font:${id}`, new Blob([bytes], { type: 'font/ttf' }));
    lib.push({ id, file: f.name, families: fam.length ? fam : byFileName(f.name), size: f.size }); n++;
  }
  await db.setMeta(LIB, lib); return n;
}
export async function removeFont(id: string): Promise<void> { await db.deleteFile(`font:${id}`).catch(() => undefined); await db.setMeta(LIB, (await library()).filter((x) => x.id !== id)); }

/* ---------- the folder ---------- */
type Lister = { listDir?(p: string): Promise<{ entries: { name: string; path: string; dir: boolean; size: number; mtime: number }[] }> };
async function list(dir: string): Promise<{ name: string; path: string; dir: boolean; size: number; mtime: number }[]> {
  const d = window.kurokawaTools as unknown as Lister | undefined; if (d?.listDir) return (await d.listDir(dir)).entries ?? [];
  const { ktPlugin } = await import('../native'); const p = ktPlugin() as unknown as { listDir?(o: { path: string }): Promise<{ entries: { name: string; path: string; dir: boolean; size: number; mtime: number }[] }> } | null;
  return p?.listDir ? (await p.listDir({ path: dir })).entries ?? [] : [];
}
/** The folder's fonts, their names read once (and again when a file changes); up to two levels deep. */
export async function folderFonts(dir = getSettings().playerFontsDir ?? '', onEach?: (done: number, total: number) => void, key = DIRIX): Promise<DirIndex['files']> {
  if (!dir) return [];
  const files: { path: string; size: number; mtime: number }[] = [];
  const walk = async (d: string, depth: number) => { for (const e of await list(d).catch(() => [])) { if (e.dir && depth < 2) await walk(e.path, depth + 1); else if (!e.dir && FONT_RE.test(e.name)) files.push(e); } };
  await walk(dir, 0);
  const old = (await db.getMeta<DirIndex>(key)); const had = new Map((old?.dir === dir ? old.files : []).map((x) => [x.path, x]));
  const out: DirIndex['files'] = []; let i = 0;
  for (const f of files.slice(0, 3000)) {
    const h = had.get(f.path);
    if (h && h.size === f.size && h.mtime === f.mtime) out.push(h);
    else { const name = f.path.split(/[\\/]/).pop() ?? f.path; let fam: string[] = []; if (!/\.woff2?$/i.test(name) && f.size < 60 << 20) { const b = await readLocal(f.path); if (b) fam = familyNames(b); } out.push({ ...f, families: fam.length ? fam : byFileName(name) }); }
    onEach?.(++i, files.length);
  }
  await db.setMeta(key, { dir, files: out }); return out;
}
/** A computer's installed fonts (Windows', macOS' and Linux's font folders, the user's own included), read once and
 *  kept; read again at most once a day, and only the files that changed. */
let sysLoading: Promise<DirIndex['files']> | null = null;
export async function systemFonts(): Promise<DirIndex['files']> {
  const d = window.kurokawaTools as unknown as { fontDirs?(): Promise<string[]>; fontIndex?(dirs: string[]): Promise<DirIndex['files']> } | undefined; if (!d?.fontDirs) return [];
  const old = await db.getMeta<DirIndex & { at?: number }>(SYSIX);
  if (old?.files.length && old.at && Date.now() - old.at < 86400000) return old.files;
  sysLoading ??= (async () => {
    const dirs = await d.fontDirs!(); const all: DirIndex['files'] = [];
    // (Read by the computer's side, seeking only the names in each file; else one folder at a time from here.)
    if (d.fontIndex) all.push(...await d.fontIndex(dirs)); else for (const dir of dirs) all.push(...await folderFonts(dir, undefined, `${SYSIX}:${dir}`).catch(() => []));
    await db.setMeta(SYSIX, { dir: dirs.join('|'), files: all, at: Date.now() }); return all;
  })().finally(() => { sysLoading = null; });
  return sysLoading;
}

/** The fonts a subtitle names (its styles and its \fn overrides). */
export function fontsUsed(ass: string): string[] {
  const out = new Set<string>(); let fmt: string[] = [];
  for (const line of ass.split(/\r?\n/)) {
    if (/^Format:/i.test(line) && fmt.length === 0 && /Fontname/i.test(line)) fmt = line.slice(7).split(',').map((x) => x.trim().toLowerCase());
    else if (/^Style:/i.test(line)) { const parts = line.slice(6).split(','); const i = fmt.indexOf('fontname'); const n = (parts[i >= 0 ? i : 1] ?? '').trim().replace(/^@/, ''); if (n) out.add(n); }
  }
  for (const m of ass.matchAll(/\\fn@?([^\\}]+)/g)) out.add(m[1].trim());
  return [...out];
}
/** For JASSUB: each wanted family (lower-cased) and the address of its file. */
export async function availableFor(ass: string): Promise<Record<string, string>> {
  const want = new Set(fontsUsed(ass).map((x) => x.toLowerCase())); if (!want.size) return {};
  const out: Record<string, string> = {};
  for (const f of await library()) for (const fam of f.families) { const k = fam.toLowerCase(); if (want.has(k) && !out[k]) { const blob = await db.getFile(`font:${f.id}`); if (blob) out[k] = URL.createObjectURL(blob); } }
  // (A computer's installed fonts: a subtitle naming «Arial» or a font the user installed gets it without anything set.)
  if (getSettings().playerSystemFonts !== false && [...want].some((k) => !out[k])) {
    for (const f of await systemFonts().catch(() => [])) for (const fam of f.families) { const k = fam.toLowerCase(); if (want.has(k) && !out[k]) { const b = await readLocal(f.path); if (b) out[k] = URL.createObjectURL(new Blob([b as Uint8Array<ArrayBuffer>], { type: 'font/ttf' })); } }
  }
  if (getSettings().playerFontsDir) {
    let ix = (await db.getMeta<DirIndex>(DIRIX)); if (!ix || ix.dir !== getSettings().playerFontsDir) ix = { dir: getSettings().playerFontsDir!, files: await folderFonts() };
    for (const f of ix.files) for (const fam of f.families) { const k = fam.toLowerCase(); if (want.has(k) && !out[k]) { const b = await readLocal(f.path); if (b) out[k] = URL.createObjectURL(new Blob([b as Uint8Array<ArrayBuffer>], { type: 'font/ttf' })); } }
  }
  return out;
}
