// Where the player goes back to: the page it was opened from (a show's page, the Downloads, a folder), as it was.
// If the phone let the app go while a video was open in the app's own player (Android may end the page's process
// and start the app anew, on its first page, with no history), the app goes back to that page on starting, with
// its history and its tabs as they were, so Back goes where it went before. Only while the video was really
// playing a moment ago (the player keeps the record fresh): a start long after, or after an external player, is a
// normal start. After an episode counted as watched, the show's page is told (the review prompt) and the
// episode's row brought into view.
import { navigate, parseRoute, routerInternals } from '../router';
import { tabTrail, tabPath, noteTab } from '../ui/backstack';

export const FROM_KEY = 'kt.tmp.playerFrom';   // (kt.tmp: never in the settings backup)
/** How fresh the record must be to be put back on starting (the player refreshes it every few seconds). */
const FRESH_MS = 3 * 60e3;
interface From { hash: string; at: number; scroll: number; anilistId?: number; episode?: number; paths?: string[]; tabs?: [string, string][] }
const scroller = (): HTMLElement | null => document.querySelector<HTMLElement>('.view:not([hidden]) > .body') ?? document.querySelector<HTMLElement>('.view:not([hidden])');
const read = (): From | null => { try { return JSON.parse(localStorage.getItem(FROM_KEY) ?? 'null') as From | null; } catch { return null; } };
const write = (f: From | null) => { try { if (f) localStorage.setItem(FROM_KEY, JSON.stringify(f)); else localStorage.removeItem(FROM_KEY); } catch { /* full */ } };
/** Kept when a video is opened in the app's own player (the page under it, its history, how far it was scrolled). */
export function notePlayerOpen(meta?: { anilistId?: number; episode?: number }): void {
  write({ hash: location.hash || '#/', at: Date.now(), scroll: scroller()?.scrollTop ?? 0, anilistId: meta?.anilistId, episode: meta?.episode, paths: routerInternals.stack.slice(-12), tabs: tabTrail.map((s) => [s, tabPath.get(s) ?? '']) });
}
/** The record dropped: the video went to another app, or never opened (the app started again must not go back to a page for it). */
export function forgetPlayerOpen(): void { write(null); }
/** The player still open: the record kept fresh (called as it plays). */
export function touchPlayerOpen(): void { const f = read(); if (f) { f.at = Date.now(); write(f); } }
/** The player closed (its Back, the end, a swipe): back to where it was opened from, scrolled as it was; a watched
 *  episode's show told. `at`: the page when it closed (read at once) — the user gone elsewhere since: left there. */
export function playerClosed(o: { watched: boolean; meta?: { anilistId?: number; episode?: number }; at?: string }): void {
  const f = read(); write(null);
  const id = o.meta?.anilistId ?? f?.anilistId; const ep = o.meta?.episode ?? f?.episode;
  // (An episode counted as watched is brought into view; one only left — Back — leaves the page exactly as it was.)
  if (id && ep && o.watched) try { sessionStorage.setItem('kt.anime.focusEp', JSON.stringify({ id, ep })); } catch { /* none */ }
  const now = location.hash || '#/'; const moved = o.at !== undefined && now !== (o.at || '#/');
  if (f && !moved && now !== f.hash) navigate(f.hash.replace(/^#/, '') || '/');
  else if (f && now === f.hash) { const s = scroller(); if (s && f.scroll) s.scrollTop = f.scroll; }
  if (o.watched && id && ep) try { sessionStorage.setItem('kt.anime.reviewAsk', JSON.stringify({ id, ep, at: Date.now() })); } catch { /* none */ }
  if (o.watched && id && ep) window.dispatchEvent(new CustomEvent('kt-anime-watched', { detail: { id, ep } }));
}
/** The history put back as it was: the browser's entries and the router's, so Back goes where it went before. */
function seedHistory(paths: string[]): void {
  history.replaceState(history.state, '', `#${paths[0]}`);
  for (const p of paths.slice(1)) history.pushState(history.state, '', `#${p}`);
  const { stack, listeners, setMove } = routerInternals; stack.length = 0; stack.push(...paths); setMove('replace');
  listeners.forEach((fn) => fn(parseRoute())); setMove('push');
}
/** On starting (main.ts, only when a record is there): the page a video was open over a moment ago, with its history
 *  and its tabs; anything older is dropped. */
export function restoreAtStart(): void {
  const f = read(); write(null);
  if (!f || Date.now() - f.at > FRESH_MS || !f.hash || f.hash === '#/' || (location.hash && location.hash !== '#/' && location.hash !== '#')) return;
  for (const [s, p] of f.tabs ?? []) if (p) noteTab(s, p);
  const paths = f.paths?.length && f.paths[f.paths.length - 1] === f.hash.replace(/^#/, '') ? f.paths : [f.hash.replace(/^#/, '')];
  seedHistory(paths);
  if (f.anilistId && f.episode) try { sessionStorage.setItem('kt.anime.focusEp', JSON.stringify({ id: f.anilistId, ep: f.episode })); } catch { /* none */ }
}
