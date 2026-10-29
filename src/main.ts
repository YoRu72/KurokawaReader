import { normalizeForSearch } from './formats/types';
import './styles/fonts.css';
import './styles/base.css';
import './styles/reader.css';
import { applyDocumentLang, onLangChange, loadLang, getLang } from './i18n';
import { onRoute, parseRoute, navigate, lastMove, type Route } from './router';
import { h } from './ui/dom';
import { libraryView } from './views/library';
import { applyChrome, onSettingsChange, getSettings } from './settings';
import { loadFonts } from './fonts';
import { initNativeBridges, isNative, setVolumeKeys } from './native';
import { registerNativePlugins } from './capacitor';
import { scheduleAutoCheck } from './updates';
import { initPcShell } from './ui/pcshell';

const app = document.getElementById('app')!;
let current: (HTMLElement & { dispose?: () => void }) | null = null;
let currentKey = '';

/** A view whose code is fetched when first wanted: a shell now, the view inside it when it arrives. */
function lazyView(make: () => Promise<HTMLElement & { dispose?: () => void }>): HTMLElement & { dispose?: () => void } {
  const shell = h('div', { class: 'view' }, h('div', { class: 'center' }, h('div', { class: 'spinner' }))) as HTMLElement & { dispose?: () => void };
  let inner: (HTMLElement & { dispose?: () => void }) | null = null; let gone = false;
  shell.dispose = () => { gone = true; inner?.dispose?.(); };
  // (`ready`: the view inside it has come — what is restored of it on the way back waits for that.)
  (shell as HTMLElement & { ready?: Promise<void> }).ready = make().then((el) => { if (gone) { el.dispose?.(); return; } inner = el; shell.replaceChildren(el); }).catch((e) => { console.error(e); shell.replaceChildren(h('div', { class: 'center' }, String(e))); });
  return shell;
}

/* The way back: a view left is remembered as it was — how far each of its scrolling parts was scrolled, which
 * of its sections were open — and shown so again when the reader comes back to it (the views are built
 * anew each time). Kept per address, for the session. */
interface ViewState { scrolls: { path: number[]; top: number; left: number }[]; open: string[] }
const states = new Map<string, ViewState>();
let currentPath = '';
const pathOf = (root: Element, el: Element): number[] => { const p: number[] = []; for (let e: Element = el; e !== root && e.parentElement; e = e.parentElement) p.unshift(Array.prototype.indexOf.call(e.parentElement.children, e)); return p; };
const at = (root: Element, path: number[]): HTMLElement | null => { let e: Element | null = root; for (const i of path) { e = e?.children[i] ?? null; if (!e) return null; } return e as HTMLElement; };
function snapshot(view: HTMLElement): ViewState {
  const scrolls: ViewState['scrolls'] = [];
  for (const el of Array.from(view.querySelectorAll<HTMLElement>('*'))) if (el.scrollTop > 0 || el.scrollLeft !== 0) scrolls.push({ path: pathOf(view, el), top: el.scrollTop, left: el.scrollLeft });
  const open = Array.from(view.querySelectorAll('section.card[id]')).filter((c) => !c.classList.contains('collapsed')).map((c) => c.id);
  return { scrolls, open };
}
function restore(view: HTMLElement, s: ViewState): void {
  for (const c of Array.from(view.querySelectorAll('section.card[id]'))) c.classList.toggle('collapsed', !s.open.includes(c.id));
  if (!s.scrolls.length) return;
  // (A view still arriving — a list drawn in batches, a page fetched — is scrolled as far as it reaches, again
  // and again for a while, until every part is where it was; a touch of the reader's ends it.)
  let tries = 0; let stop = false;
  const halt = () => { stop = true; };
  view.addEventListener('touchstart', halt, { once: true, passive: true }); view.addEventListener('wheel', halt, { once: true, passive: true }); view.addEventListener('keydown', halt, { once: true });
  const step = () => {
    if (stop || !view.isConnected) return;
    let pending = false;
    for (const sc of s.scrolls) {
      const el = at(view, sc.path);
      if (!el) { pending = true; continue; }
      if (Math.abs(el.scrollTop - sc.top) > 1) { el.scrollTop = sc.top; if (Math.abs(el.scrollTop - sc.top) > 1) pending = true; }
      if (sc.left !== 0 && Math.abs(el.scrollLeft - sc.left) > 1) el.scrollLeft = sc.left;
    }
    if (pending && ++tries < 40) setTimeout(step, 100);
  };
  requestAnimationFrame(step);
}

