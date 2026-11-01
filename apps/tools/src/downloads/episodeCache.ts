// Episodes kept or let go (Hayase's storage choices): an anime or TV episode downloaded to be watched can stay,
// go once it is watched (when the player closes), or go a number of days after it was watched; how much room the
// episodes take, and the watched ones (or all of them) deleted at once.
import { getEngine } from '../engine';
import type { Task } from '../engine/types';
import { getSettings } from '../settings';

const KEY = 'kt.watchedTasks';
export type CacheMode = 'keep' | 'watched' | 'days';
export const cacheMode = (): { mode: CacheMode; days: number } => ({ mode: getSettings().episodeCache?.mode ?? 'keep', days: Math.max(1, getSettings().episodeCache?.days ?? 7) });
const read = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>; } catch { return {}; } };
const write = (m: Record<string, number>) => { try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* full */ } };
/** An episode's download: one that came for an anime episode or a series' episode (or a film). */
export const isEpisode = (x: Task): boolean => { const m = x.meta as { anilistId?: number; imdbId?: string } | undefined; return !!(m?.anilistId || m?.imdbId); };
export function noteWatched(x: Task | undefined): void { if (!x || !isEpisode(x)) return; const m = read(); if (!m[x.id]) { m[x.id] = Date.now(); write(m); } }
export const watchedAt = (id: string): number | undefined => read()[id];
export function forget(id: string): void { const m = read(); if (id in m) { delete m[id]; write(m); } }
async function drop(x: Task): Promise<boolean> { try { await getEngine().remove(x.id, true); forget(x.id); return true; } catch { return false; } }
/** The player closed: the episode goes now when that is the choice and it was watched. */
export async function afterPlayback(x: Task | undefined): Promise<boolean> {
  if (!x || !isEpisode(x) || cacheMode().mode !== 'watched' || !watchedAt(x.id) || x.state !== 'done') return false;
  return drop(x);
}
/** Watched episodes older than the days chosen (at the start and every hour). */
export async function cleanOld(): Promise<number> {
  const { mode, days } = cacheMode(); if (mode !== 'days') return 0;
  const w = read(); const cut = Date.now() - days * 86400000; let n = 0;
  for (const x of await getEngine().list().catch(() => [] as Task[])) if (isEpisode(x) && x.state === 'done' && w[x.id] && w[x.id] < cut && (await drop(x))) n++;
  return n;
}
export interface Usage { episodes: number; bytes: number; watched: number; watchedBytes: number }
export async function usage(): Promise<Usage> {
  const w = read(); const u: Usage = { episodes: 0, bytes: 0, watched: 0, watchedBytes: 0 };
  for (const x of await getEngine().list().catch(() => [] as Task[])) { if (!isEpisode(x)) continue; u.episodes++; u.bytes += x.done; if (w[x.id]) { u.watched++; u.watchedBytes += x.done; } }
  return u;
}
/** Every watched episode deleted (or every episode), files and all; the count. */
export async function deleteEpisodes(onlyWatched: boolean): Promise<number> {
  const w = read(); let n = 0;
  for (const x of await getEngine().list().catch(() => [] as Task[])) if (isEpisode(x) && (!onlyWatched || w[x.id]) && (await drop(x))) n++;
  return n;
}
let started = false;
export function startEpisodeCache(): void { if (started) return; started = true; void cleanOld(); setInterval(() => void cleanOld(), 3600000); }
