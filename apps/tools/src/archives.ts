// Archives (the Archives add-on): what is inside, taking it out — in place when the disk is short, the HatchZip
// way — and making a zip; the work done by the phone's plugin or the desktop's main process, which also report
// progress. On the web there is no file system to extract into, so the add-on is for the apps.
import { ktPlugin } from './native';
import { uid } from './db';

export interface ArchiveEntry { path: string; size: number; compressed?: number; dir: boolean }
export interface ArchiveInfo { format: string; entries: ArchiveEntry[]; total: number; encrypted: boolean; inPlaceOk: boolean; resumable?: boolean; largest?: number; free?: number; unsafe?: string; duplicate?: string; sfv?: string }
export interface ExtractOptions { path: string; /** A folder, or «cache:» for a look at one file (the app's own cache). */ dest?: string; /** Only these entries (and what is under these folders). */ only?: string[]; inPlace?: boolean; deleteAfter?: boolean; replace?: 'replace' | 'skip' | 'both'; password?: string; verifyFirst?: boolean; keepFree?: number }
export type ArchiveProgress = { id: string; done: number; total: number; file: string };

type Bridge = { archiveList(o: { path: string; password?: string }): Promise<ArchiveInfo>; archiveExtract(o: ExtractOptions & { id: string }): Promise<{ files: number; dest: string }>; archiveCancel(id: string): Promise<void>; archiveCreate(o: { id: string; out: string; inputs: string[] }): Promise<{ files: number; path: string; size: number }>; pickFile(o?: { multiple?: boolean }): Promise<string[] | null>; pathInfo(p: string): Promise<{ exists: boolean; dir?: boolean; size?: number; name?: string; parent?: string }>; onArchiveProgress(cb: (p: ArchiveProgress) => void): () => void };
type Plugin = { archiveList(o: { path: string; password?: string }): Promise<ArchiveInfo>; archiveExtract(o: ExtractOptions & { id: string }): Promise<{ files: number; dest: string }>; archiveCancel(o: { id: string }): Promise<void>; archiveCreate(o: { id: string; out: string; inputs: string[] }): Promise<{ files: number; path: string; size: number }>; pickFile(o?: { multiple?: boolean }): Promise<{ paths: string[] }>; addListener(ev: 'archiveProgress', fn: (p: ArchiveProgress) => void): Promise<{ remove(): void }> };
const desk = () => (window.kurokawaTools as unknown as Bridge | undefined)?.archiveList ? (window.kurokawaTools as unknown as Bridge) : null;
const plug = () => { const p = ktPlugin() as unknown as Plugin | null; return p?.archiveList ? p : null; };

export const canArchive = (): boolean => !!(desk() || plug());
export const ARCHIVE_RE = /\.(zip|cbz|7z|rar|tar|tgz|tar\.gz|tar\.xz|txz|tar\.bz2|tbz2|gz|xz|bz2|7z\.\d{3}|zip\.\d{3}|z\d{2}|part\d+\.rar|r\d{2})$/i;
/** A split archive's first volume («x.7z.002» → «x.7z.001», «x.part3.rar» → «x.part1.rar», «x.z01» → «x.zip», «x.r00» → «x.rar»): the one to open. */
export function firstVolume(path: string): string {
  return path.replace(/\.(7z|zip)\.\d{3}$/i, '.$1.001').replace(/\.part\d+(\.rar)$/i, '.part1$1').replace(/\.z\d{2}$/i, '.zip').replace(/\.r\d{2}$/i, '.rar');
}
/** Whether a name is a later volume of a split archive (opened through its first). */
export const isLaterVolume = (n: string): boolean => firstVolume(n) !== n;
export const isArchiveName = (n: string): boolean => ARCHIVE_RE.test(n);

