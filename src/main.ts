import { normalizeForSearch } from './formats/types';
import './styles/fonts.css';
import './styles/base.css';
import './styles/reader.css';
import { applyDocumentLang, onLangChange } from './i18n';
import { onRoute, parseRoute, navigate, type Route } from './router';
import { h } from './ui/dom';
import { libraryView } from './views/library';
import { readerView } from './views/reader';
import { bookView } from './views/book';
import { settingsView } from './views/settings';
import { notesView } from './views/notes';
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
  void make().then((el) => { if (gone) { el.dispose?.(); return; } inner = el; shell.replaceChildren(el); }).catch((e) => { console.error(e); shell.replaceChildren(h('div', { class: 'center' }, String(e))); });
  return shell;
}

function mount(route: Route): void {
  const key = JSON.stringify(route);
  if (key === currentKey && current) return;
  currentKey = key;
  current?.dispose?.();
  current?.remove();
  document.querySelectorAll('.sheet, .sheet-scrim, .sel-toolbar, .lightbox').forEach((e) => e.remove());
  switch (route.name) {
    case 'read': current = readerView(route.ids); break;
    case 'book': current = bookView(route.id); break;
    case 'settings': current = settingsView(); break;
    case 'notes': current = notesView(); break;
    case 'catalog': current = lazyView(() => import('./views/catalog').then((m) => m.catalogView(route.url, route.q))); break;
    case 'sources': current = lazyView(() => import('./views/sources').then((m) => m.sourcesView(route.src, route.book, route.q, route.shelf, route.tags))); break;
    default: current = libraryView();
  }
  app.appendChild(current);
  window.scrollTo(0, 0);
}

registerNativePlugins();
applyDocumentLang();
applyChrome();
initPcShell();
setTimeout(() => void import('./ui/share').then((m) => m.clearShareCache()), 8000);
void loadFonts();
initNativeBridges();
void setVolumeKeys(getSettings().volumeKeys);
scheduleAutoCheck();
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
