// Hash router: #/ (library), #/read/<id>[,<id>…], #/book/<id>, #/settings, #/notes, #/catalog[?u=<feed>&q=<query>],
// #/sources[/<source>[/book/<id>]][?q=&shelf=&tags=]

export type Route =
  | { name: 'library' }
  | { name: 'read'; ids: string[] }
  | { name: 'book'; id: string }
  | { name: 'settings' }
  | { name: 'notes' }
  | { name: 'catalog'; url?: string; q?: string }
  | { name: 'sources'; src?: string; book?: string; q?: string; shelf?: string; tags?: string[]; v?: string };

const listeners = new Set<(r: Route) => void>();

export function parseRoute(hash = location.hash): Route {
  const path = hash.replace(/^#/, '') || '/';
  const m = /^\/read\/([^/?]+)/.exec(path);
  if (m) return { name: 'read', ids: m[1].split(',').filter(Boolean) };
  const b = /^\/book\/([^/?]+)/.exec(path);
  if (b) return { name: 'book', id: b[1] };
  if (path.startsWith('/settings')) return { name: 'settings' };
  if (path.startsWith('/notes')) return { name: 'notes' };
  if (path.startsWith('/sources')) {
    const [p0, qs] = path.split('?'); const sp = new URLSearchParams(qs ?? '');
    const m = /^\/sources(?:\/([^/?]+))?(?:\/book\/([^/?]+))?/.exec(p0);
    return { name: 'sources', src: m?.[1] || undefined, book: m?.[2] ? decodeURIComponent(m[2]) : undefined, q: sp.get('q') ?? undefined, shelf: sp.get('shelf') ?? undefined, tags: sp.get('tags') ? sp.get('tags')!.split('\u0001').filter(Boolean) : undefined, v: sp.get('v') ?? undefined };
  }
  if (path.startsWith('/catalog')) { const sp = new URLSearchParams(path.split('?')[1] ?? ''); return { name: 'catalog', url: sp.get('u') ?? undefined, q: sp.get('q') ?? undefined }; }
  return { name: 'library' };
}

// The way back: the views visited in this session, as a stack beside the browser's history (every navigate
// pushes one entry on both; a replace changes the top of both; the browser's back pops both). Back from a
// view goes to the view it was opened from — the shelf a book was found on, the book's page, the library —
// and only without one, to the view's own fallback.
const current = () => location.hash.replace(/^#/, '') || '/';
const stack: string[] = [current()];
let pushing: string | null = null;

export function navigate(path: string, replace = false): void {
  const url = `#${path}`;
  if (replace) { history.replaceState(null, '', url); stack[stack.length - 1] = path; emit(); return; }
  if (location.hash === url || (path === '/' && (location.hash === '' || location.hash === '#'))) return;
  pushing = path;
  location.hash = path;
}

/** Whether a view was opened from another in this session (there is something to go back to). */
export function canGoBack(): boolean { return stack.length > 1; }

/** Back to the view this one was opened from; `fallback` when it was the first (a cold start, a link). */
export function back(fallback = '/'): void {
  if (stack.length > 1) { history.back(); return; }
  navigate(fallback, true);
}

function emit() {
  const r = parseRoute();
  listeners.forEach((fn) => fn(r));
}

export function onRoute(fn: (r: Route) => void): void {
  listeners.add(fn);
}

window.addEventListener('hashchange', () => {
  const p = current();
  if (pushing === p) stack.push(p);
  else if (stack.length > 1 && stack[stack.length - 2] === p) stack.pop();
  else if (stack[stack.length - 1] !== p) stack.push(p);
  pushing = null;
  emit();
});
