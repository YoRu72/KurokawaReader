// Where the player goes back to: the page it was opened from (a show's page, the Downloads, a folder), as it was —
// even when the phone let the app go while the player or another app was in front (the app then starts again on
// its first page: main.ts reads the place kept here and goes back to it). After an episode counted as watched, the
// show's page is told (the review prompt) and the episode's row is brought into view.
import { navigate } from '../router';

export const FROM_KEY = 'kt.player.from';
interface From { hash: string; at: number; scroll: number; anilistId?: number; episode?: number }
const scroller = (): HTMLElement | null => document.querySelector<HTMLElement>('.view:not([hidden]) > .body') ?? document.querySelector<HTMLElement>('.view:not([hidden])');
/** Kept when a video is opened (the page under it, and how far it was scrolled). */
export function notePlayerOpen(meta?: { anilistId?: number; episode?: number }): void {
  const f: From = { hash: location.hash || '#/', at: Date.now(), scroll: scroller()?.scrollTop ?? 0, anilistId: meta?.anilistId, episode: meta?.episode };
  try { localStorage.setItem(FROM_KEY, JSON.stringify(f)); } catch { /* full */ }
}
/** The player closed (its Back, the end, a swipe): back to where it was opened from, scrolled as it was; a watched
 *  episode's show told. */
export function playerClosed(o: { watched: boolean; meta?: { anilistId?: number; episode?: number }; /** The page when it closed (read at once): somewhere else since — the user went on — and nothing is moved. */ at?: string }): void {
  let f: From | null = null; try { f = JSON.parse(localStorage.getItem(FROM_KEY) ?? 'null') as From | null; localStorage.removeItem(FROM_KEY); } catch { /* none */ }
  const id = o.meta?.anilistId ?? f?.anilistId; const ep = o.meta?.episode ?? f?.episode;
  if (id && ep) try { sessionStorage.setItem('kt.anime.focusEp', JSON.stringify({ id, ep })); } catch { /* none */ }
  const moved = o.at !== undefined && (location.hash || '#/') !== (o.at || '#/');
  if (f && !moved && (location.hash || '#/') !== f.hash) navigate(f.hash.replace(/^#/, '') || '/');
  else if (f) { const s = scroller(); if (s && f.scroll) s.scrollTop = f.scroll; }
  if (o.watched && id && ep) try { sessionStorage.setItem('kt.anime.reviewAsk', JSON.stringify({ id, ep, at: Date.now() })); } catch { /* none */ }
  if (o.watched && id && ep) window.dispatchEvent(new CustomEvent('kt-anime-watched', { detail: { id, ep } }));
}
