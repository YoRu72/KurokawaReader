// The last good answer of each Anime list (a season, the schedule, a status of the user's list, Discover): shown at once
// the next time that list is opened — marked as being refreshed — and replaced when the new answer arrives, so a slow or
// failing catalogue never leaves an empty screen where something older is known. Kept on the device (kt.cache: not in the
// settings backup), at most a dozen lists and about 600 000 characters in all; one list over 250 000 is not kept.
const KEY = 'kt.cache.animeLists';
export const MAX_LISTS = 12; export const MAX_CHARS = 600000; export const MAX_ONE = 250000;
type Kept = Record<string, { at: number; v: unknown }>;
const read = (): Kept => { try { const x = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Kept; return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; } catch { return {}; } };
/** The list kept under this name, and when (ms). */
export function cached<T>(key: string): { at: number; v: T } | null { const e = read()[key]; return e && typeof e.at === 'number' && e.v !== undefined ? (e as { at: number; v: T }) : null; }
/** Keeps a list (the oldest ones are let go to stay under the caps). */
export function keep(key: string, v: unknown): void {
  let text: string; try { text = JSON.stringify(v); } catch { return; }
  if (!text || text.length > MAX_ONE) return;
  const all = read(); all[key] = { at: Date.now(), v };
  const order = (): string[] => Object.keys(all).sort((a, b) => all[a].at - all[b].at);
  const size = (): number => Object.values(all).reduce((n, e) => n + JSON.stringify(e.v).length, 0);
  while (Object.keys(all).length > MAX_LISTS || (size() > MAX_CHARS && Object.keys(all).length > 1)) { const o = order().find((k) => k !== key); if (!o) break; delete all[o]; }
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* full: the older copy stays */ }
}
export function forget(): void { try { localStorage.removeItem(KEY); } catch { /* none */ } }
