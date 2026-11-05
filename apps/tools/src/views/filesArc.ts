// An archive walked into as a folder: `arc://<archive path, encoded>/<path inside>` is a place the Files browser
// lists like any other — its folders entered and left by the breadcrumbs, sorted, searched, viewed as a list or a
// grid, with the pictures inside shown small — and a file inside opened in place: pictures in the viewer (swiping
// through the archive's pictures), videos and music in the app's player straight from the archive (the stream
// server reads the entry; nothing is unpacked), the rest taken out to the cache and opened by its kind. Copying out
// of an archive extracts; nothing is written into one from here.
import { listArchiveAuto, entryUrl, entryThumb, extractArchiveJob, savePassword, type ArchiveEntry, type ArchiveInfo } from '../archives';
import { kindOfFile } from './taskFiles';
import { t } from '../i18n';
import type { Entry } from './files';

export const isArc = (p: string): boolean => p.startsWith('arc://');
export const arcPath = (archive: string, inner = ''): string => `arc://${encodeURIComponent(archive)}${inner ? '/' + inner.replace(/^\/+/, '') : ''}`;
export const parseArc = (p: string): { archive: string; inner: string } => { const m = /^arc:\/\/([^/]+)(?:\/(.*))?$/.exec(p); return { archive: decodeURIComponent(m?.[1] ?? ''), inner: (m?.[2] ?? '').replace(/\/+$/, '') }; };
/** A browsable archive by its name (volumes' first part included). */
export const looksArchive = (name: string): boolean => /\.(zip|7z|rar|tar|gz|tgz|xz|bz2|cbz|cbr|jar|apk|apks|xapk|apkm|epub|001)$/i.test(name) || kindOfFile(name) === 'archive';

interface Dir { name: string; path: string; dirs: Map<string, Dir>; files: ArchiveEntry[]; size: number; count: number }
interface Opened { info: ArchiveInfo; root: Dir; password?: string; mtime: number; at: number }
const opened = new Map<string, Opened>();
function treeOf(entries: ArchiveEntry[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [], size: 0, count: 0 };
  const dirAt = (parts: string[]): Dir => { let d = root; for (const p of parts) { let n = d.dirs.get(p); if (!n) { n = { name: p, path: d.path ? `${d.path}/${p}` : p, dirs: new Map(), files: [], size: 0, count: 0 }; d.dirs.set(p, n); } d = n; } return d; };
  for (const e of entries) {
    const clean = e.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''); if (!clean) continue; const parts = clean.split('/');
    if (e.dir) dirAt(parts); else { const name = parts.pop()!; const d = dirAt(parts); d.files.push({ ...e, path: [...parts, name].join('/') }); let up: Dir | undefined = d; const chain = [root]; let acc: Dir = root; for (const p of parts) { acc = acc.dirs.get(p)!; chain.push(acc); } for (up of chain) { up.size += e.size; up.count++; } }
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
  const entries: Entry[] = [...[...d.dirs.values()].map((x) => ({ name: x.name, path: arcPath(archive, x.path), dir: true, size: x.size, mtime: 0, count: x.count })), ...d.files.map((f) => { const name = f.path.split('/').pop() ?? f.path; return { name, path: arcPath(archive, f.path), dir: false, size: f.size, mtime: 0, ext: (name.split('.').pop() ?? '').toLowerCase() }; })];
  return { exists: true, entries };
}
/** The pictures of the whole archive (for the viewer's swiping), in the archive's order. */
export function arcPictures(archive: string): Entry[] {
  const o = opened.get(archive); if (!o) return []; const out: Entry[] = [];
  const walk = (d: Dir) => { for (const f of d.files) if (kindOfFile(f.path) === 'image') out.push({ name: f.path.split('/').pop() ?? f.path, path: arcPath(archive, f.path), dir: false, size: f.size, mtime: 0 }); for (const s of d.dirs.values()) walk(s); };
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
/** Entries (files or folders inside) taken out to a folder, their paths inside kept. */
export function arcExtract(paths: string[], dest: string): { id: string; done: Promise<unknown> } {
  const { archive } = parseArc(paths[0]); const o = opened.get(archive);
  const only = paths.map((p) => parseArc(p).inner).map((inner) => { const d = o ? dirOf(o.root, inner) : null; return d ? `${inner}/` : inner; });
  const job = extractArchiveJob({ path: archive, dest, only, replace: 'ask' as never, password: o?.password });
  return { id: job.id, done: job.done };
}
/** The name shown at the root crumb: the archive's file name. */
export const arcName = (path: string): string => parseArc(path).archive.split('/').pop() ?? '';
