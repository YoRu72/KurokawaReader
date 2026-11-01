// What the user follows and has seen (kept on the device, as Trakt would keep it): the watchlist, the episodes and
// films watched, «continue watching» (the next aired episode of a series you are in), and the series followed so
// their new episodes download by themselves as they come out (checked when the app opens and every hour).
import type { TvKind, TvMeta, TvEpisode } from './cinemeta';
import { getSettings, updateSettings } from '../settings';

export interface Saved { id: string; type: TvKind; name: string; poster?: string; year?: string; added: number }
export interface Follow { id: string; name: string; poster?: string; season: number; episode: number; quality: string; enabled: boolean; at?: number }
const WL = 'kt.tv.watchlist'; const SEEN = 'kt.tv.seen';
const read = <T>(k: string, d: T): T => { try { return (JSON.parse(localStorage.getItem(k) ?? 'null') as T) ?? d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full */ } };

export const watchlist = (): Saved[] => read<Saved[]>(WL, []);
export const inWatchlist = (id: string): boolean => watchlist().some((x) => x.id === id);
export function toggleWatchlist(m: TvMeta): boolean { const l = watchlist(); const on = !l.some((x) => x.id === m.id); write(WL, on ? [{ id: m.id, type: m.type, name: m.name, poster: m.poster, year: m.year ?? m.releaseInfo, added: Date.now() }, ...l] : l.filter((x) => x.id !== m.id)); return on; }

/** Seen: «tt…» (a film) or «tt…:s:e» (an episode), with when. */
type Seen = Record<string, number>;
export const seen = (): Seen => read<Seen>(SEEN, {});
export const isSeen = (key: string): boolean => !!seen()[key];
export function setSeen(key: string, on: boolean): void { const s = seen(); if (on) s[key] = Date.now(); else delete s[key]; write(SEEN, s); }
export function markWatched(id: string, season?: number, episode?: number): void { setSeen(season !== undefined && episode !== undefined ? `${id}:${season}:${episode}` : id, true); }
/** The last episode seen of a series (by order, not by date). */
export function lastSeen(m: TvMeta): { season: number; episode: number } | null {
  const s = seen(); let best: { season: number; episode: number } | null = null;
  for (const v of m.videos ?? []) if (s[`${m.id}:${v.season}:${v.episode}`] && v.season > 0 && (!best || v.season > best.season || (v.season === best.season && v.episode > best.episode))) best = { season: v.season, episode: v.episode };
  return best;
}
/** The next aired episode after the last one seen (or the first of the show). */
export function nextUp(m: TvMeta, now = Date.now()): TvEpisode | null {
  const vs = (m.videos ?? []).filter((v) => v.season > 0); const last = lastSeen(m);
  const i = last ? vs.findIndex((v) => v.season === last.season && v.episode === last.episode) + 1 : 0;
  const v = vs[i]; return v && (!v.released || Date.parse(v.released) <= now) ? v : null;
}
/** Series being watched: in the watchlist or with episodes seen, most recently touched first. */
export function watchingIds(): string[] {
  const s = seen(); const by = new Map<string, number>();
  for (const [k, at] of Object.entries(s)) { const id = k.split(':')[0]; if (k.includes(':')) by.set(id, Math.max(by.get(id) ?? 0, at)); }
  return [...by].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/* ---------- followed series (new episodes fetched as they air) ---------- */
export const follows = (): Follow[] => (getSettings().tvFollows ?? []) as Follow[];
export const followOf = (id: string): Follow | undefined => follows().find((f) => f.id === id);
export function saveFollow(f: Follow): void { updateSettings({ tvFollows: [...follows().filter((x) => x.id !== f.id), f] }); }
export function dropFollow(id: string): void { updateSettings({ tvFollows: follows().filter((x) => x.id !== id) }); }
