// Archives (shared with Kurokawa Tools): what is inside, taking it out — in place when the disk is short, the HatchZip
// way — and making a zip; the work done by the phone's plugin or the desktop's main process, which also report
// progress. On the web there is no file system to extract into, so the add-on is for the apps.
import { uid } from './db';

type Cap = { Capacitor?: { Plugins?: { Kurokawa?: unknown } } };
const krPlugin = (): unknown => (window as unknown as Cap).Capacitor?.Plugins?.Kurokawa;

export interface ArchiveEntry { path: string; size: number; compressed?: number; dir: boolean }
export interface ArchiveInfo { format: string; entries: ArchiveEntry[]; total: number; encrypted: boolean; inPlaceOk: boolean; resumable?: boolean }
export interface ExtractOptions { path: string; dest?: string; inPlace?: boolean; deleteAfter?: boolean; replace?: 'replace' | 'skip' | 'both'; password?: string }
export type ArchiveProgress = { id: string; done: number; total: number; file: string };

type Bridge = { archiveList(o: { path: string; password?: string }): Promise<ArchiveInfo>; archiveExtract(o: ExtractOptions & { id: string }): Promise<{ files: number; dest: string }>; archiveCancel(id: string): Promise<void>; archiveCreate(o: { id: string; out: string; inputs: string[] }): Promise<{ files: number; path: string; size: number }>; archivePickFile(o?: { multiple?: boolean }): Promise<string[] | null>; archivePickDir(): Promise<string | null>; onArchiveProgress(cb: (p: ArchiveProgress) => void): () => void };
type Plugin = { archiveList(o: { path: string; password?: string }): Promise<ArchiveInfo>; archiveExtract(o: ExtractOptions & { id: string }): Promise<{ files: number; dest: string }>; archiveCancel(o: { id: string }): Promise<void>; archiveCreate(o: { id: string; out: string; inputs: string[] }): Promise<{ files: number; path: string; size: number }>; archivePickFile(o?: { multiple?: boolean }): Promise<{ paths: string[] }>; archivePickDir(): Promise<{ dir: string }>; addListener(ev: 'archiveProgress', fn: (p: ArchiveProgress) => void): Promise<{ remove(): void }> };
const desk = () => { const d = (window as unknown as { kurokawaDesktop?: Bridge }).kurokawaDesktop; return d?.archiveList ? d : null; };
const plug = () => { const p = krPlugin() as Plugin | undefined; return p?.archiveList ? p : null; };

export const canArchive = (): boolean => !!(desk() || plug());
export const ARCHIVE_RE = /\.(zip|cbz|7z|rar|tar|tgz|tar\.gz|tar\.xz|txz|tar\.bz2|tbz2|gz|xz|bz2)$/i;
export const isArchiveName = (n: string): boolean => ARCHIVE_RE.test(n);

export async function listArchive(path: string, password?: string): Promise<ArchiveInfo> {
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
  wire(); const id = uid(); if (onProgress) listeners.set(id, onProgress);
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
  const d = desk(); if (d) return (await d.archivePickFile({ multiple })) ?? [];
  const p = plug(); if (p) return (await p.archivePickFile({ multiple })).paths;
  return [];
}
export async function pickDir(): Promise<string | null> {
  const d = desk(); if (d) return d.archivePickDir();
  const p = plug(); if (p) { try { return (await p.archivePickDir()).dir; } catch { return null; } }
  return null;
}
export const parentOf = (p: string): string => p.replace(/[\\/][^\\/]*$/, '');
export const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
/** `name.tar.gz` → `name`; `name.zip` → `name`. */
export const stem = (n: string): string => n.replace(ARCHIVE_RE, '').replace(/\.tar$/i, '');
