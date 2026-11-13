// An archive walked into as a folder: `arc://<archive path, encoded>/<path inside>` is a place the Files browser
// lists like any other — its folders entered and left by the breadcrumbs, sorted, searched, viewed as a list or a
// grid, with the pictures inside shown small — and a file inside opened in place: pictures in the viewer (swiping
// through the archive's pictures), videos and music in the app's player straight from the archive (the stream
// server reads the entry; nothing is unpacked), the rest taken out to the cache and opened by its kind. Copying out
// of an archive extracts; nothing is written into one from here.
import { listArchiveAuto, entryUrl, entryThumb, extractArchiveJob, savePassword, type ArchiveEntry, type ArchiveInfo, type ArchiveProgress } from '../archives';
import { kindOfFile } from './taskFiles';
import { t } from '../i18n';
import type { Entry } from './files';

export const isArc = (p: string): boolean => p.startsWith('arc://');
export const arcPath = (archive: string, inner = ''): string => `arc://${encodeURIComponent(archive)}${inner ? '/' + inner.replace(/^\/+/, '') : ''}`;
export const parseArc = (p: string): { archive: string; inner: string } => { const m = /^arc:\/\/([^/]+)(?:\/(.*))?$/.exec(p); return { archive: decodeURIComponent(m?.[1] ?? ''), inner: (m?.[2] ?? '').replace(/\/+$/, '') }; };
/** A browsable archive by its name (volumes' first part included). */
export const looksArchive = (name: string): boolean => /\.(zip|7z|rar|tar|gz|tgz|xz|bz2|cbz|cbr|jar|apk|apks|xapk|apkm|epub|001)$/i.test(name) || kindOfFile(name) === 'archive';

