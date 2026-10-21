import './styles/fonts.css';
import './styles/base.css';
import './styles/reader.css';
import { applyDocumentLang, onLangChange } from './i18n';
import { onRoute, parseRoute, navigate, type Route } from './router';
import { libraryView } from './views/library';
import { readerView } from './views/reader';
import { settingsView } from './views/settings';
import { notesView } from './views/notes';
import { applyChrome, onSettingsChange, getSettings } from './settings';
import { loadFonts } from './fonts';
import { initNativeBridges, isNative, setVolumeKeys } from './native';
import { registerNativePlugins } from './capacitor';
import { scheduleAutoCheck } from './updates';

const app = document.getElementById('app')!;
let current: (HTMLElement & { dispose?: () => void }) | null = null;
let currentKey = '';

function mount(route: Route): void {
  const key = JSON.stringify(route);
  if (key === currentKey && current) return;
  currentKey = key;
  current?.dispose?.();
  current?.remove();
  document.querySelectorAll('.sheet, .sheet-scrim, .sel-toolbar, .lightbox').forEach((e) => e.remove());
  switch (route.name) {
    case 'read': current = readerView(route.ids); break;
    case 'settings': current = settingsView(); break;
    case 'notes': current = notesView(); break;
    default: current = libraryView();
  }
  app.appendChild(current);
  window.scrollTo(0, 0);
}

registerNativePlugins();
applyDocumentLang();
applyChrome();
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
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}

// Keep the install prompt for the Settings page.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__krInstallPrompt = e as unknown as { prompt(): Promise<void> };
});