export async function listArchive(path: string, password?: string): Promise<ArchiveInfo> {
  path = firstVolume(path);
  const d = desk(); if (d) return d.archiveList({ path, password });
  const p = plug(); if (p) return p.archiveList({ path, password });
  throw new Error('unsupported');
}
const listeners = new Map<string, (p: ArchiveProgress) => void>(); let wired = false;
function wire(): void {
  if (wired) return; wired = true;
  const d = desk(); if (d) d.onArchiveProgress((p) => listeners.get(p.id)?.(p));
  const p = plug(); if (p) void p.addListener('archiveProgress', (ev) => listeners.get(ev.id)?.(ev));
}
export async function extractArchive(o: ExtractOptions, onProgress?: (p: ArchiveProgress) => void): Promise<{ id: string; files: number; dest: string }> {
  o = { ...o, path: firstVolume(o.path) }; wire(); const id = uid(); if (onProgress) listeners.set(id, onProgress);
  try { const d = desk(); const r = d ? await d.archiveExtract({ ...o, id }) : await plug()!.archiveExtract({ ...o, id }); return { id, ...r }; }
  finally { listeners.delete(id); }
}
/** Starts an extraction and hands back its id so it can be cancelled; the promise settles when it ends. */
export function extractArchiveJob(o: ExtractOptions, onProgress?: (p: ArchiveProgress) => void): { id: string; done: Promise<{ files: number; dest: string }> } {
  wire(); const id = uid(); if (onProgress) listeners.set(id, onProgress);
  const d = desk(); const done = (d ? d.archiveExtract({ ...o, id }) : plug()!.archiveExtract({ ...o, id })).finally(() => listeners.delete(id));
  return { id, done };
}
export async function cancelArchive(id: string): Promise<void> { const d = desk(); if (d) return d.archiveCancel(id); await plug()?.archiveCancel({ id }); }
export async function createZip(out: string, inputs: string[], onProgress?: (p: ArchiveProgress) => void): Promise<{ files: number; path: string; size: number }> {
  wire(); const id = uid(); if (onProgress) listeners.set(id, onProgress);
  try { const d = desk(); return d ? await d.archiveCreate({ id, out, inputs }) : await plug()!.archiveCreate({ id, out, inputs }); } finally { listeners.delete(id); }
}
export async function pickFiles(multiple = false): Promise<string[]> {
  const d = desk(); if (d) return (await d.pickFile({ multiple })) ?? [];
  const p = plug(); if (p) return (await p.pickFile({ multiple })).paths;
  return [];
}
export const parentOf = (p: string): string => p.replace(/[\\/][^\\/]*$/, '');
export const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
/** `name.tar.gz` → `name`; `name.zip` → `name`. */
export const stem = (n: string): string => n.replace(ARCHIVE_RE, '').replace(/\.tar$/i, '');

/* ---------- HatchZip's other verbs ---------- */
type More = { archiveTest(o: { id: string; path: string; password?: string }): Promise<{ ok: boolean; files: number; bad: string[] }>; archiveRestore(o: { path: string }): Promise<{ left: number }>; archiveFree(o: { dir: string }): Promise<{ free: number }>; archiveExisting(o: { dest: string; names: string[] }): Promise<{ existing: string[] }> };
const more = (): More | null => (desk() as unknown as More | null) ?? (plug() as unknown as More | null);
/** Every file read and its checksum compared; nothing written. */
export function testArchiveJob(path: string, password: string | undefined, onProgress?: (p: ArchiveProgress) => void): { id: string; done: Promise<{ ok: boolean; files: number; bad: string[] }> } {
  wire(); const id = uid(); if (onProgress) listeners.set(id, onProgress);
  const m = more(); if (!m?.archiveTest) return { id, done: Promise.reject(new Error('unsupported')) };
  return { id, done: m.archiveTest({ id, path, password }).finally(() => listeners.delete(id)) };
}
/** An extraction in place given up: what is left becomes a normal archive again. */
export async function restoreArchive(path: string): Promise<number> { const m = more(); if (!m?.archiveRestore) throw new Error('unsupported'); return (await m.archiveRestore({ path })).left; }
export async function freeSpaceAt(dir: string): Promise<number> { try { const m = more(); return m?.archiveFree ? (await m.archiveFree({ dir })).free : -1; } catch { return -1; } }
export async function existingIn(dest: string, names: string[]): Promise<string[]> { try { const m = more(); return m?.archiveExisting ? (await m.archiveExisting({ dest, names })).existing : []; } catch { return []; } }
/** HatchZip's «Extract here»: one top-level item lands beside the archive; several go into a folder named after it. */
export function topLevel(entries: ArchiveEntry[]): 'one' | 'many' { const tops = new Set(entries.map((e) => e.path.replace(/^\.\//, '').split('/')[0]).filter(Boolean)); return tops.size <= 1 ? 'one' : 'many'; }
