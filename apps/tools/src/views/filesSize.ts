// Folder sizes on demand (Files): a folder's bytes, files and folders counted in the background — one listing at a time,
// the page free between them, Cancel at any moment, the progress told to whoever watches — and kept per folder until the
// folder's own date changes. Nothing here touches the disk but through `list`, which the page gives (the phone's plugin or
// the computer's shell); a folder whose listing fails is counted as «not all read», never as empty.
import type { Entry } from './files';

export interface SizeInfo { bytes: number; files: number; folders: number; /** The folder's date when counted. */ mtime: number; /** Folders that could not be read. */ unread: number }
export interface SizeProgress { bytes: number; files: number; folders: number; /** Folders still to list. */ waiting: number }
const KEY = 'kt.files.dirsizes'; const CAP = 400; const MAX_DEPTH = 48;
let memo: Map<string, SizeInfo> | null = null;
const table = (): Map<string, SizeInfo> => {
  if (memo) return memo; memo = new Map();
  try { for (const [p, v] of Object.entries(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, SizeInfo>)) if (v && typeof v.bytes === 'number') memo.set(p, v); } catch { /* none */ }
  return memo;
};
const keep = (): void => { const m = table(); while (m.size > CAP) m.delete(m.keys().next().value as string); try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(m))); } catch { /* none */ } };
/** What is known of a folder: counted before and its date unchanged (a date not known — 0 — accepts what was counted). */
export const sizeOf = (path: string, mtime: number): SizeInfo | null => { const c = table().get(path); return c && (mtime <= 0 || c.mtime === mtime || c.mtime <= 0) ? c : null; };
export const forgetSize = (path: string): void => { if (table().delete(path)) keep(); };

export interface SizeRun { path: string; progress: SizeProgress; done: Promise<SizeInfo | null>; cancel(): void }
const runs = new Map<string, { run: SizeRun; subs: Set<(p: SizeProgress, end?: SizeInfo | null) => void> }>();
/** Told of a folder's counting (each step, then its end: the result, or null when stopped); the returned function lets go. */
export function watchSize(path: string, fn: (p: SizeProgress, end?: SizeInfo | null) => void): () => void {
  const r = runs.get(path); if (!r) return () => undefined; r.subs.add(fn); fn(r.run.progress); return () => { r.subs.delete(fn); };
}
export const sizeRunning = (path: string): SizeRun | null => runs.get(path)?.run ?? null;
export const anySizeRunning = (): number => runs.size;

/** Starts counting `path` (one run per folder: asked again while it runs, the same run answers). `list`: a folder's entries. */
export function calcSize(path: string, mtime: number, list: (p: string) => Promise<Entry[]>): SizeRun {
  const live = runs.get(path); if (live) return live.run;
  let stop = false; const subs = new Set<(p: SizeProgress, end?: SizeInfo | null) => void>();
  const progress: SizeProgress = { bytes: 0, files: 0, folders: 0, waiting: 1 };
  let unread = 0; let last = 0;
  const tell = (force = false, end?: SizeInfo | null) => { const now = Date.now(); if (!force && now - last < 90) return; last = now; for (const f of [...subs]) f(progress, end); };
  const todo: [string, number][] = [[path, 0]];
  const run: SizeRun = { path, progress, cancel: () => { stop = true; }, done: Promise.resolve(null) };
  run.done = (async () => {
    try {
      while (todo.length && !stop) {
        const [dir, depth] = todo.pop()!; progress.waiting = todo.length + 1;
        let got: Entry[] = []; try { got = await list(dir); } catch { unread++; }
        for (const e of got) {
          if (e.dir) { progress.folders++; if (depth < MAX_DEPTH) todo.push([e.path, depth + 1]); else unread++; }
          else { progress.files++; progress.bytes += Math.max(0, e.size); }
        }
        progress.waiting = todo.length; tell();
        await new Promise((r) => setTimeout(r, 0));
      }
      if (stop) return null;
      const info: SizeInfo = { bytes: progress.bytes, files: progress.files, folders: progress.folders, mtime, unread };
      table().set(path, info); keep(); return info;
    } finally { const end = stop ? null : table().get(path) ?? null; tell(true, end); runs.delete(path); subs.clear(); }
  })();
  runs.set(path, { run, subs }); return run;
}
