// The list's extras: a note on a download, the list exported and brought back, the lifetime counts, finished entries
// cleared after some days, failed ones tried again, and a link already in the list caught before it is added twice.
import type { Task, TaskSource } from '../engine/types';
import { getEngine, parseSources } from '../engine';
import { getSettings } from '../settings';

const NOTES = 'kt.notes'; const STATS = 'kt.stats';
const read = <T>(k: string, d: T): T => { try { return { ...d, ...(JSON.parse(localStorage.getItem(k) ?? 'null') ?? {}) } as T; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full */ } };

/* ---------- notes ---------- */
export const noteOf = (id: string): string => read<Record<string, string>>(NOTES, {})[id] ?? '';
export function setNote(id: string, text: string): void { const n = read<Record<string, string>>(NOTES, {}); if (text.trim()) n[id] = text.trim().slice(0, 300); else delete n[id]; write(NOTES, n); }

/* ---------- lifetime counts ---------- */
export interface Stats { files: number; bytes: number; since: number; seen: Record<string, 1> }
export const stats = (): Stats => read<Stats>(STATS, { files: 0, bytes: 0, since: Date.now(), seen: {} });
/** Each download counted once, when it is first seen finished. */
export function countFinished(tasks: Task[]): void {
  const s = stats(); let changed = false;
  for (const x of tasks) if ((x.state === 'done' || x.state === 'seeding') && !s.seen[x.id]) { s.seen[x.id] = 1; s.files++; s.bytes += x.total || x.done || 0; changed = true; }
  if (changed) { const keys = Object.keys(s.seen); if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete s.seen[k]; write(STATS, s); }
}

/* ---------- finished entries cleared after some days (the files stay) ---------- */
export async function autoClean(tasks: Task[]): Promise<number> {
  const days = getSettings().dlAutoClean ?? 0; if (!days) return 0;
  const before = Date.now() - days * 86400000; let n = 0;
  for (const x of tasks) if (x.state === 'done' && x.doneAt && x.doneAt < before) { try { await getEngine().remove(x.id, false); n++; } catch { /* left */ } }
  return n;
}

/* ---------- failed ones again ---------- */
export async function retryFailed(tasks: Task[]): Promise<number> {
  const eng = getEngine(); let n = 0;
  for (const x of tasks.filter((y) => y.state === 'failed')) { try { await eng.resume(x.id); n++; } catch { try { await eng.remove(x.id, false); await eng.add({ source: x.source, name: x.name, dir: x.dir, meta: x.meta }); n++; } catch { /* left failed */ } } }
  return n;
}

/* ---------- the list exported and brought back ---------- */
export interface ListFile { app: 'kurokawa-tools'; version: 1; at: string; downloads: { name: string; source: TaskSource; dir?: string; state: string; size: number; note?: string; meta?: Task['meta'] }[] }
export function exportList(tasks: Task[]): ListFile {
  return { app: 'kurokawa-tools', version: 1, at: new Date().toISOString(), downloads: tasks.filter((x) => x.source.url || x.source.magnet || x.source.torrent).map((x) => ({ name: x.name, source: { ...x.source }, dir: x.dir, state: x.state, size: x.total, note: noteOf(x.id) || undefined, meta: x.meta })) };
}
/** Added back from a list (those already here skipped); finished ones only when asked. */
export async function importList(text: string, opts: { finishedToo: boolean }, have: Task[]): Promise<{ added: number; skipped: number }> {
  let added = 0, skipped = 0; const eng = getEngine(); have = [...have];   // (each one added counted as here: a list naming a link twice adds it once)
  let file: ListFile | null = null; try { const j = JSON.parse(text) as ListFile; if (j && Array.isArray(j.downloads)) file = j; } catch { /* plain links */ }
  const items = file ? file.downloads : parseSources(text).map((source) => ({ name: '', source, state: 'queued', size: 0 } as ListFile['downloads'][number]));
  for (const d of items) {
    if (!opts.finishedToo && d.state === 'done') { skipped++; continue; }
    if (duplicateOf(d.source, have)) { skipped++; continue; }
    try { const task = await eng.add({ source: d.source, name: d.name || undefined, dir: d.dir && !d.dir.startsWith('content:') ? d.dir : getSettings().downloadDir || undefined, meta: d.meta }); if (d.note) setNote(task.id, d.note); have.push({ ...task, source: d.source }); added++; } catch { skipped++; }
  }
  return { added, skipped };
}

/* ---------- the same download twice ---------- */
const hashOf = (m?: string) => /xt=urn:btih:([a-z0-9]+)/i.exec(m ?? '')?.[1]?.toLowerCase();
const clean = (u?: string) => (u ?? '').replace(/#.*$/, '').replace(/[?&](utm_[^=&]+|fbclid|gclid)=[^&]*/g, '').replace(/\/+$/, '');
/** The download already in the list for this link or magnet (by its address, or the torrent's info-hash). */
export function duplicateOf(s: TaskSource, tasks: Task[]): Task | undefined {
  const h = hashOf(s.magnet);
  return tasks.find((x) => (h && (hashOf(x.source.magnet) === h || x.infoHash?.toLowerCase() === h)) || (s.url && x.source.url && clean(x.source.url) === clean(s.url)));
}
