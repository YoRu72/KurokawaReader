// Links to a cloud's shared files — MEGA, Google Drive —, which open a page, not a file: each read the way its own
// site reads it (a file's name and size, a folder's files with their place in it), its files chosen in the Add sheet
// and added as downloads, a folder's inside a folder of its own name with its tree kept. The same from anywhere a
// link is added (a rule, the clipboard, a page's links, the app's browser).
import type { AddOptions, Engine, Task } from '../engine/types';

export interface CloudFile { id: string; name: string; path: string; size: number }
export interface CloudInfo<F extends CloudFile = CloudFile> { service: string; name: string; folder: boolean; files: F[]; more?: boolean }
export interface CloudAdded { tasks: Task[]; failed: number; error?: string }
export interface Cloud {
  service: string;
  info(u: string): Promise<CloudInfo>;
  add(eng: Engine, info: CloudInfo, files: CloudFile[], base: Omit<AddOptions, 'source'>, link: string): Promise<CloudAdded>;
  /** Sizes not known from the listing, found a few at a time. */
  sizes?(files: CloudFile[], onSize: (f: CloudFile, size: number, name?: string) => void, stop: () => boolean): Promise<void>;
}

/** Cheap first look (no module loaded) — the hosts a cloud link is on. */
const HOSTS = /^https?:\/\/(?:www\.)?(?:mega(?:\.co)?\.nz\/|(?:drive|docs|drive\.usercontent)\.google\.com\/)/i;
export const maybeCloud = (u: string | undefined): boolean => !!u && HOSTS.test(u);

/** Where a file of a folder goes: <dir>/<folder's name>/<its subfolders>. */
export function dirFor(base: string | undefined, info: CloudInfo, f: CloudFile): string | undefined {
  const sep = (base ?? '').includes('\\') ? '\\' : '/';
  const sub = info.folder ? [info.name, ...f.path.split('/').slice(0, -1)].filter(Boolean).map((s) => s.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, '_')).join(sep) : '';
  return (sub ? (base ? `${base.replace(/[\\/]$/, '')}${sep}${sub}` : sub) : base) || undefined;
}

/** The cloud a link is of, or null. */
export async function cloudOf(u: string | undefined): Promise<Cloud | null> {
  if (!maybeCloud(u)) return null;
  const M = await import('./mega');
  if (M.isMega(u!)) return {
    service: 'MEGA',
    info: (x) => M.megaInfo(x),
    add: async (eng, info, files, base, link) => ({ tasks: await M.addMegaFiles(eng, info as import('./mega').MegaInfo, files as import('./mega').MegaFile[], base, link, (f) => dirFor(base.dir, info, f)), failed: 0 }),
  };
  const D = await import('./gdrive');
  if (D.isDrive(u!)) return {
    service: 'Google Drive',
    info: (x) => D.driveInfo(x),
    add: (eng, info, files, base, link) => D.addDriveFiles(eng, info as CloudInfo<import('./gdrive').DriveFile>, files as import('./gdrive').DriveFile[], base, link, (f) => dirFor(base.dir, info, f)),
    sizes: (files, onSize, stop) => D.driveSizes(files as import('./gdrive').DriveFile[], onSize as never, stop),
  };
  return null;
}

/** A cloud link added from anywhere: every file it holds, the first returned as the task. */
export async function addVia(eng: Engine, o: AddOptions): Promise<Task | null> {
  if (o.meta?.gdrive || o.meta?.megaKey) return null;
  const c = await cloudOf(o.source.url); if (!c) return null;
  const info = await c.info(o.source.url!);
  const files = info.files.length === 1 && o.name ? [{ ...info.files[0], name: o.name }] : info.files;
  const r = await c.add(eng, info, files, { ...o, name: undefined }, o.source.url!);
  if (!r.tasks.length) throw new Error(r.error ?? 'driveErrGone');
  return r.tasks[0];
}

/** Error keys the clouds throw, as words. */
export const cloudErrKey = (m: string): boolean => /^(mega|drive)Err\w+$/.test(m);

/** The Downloads page's watch: failed downloads whose address ran out renewed, MEGA's finished files decrypted. */
export async function watch(eng: Engine, ts: Task[]): Promise<void> {
  if (ts.some((x) => x.meta?.megaKey && (x.state === 'failed' || x.state === 'done'))) { const m = await import('./mega'); void m.renewFailed(eng, ts); void m.afterDone(ts); }
  if (ts.some((x) => x.meta?.gdrive && x.state === 'failed')) { const d = await import('./gdrive'); void d.renewFailed(eng, ts); }
}
