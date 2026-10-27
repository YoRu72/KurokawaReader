// Hash router: #/ (library), #/read/<id>[,<id>…], #/book/<id>, #/settings, #/notes, #/catalog[?u=<feed>&q=<query>]

export type Route =
  | { name: 'library' }
  | { name: 'read'; ids: string[] }
  | { name: 'book'; id: string }
  | { name: 'settings' }
  | { name: 'notes' }
  | { name: 'catalog'; url?: string; q?: string };

const listeners = new Set<(r: Route) => void>();

export function parseRoute(hash = location.hash): Route {
  const path = hash.replace(/^#/, '') || '/';
  const m = /^\/read\/([^/?]+)/.exec(path);
  if (m) return { name: 'read', ids: m[1].split(',').filter(Boolean) };
  const b = /^\/book\/([^/?]+)/.exec(path);
  if (b) return { name: 'book', id: b[1] };
  if (path.startsWith('/settings')) return { name: 'settings' };
  if (path.startsWith('/notes')) return { name: 'notes' };
  if (path.startsWith('/catalog')) { const sp = new URLSearchParams(path.split('?')[1] ?? ''); return { name: 'catalog', url: sp.get('u') ?? undefined, q: sp.get('q') ?? undefined }; }
  return { name: 'library' };
}

export function navigate(path: string, replace = false): void {
  const url = `#${path}`;
  if (replace) history.replaceState(null, '', url); else location.hash = path;
  if (replace) emit();
}

export function back(fallback = '/'): void {
  if (history.length > 1 && document.referrer !== '') history.back();
  else if (history.length > 1) history.back();
  else navigate(fallback);
}

function emit() {
  const r = parseRoute();
  listeners.forEach((fn) => fn(r));
}

export function onRoute(fn: (r: Route) => void): void {
  listeners.add(fn);
}

window.addEventListener('hashchange', emit);
