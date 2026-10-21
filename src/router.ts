// Hash router: #/ (library), #/read/<id>[,<id>…], #/settings

export type Route =
  | { name: 'library' }
  | { name: 'read'; ids: string[] }
  | { name: 'settings' }
  | { name: 'notes' };

const listeners = new Set<(r: Route) => void>();

export function parseRoute(hash = location.hash): Route {
  const path = hash.replace(/^#/, '') || '/';
  const m = /^\/read\/([^/?]+)/.exec(path);
  if (m) return { name: 'read', ids: m[1].split(',').filter(Boolean) };
  if (path.startsWith('/settings')) return { name: 'settings' };
  if (path.startsWith('/notes')) return { name: 'notes' };
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
