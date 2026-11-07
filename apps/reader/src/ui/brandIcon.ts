// (The same file is in both apps' src/ui: a change to one goes to both.)
// The icon of the user's choosing inside the app too — the sidebar's logo, the window's and the tab's little icon —,
// not only the desktop's shortcuts and the taskbar: kept here when chosen, put back at each start.
const KEY = 'app.icon';
const DEFAULT = 'icons/icon.svg';

/** The chosen icon (a PNG data URL), or null for the app's own. */
export function brandIcon(): string | null { try { return localStorage.getItem(KEY); } catch { return null; } }

/** Kept (or forgotten, with null) and shown everywhere in the app at once. */
export function setBrandIcon(url: string | null): void {
  try { if (url) localStorage.setItem(KEY, url); else localStorage.removeItem(KEY); } catch { /* full or private: shown for now only */ }
  applyBrandIcon(url);
}

/** Every logo of the app's own in the page, and the page's icon, made the chosen one (or back to the app's). */
export function applyBrandIcon(url: string | null = brandIcon()): void {
  for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('img[data-brand]'))) img.src = url || DEFAULT;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
  if (!link.dataset.orig) link.dataset.orig = link.getAttribute('href') || DEFAULT;
  link.href = url || link.dataset.orig;
}
