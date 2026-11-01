import './styles/fonts.css';
import './styles/base.css';
import './styles/tools.css';
import './styles/anime.css';
import { applyDocumentLang, onLangChange, loadLang, getLang, t } from './i18n';
import { onRoute, parseRoute, navigate, type Route } from './router';
import { h, icon } from './ui/dom';
import { goBack, wirePcBack } from './ui/backstack';
import { applyChrome, onSettingsChange, getSettings } from './settings';
import { registerNativePlugins, isNative, nativePlatform } from './native';
import { downloadsView } from './views/downloads';
import { scheduleAutoCheck } from './updates';

const app = document.getElementById('app')!;
window.addEventListener('error', (e) => { console.error(e.error ?? e.message); void import('./ui/dom').then((m) => m.toast(String(e.error?.message ?? e.message), 'error', 6000)); });
window.addEventListener('unhandledrejection', (e) => { const r = (e as PromiseRejectionEvent).reason; console.error(r); void import('./ui/dom').then((m) => m.toast(String(r?.message ?? r), 'error', 6000)); });
let current: (HTMLElement & { dispose?: () => void }) | null = null; let currentKey = '';

function lazyView(make: () => Promise<HTMLElement & { dispose?: () => void }>): HTMLElement & { dispose?: () => void } {
  const shell = h('div', { class: 'view' }, h('div', { class: 'center' }, h('div', { class: 'spinner' }))) as HTMLElement & { dispose?: () => void };
  let inner: (HTMLElement & { dispose?: () => void }) | null = null; let gone = false;
  shell.dispose = () => { gone = true; inner?.dispose?.(); };
  void make().then((el) => { if (gone) { el.dispose?.(); return; } inner = el; shell.replaceChildren(el); }).catch((e) => { console.error(e); shell.replaceChildren(h('p', { class: 'center' }, String((e as Error)?.message ?? e))); });
  return shell;
}

/* The navigation: a bar at the bottom on phones, a rail at the side on a PC (the reader's look). */
const DESTS = (): [string, string, string, () => void][] => [
  ['downloads', 'download', 'navDownloads', () => navigate('/')],
  ['search', 'search', 'navSearch', () => navigate('/search')],
  ...(getSettings().addons.includes('anime') ? [['anime', 'tv', 'navAnime', () => navigate('/anime')] as [string, string, string, () => void]] : []),
  ...(getSettings().addons.includes('subtitles') ? [['subs', 'subtitles', 'navSubs', () => navigate('/subs')] as [string, string, string, () => void]] : []),
  ['settings', 'settings', 'navSettings', () => navigate('/settings')],
];
const wide = matchMedia('(min-width: 1024px) and (pointer: fine)');
const isPc = () => (!!window.kurokawaTools && matchMedia('(min-width: 720px)').matches) || wide.matches;
let nav: HTMLElement | null = null;
function buildNav(): HTMLElement {
  const pc = isPc();
  const items = DESTS().map(([name, ic, key, go]) => h('button', { type: 'button', class: pc ? 'rail-item' : 'nav-item', 'data-dest': name, onclick: go, title: t(key as 'navDownloads') },
    h('span', { class: pc ? 'rail-pill' : 'nav-pill' }, icon(ic)), h('span', { class: pc ? 'rail-label' : 'nav-label' }, t(key as 'navDownloads'))));
  if (pc) return h('nav', { class: 'nav-rail', 'aria-label': t('appName') }, h('div', { class: 'rail-brand' }, h('img', { src: 'icons/icon.svg', alt: '' })),
    h('button', { type: 'button', class: 'rail-fab', title: t('addDownload'), 'aria-label': t('addDownload'), 'aria-haspopup': 'menu', onclick: (e: Event) => { const b = e.currentTarget as HTMLElement; void import('./views/fabMenu').then((m) => m.fabMenu(b)); } }, icon('plus')),
    h('div', { class: 'rail-items' }, ...items.slice(0, -1)), h('div', { class: 'rail-end' }, items[items.length - 1]));
  return h('nav', { class: 'bottom-nav', 'aria-label': t('appName') }, ...items);
}
function placeNav(): void {
  nav?.remove(); nav = buildNav(); nav.dataset.addons = getSettings().addons.filter((a) => a === 'anime' || a === 'subtitles').sort().join();
  document.documentElement.classList.toggle('pc', isPc());
  if (isPc()) document.body.prepend(nav); else document.body.append(nav);
  markNav(parseRoute());
}
function markNav(r: Route): void {
  const dest = r.name === 'downloads' || r.name === 'task' || r.name === 'add' ? 'downloads' : r.name === 'settings' || r.name === 'addons' ? 'settings' : r.name === 'anime' || r.name === 'animeEntry' ? 'anime' : r.name === 'subs' ? 'subs' : 'search';
  nav?.querySelectorAll<HTMLElement>('[data-dest]').forEach((b) => { const on = b.dataset.dest === dest; b.classList.toggle('active', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
}
wide.addEventListener('change', placeNav);

function mount(route: Route): void {
  try { mountInner(route); } catch (e) { console.error(e); currentKey = ''; current?.remove(); current = h('div', { class: 'view' }, h('div', { class: 'body' }, h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('alert')), h('h2', null, t('crashTitle')), h('p', null, t('crashBody')), h('pre', { class: 'crash-detail', dir: 'ltr' }, `${String((e as Error)?.message ?? e)}\n${String((e as Error)?.stack ?? '').slice(0, 1200)}`), h('button', { type: 'button', class: 'btn tonal', onclick: () => { currentKey = ''; mount(parseRoute()); } }, t('retry'))))) as HTMLElement & { dispose?: () => void }; app.appendChild(current); }
}
function mountInner(route: Route): void {
  const key = JSON.stringify(route);
  if (key === currentKey && current) return;
  currentKey = key;
  current?.dispose?.(); current?.remove();
  document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove());
  switch (route.name) {
    case 'task': current = lazyView(() => import('./views/task').then((m) => m.taskView(route.id))); break;
    case 'settings': current = lazyView(() => import('./views/settings').then((m) => m.settingsView(route.section))); break;
    case 'addons': current = lazyView(() => import('./views/settings').then((m) => m.settingsView('addons'))); break;
    case 'subs': current = lazyView(() => import('./views/subs').then((m) => m.subsView(route.q))); break;
    case 'anime': current = lazyView(() => import('./views/anime').then((m) => m.animeView(route.tab as 'search' | undefined, route.q))); break;
    case 'animeEntry': current = lazyView(() => import('./views/animeEntry').then((m) => m.animeEntryView(route.id))); break;
    case 'search': current = lazyView(() => import('./views/search').then((m) => m.searchView(route.q))); break;
    case 'add': {
      // An AniList or MyAnimeList page opened with the app goes to the show's page (Open in Seanime's idea);
      // anything else into the Add sheet.
      const u = route.u ?? ''; const al = /anilist\.co\/anime\/(\d+)/i.exec(u); const mal = /myanimelist\.net\/anime\/(\d+)/i.exec(u);
      if (al || mal) {
        current = downloadsView();
        // (An AniList / MyAnimeList show: its page in the Anime tab — the add-on offered first when it is missing.)
        void (async () => { if (!getSettings().addons.includes('anime')) { const { needAddon } = await import('./addons/need'); const { t } = await import('./i18n'); if (!(await needAddon('anime', t('addonWhyAnime')))) return; } let id = al ? Number(al[1]) : 0; if (!id && mal) { const { gql } = await import('./anilist'); const d = await gql<{ Media: { id: number } | null }>('query ($mal: Int) { Media(idMal: $mal, type: ANIME) { id } }', { mal: Number(mal[1]) }, false).catch(() => null); id = d?.Media?.id ?? 0; } if (id) navigate(`/anime/${id}`, true); else void import('./views/add').then((m) => m.addSheet(u)); })();
        break;
      }
      current = downloadsView(); setTimeout(() => void import('./views/add').then((m) => m.addSheet(u)), 50); break;
    }
    default: current = downloadsView(route.filter);
  }
  app.appendChild(current);
  window.scrollTo(0, 0);
  markNav(route);
}

