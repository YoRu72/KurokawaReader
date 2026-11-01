// Hash router: #/ (downloads), #/task/<id>, #/add[?u=<link>], #/search[?q=], #/settings[/<section>], #/addons.
export type Route =
  | { name: 'downloads'; filter?: string }
  | { name: 'task'; id: string }
  | { name: 'add'; u?: string }
  | { name: 'search'; q?: string; addon?: string }
  | { name: 'settings'; section?: string }
  | { name: 'addons' }
  | { name: 'anime'; tab?: string; q?: string; genre?: string; tag?: string }
  | { name: 'animeEntry'; id: number }
  | { name: 'subs'; q?: string }
  | { name: 'tv'; tab?: string; q?: string }
  | { name: 'tvTitle'; type: 'movie' | 'series'; id: string; season?: number };

const listeners = new Set<(r: Route) => void>();
export function parseRoute(hash = location.hash): Route {
  const path = hash.replace(/^#/, '') || '/';
  const [p, qs] = path.split('?'); const sp = new URLSearchParams(qs ?? '');
  const task = /^\/task\/([^/]+)/.exec(p); if (task) return { name: 'task', id: decodeURIComponent(task[1]) };
  // (#/open?u= is how Android hands over a magnet, a .torrent or a shared link — also while the app is open.)
  if (p.startsWith('/add') || p === '/open') return { name: 'add', u: sp.get('u') ?? undefined };
  if (p.startsWith('/search')) return { name: 'search', q: sp.get('q') ?? undefined, addon: sp.get('addon') ?? undefined };
  if (p.startsWith('/addons')) return { name: 'addons' };
  const an = /^\/anime\/(\d+)/.exec(p); if (an) return { name: 'animeEntry', id: Number(an[1]) };
  if (p.startsWith('/subs')) return { name: 'subs', q: sp.get('q') ?? undefined };
  const tvt = /^\/tv\/(movie|series)\/(tt\d+)/.exec(p); if (tvt) return { name: 'tvTitle', type: tvt[1] as 'movie', id: tvt[2], season: sp.get('s') ? Number(sp.get('s')) : undefined };
  if (p.startsWith('/tv')) return { name: 'tv', tab: sp.get('tab') ?? undefined, q: sp.get('q') ?? undefined };
  if (p.startsWith('/anime')) return { name: 'anime', tab: sp.get('tab') ?? undefined, q: sp.get('q') ?? undefined, genre: sp.get('genre') ?? undefined, tag: sp.get('tag') ?? undefined };
  const st = /^\/settings(?:\/([^/]+))?/.exec(p); if (st) return { name: 'settings', section: st[1] };
  return { name: 'downloads', filter: sp.get('f') ?? undefined };
}
const current = () => location.hash.replace(/^#/, '') || '/';
const stack: string[] = [current()];
let pushing: string | null = null; let move: 'push' | 'pop' | 'replace' | 'start' = 'start';
export const lastMove = () => move;
export function navigate(path: string, replace = false): void {
  const target = `#${path}`;
  if (replace) { move = 'replace'; stack[stack.length - 1] = path; location.replace(target); return; }
  pushing = path; location.hash = target;
}
/** The part of the app a place belongs to (the tab it lives under). */
export function sectionOf(path: string): string {
  const p = path.split('?')[0];
  if (p.startsWith('/anime')) return 'anime'; if (p.startsWith('/tv')) return 'tv'; if (p.startsWith('/subs')) return 'subs';
  if (p.startsWith('/settings') || p.startsWith('/addons')) return 'settings'; if (p.startsWith('/search')) return 'search';
  return 'downloads';
}
/** Up from this view: to the one it was opened from when that is in the same part of the app (a show opened from
 *  its list), else to `fallback`, its part's own top — never into another tab's past, which made Back go round
 *  between two tabs. */
export function back(fallback = '/'): void {
  const prev = stack[stack.length - 2];
  if (stack.length > 1 && prev !== undefined && sectionOf(prev) === sectionOf(current()) && prev !== current()) { history.back(); return; }
  navigate(fallback, true);
}
window.addEventListener('hashchange', () => {
  const now = current();
  if (pushing === now) { stack.push(now); move = 'push'; pushing = null; }
  else if (stack.length > 1 && stack[stack.length - 2] === now) { stack.pop(); move = 'pop'; }
  else if (move !== 'replace') { stack.push(now); move = 'push'; }
  listeners.forEach((fn) => fn(parseRoute()));
  move = move === 'replace' ? 'push' : move;
});
export function onRoute(fn: (r: Route) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
