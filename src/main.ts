import './styles/fonts.css';
import './styles/base.css';
import './styles/reader.css';
import { applyDocumentLang, onLangChange } from './i18n';
import { onRoute, parseRoute, type Route } from './router';
import { libraryView } from './views/library';
import { readerView } from './views/reader';
import { settingsView } from './views/settings';
import { applyChrome, onSettingsChange } from './settings';
import { loadFonts } from './fonts';
import { initNativeBridges, isNative } from './native';

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
    default: current = libraryView();
  }
  app.appendChild(current);
  window.scrollTo(0, 0);
}

applyDocumentLang();
applyChrome();
void loadFonts();
initNativeBridges();
onSettingsChange((s) => applyChrome(s));
onLangChange(() => { currentKey = ''; mount(parseRoute()); });
onRoute(mount);
mount(parseRoute());

// Offline support.
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !isNative()) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}

// Keep the install prompt for the Settings page.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__krInstallPrompt = e as unknown as { prompt(): Promise<void> };
});