await loadLang(getLang());
await window.kurokawaTools?.ready?.();
registerNativePlugins();
applyDocumentLang();
applyChrome();
placeNav();
wirePcBack();
onSettingsChange((s) => { applyChrome(s); const want = s.addons.filter((a) => a === 'anime' || a === 'subtitles').sort().join(); if ((nav?.dataset.addons ?? '') !== want) placeNav(); });
if (getSettings().addons.includes('anime')) void import('./anime/progress').then((m) => m.watchProgress());
if (getSettings().addons.includes('archives')) void import('./archives/auto').then((m) => m.watchArchives());
if (getSettings().addons.includes('debrid')) void import('./debrid/transfers');
setTimeout(() => void import('./addons').then((m) => m.autoUpdate()).catch(() => undefined), 8000);
// The privacy choices made once are applied at every start (DoH, screenshots blocked).
{ const s0 = getSettings(); const d = window.kurokawaTools as unknown as { setDoh?(o: { provider: string }): Promise<unknown> } | undefined; if (s0.doh !== 'off' && d?.setDoh) void d.setDoh({ provider: s0.doh }).catch(() => undefined); if (s0.secureScreen) void import('./native').then((n) => (n.ktPlugin() as unknown as { secureScreen?(o: { on: boolean }): Promise<void> } | null)?.secureScreen?.({ on: true })); }
void import('./downloads/prism').then((m) => { m.startScheduler(); m.startClipboardWatch((text) => void import('./views/add').then((a) => a.addSheet(text))); });
if (getSettings().addons.includes('anime')) void import('./anime/auto').then((m) => m.startAuto());
void import('./downloads/done').then((m) => m.startDoneWatch());
void import('./downloads/trash').then((m) => m.startTrash());
void import('./downloads/net').then((m) => m.applyNet());
void import('./ui/dropzone').then((m) => m.startDropAndKeys());
if (getSettings().addons.includes('video')) void import('./video/ytdlp').then((m) => m.autoUpdateVideo());
onLangChange(() => { currentKey = ''; placeNav(); mount(parseRoute()); });
onRoute(mount);
mount(parseRoute());
scheduleAutoCheck();
document.documentElement.dataset.platform = nativePlatform();

// Android's back: the native side asks the page (through the plugin's `backButton` event when present).
window.addEventListener('kt:back', () => { if (!goBack()) (window.Capacitor?.Plugins?.App as { exitApp?(): void } | undefined)?.exitApp?.(); });
// Links handed to the app (a magnet opened with it, a .torrent shared): straight into the add sheet.
window.addEventListener('kt:open', (e) => { const u = (e as CustomEvent<string>).detail; if (u) navigate(`/add?u=${encodeURIComponent(u)}`); });
if (location.hash.startsWith('#/open?')) { const u = new URLSearchParams(location.hash.split('?')[1]).get('u'); if (u) navigate(`/add?u=${encodeURIComponent(u)}`, true); }

if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !isNative()) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => undefined); });
} else if (isNative()) {
  void navigator.serviceWorker?.getRegistrations?.().then((regs) => regs.forEach((r) => void r.unregister())).catch(() => {});
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__ktInstallPrompt = e as unknown as { prompt(): Promise<void> }; });
