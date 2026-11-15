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
/** How the view on screen was reached: opened from another (push), come back to (pop), put in place of the
 *  one before (replace), or the first of the session (start). A view come back to is shown as it was left. */
let move: 'start' | 'push' | 'pop' | 'replace' = 'start';
export const lastMove = () => move;

export function navigate(path: string, replace = false): void {
  const url = `#${path}`;
  if (replace) { history.replaceState(null, '', url); stack[stack.length - 1] = path; move = 'replace'; emit(); return; }
  if (location.hash === url || (path === '/' && (location.hash === '' || location.hash === '#'))) return;
  pushing = path;
  // (An entry of its own, always: a `location.hash` set by the app itself before the page has finished loading — the
  // book opened again at a start, src/resume.ts — REPLACES the entry it is on (the browser's rule for navigations no
  // tap asked for), so the reader had nothing beneath it to go back to: Back did nothing, again and again (0.62.1, a
  // phone). pushState always adds one; the hashchange the address change owes is said here, as the browser would.)
  const oldURL = location.href;
  try { history.pushState(null, '', url); } catch { location.hash = path; return; }
  const newURL = location.href;
  window.setTimeout(() => window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL })), 0);
}

/** The view beneath the one shown (null: none in this session). */
export const viewBelow = (): string | null => (stack.length > 1 ? stack[stack.length - 2] : null);
/** Whether a view was opened from another in this session (there is something to go back to). */
export function canGoBack(): boolean { return stack.length > 1; }

/** Back to the view this one was opened from; `fallback` when it was the first (a cold start, a link). */
export function back(fallback = '/'): void {
  if (stack.length > 1 && entryBelow()) {
    // (Watched: a step back the browser did not take — nothing beneath after all, or the step lost — is taken here.)
    const from = current(); const depth = stack.length;
    history.back();
    window.clearTimeout(backCheck);
    backCheck = window.setTimeout(() => { if (current() === from && stack.length === depth) up(stack[depth - 2] ?? fallback, 'lost'); }, BACK_CHECK_MS);
    return;
  }
  // (The view believed to be beneath, though the browser has no entry for it — or none at all: put in place of this one.)
  if (stack.length > 1) { up(stack[stack.length - 2], 'none'); return; }
  navigate(fallback, true);
}

/** How long a step back may take before it is taken another way (ms). */
export const BACK_CHECK_MS = 600;
let backCheck = 0;
/** Whether the browser has an entry of this app just beneath the one shown (the Navigation API, where there is one;
 *  without it, believed). */
function entryBelow(): boolean {
  const nav = (window as unknown as { navigation?: { currentEntry?: { index: number } | null; entries?(): { url: string | null }[] } }).navigation;
  const cur = nav?.currentEntry;
  if (!nav || !cur || typeof nav.entries !== 'function') return true;
  if (cur.index <= 0) return false;
  const prev = nav.entries()[cur.index - 1];
  try { const u = new URL(prev?.url ?? ''); return u.origin === location.origin && u.pathname === location.pathname; } catch { return false; }
}
/** One view up without the browser's history: `path` put in place of the view shown, which is forgotten. */
function up(path: string, why: string): void {
  window.clearTimeout(backCheck);
  if (stack.length > 1) stack.pop();
  stack[stack.length - 1] = path;
  try { history.replaceState(null, '', `#${path}`); } catch { /* the address stays; the view changes */ }
  move = 'pop';
  window.dispatchEvent(new CustomEvent('kr:backfix', { detail: why }));
  emit();
}
/** Leave the view on screen for the one beneath it (the library when none), whatever the browser's history holds: the
 *  safety net's way out (src/native.ts) when Back has not worked. */
export function leaveView(fallback = '/'): void {
  const below = stack.length > 1 ? stack[stack.length - 2] : fallback;
  up(below === current() ? '/' : below, 'forced');
}

function emit() {
  const r = parseRoute();
  listeners.forEach((fn) => fn(r));
}

export function onRoute(fn: (r: Route) => void): void {
  listeners.add(fn);
}

window.addEventListener('hashchange', () => {
  window.clearTimeout(backCheck);
  const p = current();
  if (pushing === p) { stack.push(p); move = 'push'; }
  else if (stack.length > 1 && stack[stack.length - 2] === p) { stack.pop(); move = 'pop'; }
  else if (stack[stack.length - 1] !== p) { stack.push(p); move = 'push'; }
  pushing = null;
  emit();
});
