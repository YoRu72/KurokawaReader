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
  | { name: 'subs'; q?: string };

const listeners = new Set<(r: Route) => void>();
export function parseRoute(hash = location.hash): Route {
  const path = hash.replace(/^#/, '') || '/';
  const [p, qs] = path.split('?'); const sp = new URLSearchParams(qs ?? '');
  const task = /^\/task\/([^/]+)/.exec(p); if (task) return { name: 'task', id: decodeURIComponent(task[1]) };
  if (p.startsWith('/add')) return { name: 'add', u: sp.get('u') ?? undefined };
  if (p.startsWith('/search')) return { name: 'search', q: sp.get('q') ?? undefined, addon: sp.get('addon') ?? undefined };
  if (p.startsWith('/addons')) return { name: 'addons' };
  const an = /^\/anime\/(\d+)/.exec(p); if (an) return { name: 'animeEntry', id: Number(an[1]) };
  if (p.startsWith('/subs')) return { name: 'subs', q: sp.get('q') ?? undefined };
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
/** Back to the view this one was opened from; `fallback` when there is none. */
export function back(fallback = '/'): void {
  if (stack.length > 1) { history.back(); return; }
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