/** A folder inside: its size and count are of all below it; `mtime` its own date, else the newest below it (0: none kept). */
interface Dir { name: string; path: string; dirs: Map<string, Dir>; files: ArchiveEntry[]; size: number; count: number; mtime: number }
interface Opened { info: ArchiveInfo; root: Dir; password?: string; mtime: number; at: number }
const opened = new Map<string, Opened>();
function treeOf(entries: ArchiveEntry[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [], size: 0, count: 0, mtime: 0 };
  const dirAt = (parts: string[]): Dir => { let d = root; for (const p of parts) { let n = d.dirs.get(p); if (!n) { n = { name: p, path: d.path ? `${d.path}/${p}` : p, dirs: new Map(), files: [], size: 0, count: 0, mtime: 0 }; d.dirs.set(p, n); } d = n; } return d; };
  for (const e of entries) {
    const clean = e.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''); if (!clean) continue; const parts = clean.split('/');
    if (e.dir) { const d = dirAt(parts); if (e.mtime) d.mtime = Math.max(d.mtime, e.mtime); } else { const name = parts.pop()!; const d = dirAt(parts); d.files.push({ ...e, path: [...parts, name].join('/') }); let up: Dir | undefined = d; const chain = [root]; let acc: Dir = root; for (const p of parts) { acc = acc.dirs.get(p)!; chain.push(acc); } for (up of chain) { up.size += Math.max(0, e.size); up.count++; if (e.mtime && e.mtime > up.mtime) up.mtime = e.mtime; } }
  }
  return root;
}
const dirOf = (root: Dir, inner: string): Dir | null => { let d = root; for (const p of inner.split('/').filter(Boolean)) { const n = d.dirs.get(p); if (!n) return null; d = n; } return d; };
/** The archive read (once; kept for a while), a password asked through `askPassword` when it needs one. */
export async function openArc(archive: string, askPassword?: (wrong: boolean) => Promise<string | null>): Promise<Opened> {
  const had = opened.get(archive); if (had && Date.now() - had.at < 10 * 60e3) { had.at = Date.now(); return had; }
  let password: string | undefined; let wrong = false;
  for (let tries = 0; tries < 4; tries++) {
    try { const r = await listArchiveAuto(archive, password); if (r.password) savePassword(r.password); const o: Opened = { info: r.info, root: treeOf(r.info.entries), password: r.password, mtime: 0, at: Date.now() }; opened.set(archive, o); if (opened.size > 8) { const oldest = [...opened.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (oldest) opened.delete(oldest[0]); } return o; }
    catch (e) { const m = String((e as Error).message ?? e); if (!/password/i.test(m) || !askPassword) throw e; const pw = await askPassword(wrong); if (!pw) throw new Error('cancelled'); password = pw; wrong = true; }
  }
  throw new Error('password');
}
export const forgetArc = (archive: string): void => { opened.delete(archive); };
/** The listing of a place inside an archive, as the Files browser wants it. */
export async function arcList(path: string, askPassword?: (wrong: boolean) => Promise<string | null>): Promise<{ exists: boolean; entries: Entry[] }> {
  const { archive, inner } = parseArc(path); const o = await openArc(archive, askPassword); const d = dirOf(o.root, inner); if (!d) return { exists: false, entries: [] };
  const entries: Entry[] = [...[...d.dirs.values()].map((x) => ({ name: x.name, path: arcPath(archive, x.path), dir: true, size: x.size, mtime: x.mtime, count: x.count })), ...d.files.map((f) => { const name = f.path.split('/').pop() ?? f.path; return { name, path: arcPath(archive, f.path), dir: false, size: f.size, mtime: f.mtime ?? 0, ext: (name.split('.').pop() ?? '').toLowerCase() }; })];
  return { exists: true, entries };
}
/** The pictures of the whole archive (for the viewer's swiping), in the archive's order. */
export function arcPictures(archive: string): Entry[] {
  const o = opened.get(archive); if (!o) return []; const out: Entry[] = [];
  const walk = (d: Dir) => { for (const f of d.files) if (kindOfFile(f.path) === 'image') out.push({ name: f.path.split('/').pop() ?? f.path, path: arcPath(archive, f.path), dir: false, size: f.size, mtime: f.mtime ?? 0 }); for (const s of d.dirs.values()) walk(s); };
  walk(o.root); return out;
}
/** A URL that reads the entry straight from the archive (phone), or null. */
export async function arcUrl(path: string): Promise<string | null> { const { archive, inner } = parseArc(path); const o = opened.get(archive); return entryUrl(archive, inner, o?.password); }
export async function arcThumb(path: string, px: number): Promise<string | null> { const { archive, inner } = parseArc(path); const o = opened.get(archive); return entryThumb(archive, inner, px, o?.password); }
/** The entry taken out to the cache; its local path. */
export async function arcFetch(path: string): Promise<string> {
  const { archive, inner } = parseArc(path); const o = opened.get(archive);
  const job = extractArchiveJob({ path: archive, dest: 'cache:', only: [inner], replace: 'replace', password: o?.password });
  const r = await job.done; return `${r.dest.replace(/[\\/]$/, '')}/${inner}`;
}
/** Entries (files or folders inside) taken out to a folder, their paths inside kept (the Files page takes them out to
 *  a hidden folder beside where they go, then moves them in as a paste does: the name-taken question and all). */
export function arcExtract(paths: string[], dest: string, onProgress?: (p: ArchiveProgress) => void): { id: string; done: Promise<unknown>; bytes: number } {
  const { archive } = parseArc(paths[0]); const o = opened.get(archive); let bytes = 0;
  const only = paths.map((p) => parseArc(p).inner).map((inner) => { const d = o ? dirOf(o.root, inner) : null; if (d) { bytes += d.size; return `${inner}/`; } bytes += Math.max(0, o?.info.entries.find((e) => e.path === inner)?.size ?? 0); return inner; });
  const job = extractArchiveJob({ path: archive, dest, only, replace: 'replace', password: o?.password }, onProgress);
  return { id: job.id, done: job.done, bytes };
}
/** Whether a place inside an archive is a folder there. */
export function arcIsDir(path: string): boolean { const { archive, inner } = parseArc(path); const o = opened.get(archive); return !!o && !!dirOf(o.root, inner); }
/** The name shown at the root crumb: the archive's file name (decoded — never «%2Fstorage%2F…»). */
export const arcName = (path: string): string => parseArc(path).archive.split('/').pop() ?? '';