function mount(route: Route): void {
  const key = JSON.stringify(route);
  if (key === currentKey && current) return;
  currentKey = key;
  if (current && currentPath && !currentPath.startsWith('/read/')) { try { states.set(currentPath, snapshot(current)); } catch { /* not kept */ } }
  current?.dispose?.();
  current?.remove();
  document.querySelectorAll('.sheet, .sheet-scrim, .sel-toolbar, .lightbox').forEach((e) => e.remove());
  switch (route.name) {
    // (Each view's code fetched when first wanted: the library alone at start.)
    case 'read': current = lazyView(() => import('./views/reader').then((m) => m.readerView(route.ids))); break;
    case 'book': current = lazyView(() => import('./views/book').then((m) => m.bookView(route.id))); break;
    case 'settings': current = lazyView(() => import('./views/settings').then((m) => m.settingsView())); break;
    case 'notes': current = lazyView(() => import('./views/notes').then((m) => m.notesView())); break;
    case 'catalog': current = lazyView(() => import('./views/catalog').then((m) => m.catalogView(route.url, route.q))); break;
    case 'sources': current = lazyView(() => import('./views/sources').then((m) => m.sourcesView(route.src, route.book, route.q, route.shelf, route.tags))); break;
    default: current = libraryView();
  }
  app.appendChild(current);
  window.scrollTo(0, 0);
  currentPath = location.hash.replace(/^#/, '') || '/';
  const kept = lastMove() === 'pop' && route.name !== 'read' ? states.get(currentPath) : undefined;
  if (kept) { const view = current; const ready = (view as HTMLElement & { ready?: Promise<void> }).ready; if (ready) void ready.then(() => { if (view.isConnected) restore(view, kept); }); else restore(view, kept); }
}

// (The interface's language fetched before anything is drawn in it.)
await loadLang(getLang());
registerNativePlugins();
applyDocumentLang();
applyChrome();
initPcShell();
setTimeout(() => void import('./ui/share').then((m) => m.clearShareCache()), 8000);
void loadFonts();
initNativeBridges();
void setVolumeKeys(getSettings().volumeKeys);
scheduleAutoCheck();
setTimeout(() => void import('./sources/updates').then((m) => m.scheduleUpdateChecks()).catch(() => undefined), 4000);
// (Downloads the app was closed in the middle of: taken up again.)
setTimeout(() => void import('./downloads').then((m) => m.resumeDownloads()).catch(() => undefined), 2500);
// (The automatic backup, when due — well after the start, out of its way.)
setTimeout(() => void import('./backup').then((m) => m.autoBackupIfDue()).catch(() => undefined), 30000);
// AniList changes made while it could not be reached, sent now (and when the network comes back).
setTimeout(() => { try { if (localStorage.getItem('kr.al.pending')) void import('./ui/track').then((m) => { m.watchPending(); void m.flushTracking(); }).catch(() => undefined); } catch { /* private mode */ } }, 5000);
import('./sync').then((m) => m.initSync(() => void import('./ui/syncsheet').then((u) => u.askSyncSheet()))).catch(() => undefined);
void import('./samples').then((m) => m.refreshSampleCovers()).catch(() => undefined);
onSettingsChange((s) => applyChrome(s));
onLangChange(() => { currentKey = ''; mount(parseRoute()); });
onRoute(mount);
mount(parseRoute());
// Optionally resume the last book on a cold start.
if (getSettings().openLastOnLaunch && (location.hash === '' || location.hash === '#/' || location.hash === '#')) {
  void import('./db').then(({ db }) => db.allBooks()).then((books) => {
    const last = books.filter((b) => b.lastOpenedAt).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0];
    if (last) navigate(`/read/${last.id}`);
  });
}

// Offline support.
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !isNative()) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => undefined); });
} else if (isNative()) {
  // The installed app ships its files; an offline cache left by an older version would only duplicate them (and books).
  void navigator.serviceWorker?.getRegistrations?.().then((regs) => regs.forEach((r) => void r.unregister())).catch(() => {});
  void caches?.keys?.().then((keys) => keys.forEach((k) => void caches.delete(k))).catch(() => {});
}

// Keep the install prompt for the Settings page.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__krInstallPrompt = e as unknown as { prompt(): Promise<void> };
});

// For tests: one PDF page's text items (as the patched pdf.js gives them) and its reading text.
(window as unknown as { krNorm?: unknown }).krNorm = (s: string) => normalizeForSearch(s);
(window as unknown as { krPdfDebug?: unknown }).krPdfDebug = async (bytes: Uint8Array, n: number) => {
  const { loadPdfjs } = await import('./formats/pdf');
  const { pageReadingText } = await import('./pdflayer');
  const pdfjs = await loadPdfjs();
  const RES = new URL('./pdfjs/', import.meta.url).href;
  const { openPdfjs } = await import('./pdfkeys');
  const o = await openPdfjs(pdfjs, bytes, { cMapUrl: `${RES}cmaps/`, cMapPacked: true, standardFontDataUrl: `${RES}standard_fonts/`, wasmUrl: `${RES}wasm/`, isEvalSupported: false });
  if (!n) {
    // All pages' reading text (up to 40), for comparing extraction before and after a change.
    const all: string[] = [];
    for (let k = 1; k <= Math.min(40, o.doc.numPages); k++) all.push(`=== ${k}\n${await pageReadingText(await o.doc.getPage(k))}`);
    o.destroy();
    return { items: [], text: all.join('\n') };
  }
  const page = await o.doc.getPage(n);
  const tc = await page.getTextContent();
  const items = (tc.items as { str?: string; transform: number[]; width: number; dir?: string; fontName?: string }[]).filter((i) => typeof i.str === 'string').map((i) => [i.str, +i.transform[4].toFixed(1), +i.transform[5].toFixed(1), +i.width.toFixed(1), i.dir, i.fontName]);
  const text = await pageReadingText(page);
  o.destroy();
  return { items, text };
};
