// Native bridges: files handed to the app by the OS (Android "Open with",
// iOS share sheet, Electron file associations) are imported into the library
// and opened straight away. Everything here is optional at runtime — the plain
// web build simply has none of these globals.
import { importFiles } from './library';
import { navigate } from './router';
import { toast } from './ui/dom';
import { t } from './i18n';
import { getSettings } from './settings';
import { actionFor } from './shortcuts';

interface CapApp { addListener(ev: 'appUrlOpen' | 'backButton', fn: (d: { url: string; canGoBack?: boolean }) => void): Promise<unknown>; getLaunchUrl(): Promise<{ url?: string } | null>; minimizeApp?(): Promise<void> }
interface CapFs { readFile(o: { path: string }): Promise<{ data: string | Blob }> }
interface CapGlobal { isNativePlatform?(): boolean; getPlatform?(): string; Plugins?: { App?: CapApp; Filesystem?: CapFs } }
interface DesktopBridge { onOpenFile(cb: (p: { name: string; data: ArrayBuffer }) => void): void; platform: string }

declare global { interface Window { Capacitor?: CapGlobal; kurokawaDesktop?: DesktopBridge } }

export function isNative(): boolean { return !!window.Capacitor?.isNativePlatform?.() || !!window.kurokawaDesktop; }
export function nativePlatform(): string { return window.kurokawaDesktop ? 'desktop' : window.Capacitor?.getPlatform?.() ?? 'web'; }

function base64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr]);
}

const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

async function addFonts(files: File[]): Promise<void> {
  const { addFontFromFile } = await import('./fonts');
  let n = 0;
  for (const f of files) { try { await addFontFromFile(f); n++; } catch (err) { toast(t('importFailed', { name: f.name, error: String((err as Error)?.message ?? err) }), 'error', 4000); } }
  if (n) { toast(t('fontsAdded', { n })); navigate('/settings'); }
}

async function fontsInZip(file: File): Promise<File[]> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(file);
  const out: File[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !FONT_EXT.test(entry.name) || /__MACOSX/.test(entry.name)) continue;
    out.push(new File([await entry.async('blob')], entry.name.split('/').pop()!));
  }
  return out;
}

async function importBooks(files: File[]): Promise<void> {
  const added = await importFiles(files, (book, f, err) => { if (!book) toast(t('importFailed', { name: f.name, error: String((err as Error)?.message ?? err) }), 'error', 5000); });
  if (added.length) navigate(`/read/${added.map((b) => b.id).join(',')}`);
}

/** A file handed to the app by the OS. Fonts are added as fonts; a ZIP asks whether it is fonts or a comic. */
export async function openIncoming(file: File): Promise<void> {
  if (FONT_EXT.test(file.name)) { await addFonts([file]); return; }
  // A KurokawaReader backup (JSON, or a ZIP carrying kurokawa-backup.json) restores wherever it was made.
  if (/\.json$/i.test(file.name)) {
    const head = await file.slice(0, 200).text();
    if (head.includes('KurokawaReader')) { await restoreFromFile(file); return; }
  }
  if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
    try { const JSZip = (await import('jszip')).default; const z = await JSZip.loadAsync(file); if (z.file('kurokawa-backup.json')) { await restoreFromFile(file); return; } } catch { /* not a backup */ }
  }
  if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
    const fonts = await fontsInZip(file).catch(() => [] as File[]);
    if (!fonts.length) { await importBooks([new File([file], file.name.replace(/\.zip$/i, '.cbz'))]); return; }
    const { openSheet, h: hh, icon } = await import('./ui/dom');
    const sh = openSheet(t('openAs'), t('close'));
    sh.body.style.fontFamily = 'var(--font-ui)';
    sh.body.append(hh('ul', { class: 'plain-list' },
      hh('li', null, hh('button', { type: 'button', onclick: () => { sh.close(); void addFonts(fonts); } }, icon('type'), `${t('openAsFontsZip')} (${fonts.length})`)),
      hh('li', null, hh('button', { type: 'button', onclick: () => { sh.close(); void importBooks([new File([file], file.name.replace(/\.zip$/i, '.cbz'))]); } }, icon('books'), t('openAsBook')))));
    return;
  }
  await importBooks([file]);
}

async function handleUrl(url: string): Promise<void> {
  if (/^kurokawareader:/i.test(url)) { void import('./sync').then((m) => m.handleOAuthRedirect(url)).catch((e) => toast(String((e as Error).message ?? e), 'error')); return; }
  if (!/^(content|file):/i.test(url)) return;
  const plugins = window.Capacitor?.Plugins as { Filesystem?: { readFile(o: { path: string }): Promise<{ data: string | Blob }> }; Kurokawa?: { readDocument?(o: { uri: string }): Promise<{ data: string; name?: string }> } } | undefined;
  const fs = plugins?.Filesystem;
  try {
    let blob: Blob; let name = '';
    if (plugins?.Kurokawa?.readDocument) { const r = await plugins.Kurokawa.readDocument({ uri: url }); blob = base64ToBlob(r.data); name = r.name ?? ''; }
    else if (fs) { const res = await fs.readFile({ path: url }); blob = typeof res.data === 'string' ? base64ToBlob(res.data) : res.data; }
    else return;
    if (!name) name = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '');
    if (!name || !/\.[a-z0-9]{2,5}$/i.test(name)) name = (name || 'document') + '.bin';
    await openIncoming(new File([blob], name));
  } catch (err) {
    toast(t('openError', { error: String((err as Error)?.message ?? err) }), 'error', 5000);
  }
}

export function initNativeBridges(): void {
  // Keyboard shortcuts (rebindable in Settings); the desktop menu sends the same commands.
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).matches?.('input, textarea, select, [contenteditable]')) return;
    const cmd = actionFor(e);
    if (!cmd) return;
    e.preventDefault();
    if (cmd === 'library') navigate('/'); else if (cmd === 'settings') navigate('/settings'); else if (cmd === 'notes') navigate('/notes');
    else document.dispatchEvent(new CustomEvent('kr:command', { detail: cmd }));
  });
  const cap = window.Capacitor;
  if (cap?.isNativePlatform?.() && cap.Plugins?.App) {
    void cap.Plugins.App.addListener('appUrlOpen', (d) => void handleUrl(d.url));
    void cap.Plugins.App.getLaunchUrl().then((d) => { if (d?.url) void handleUrl(d.url); }).catch(() => undefined);
    // Android back: close whatever is open first (sheet, side panel, lightbox), then go back a view, then minimise.
    void cap.Plugins.App.addListener('backButton', () => {
      const sheets = document.querySelectorAll('.sheet .sheet-head button');
      if (sheets.length) { (sheets[sheets.length - 1] as HTMLButtonElement).click(); return; }
      const panelClose = document.querySelector('.panel.open .panel-head button') as HTMLButtonElement | null;
      if (panelClose) { panelClose.click(); return; }
      // Full-screen overlays (gallery, pages grid, lightbox) carry a dialog role and a back/close button in their top bar.
      const overlays = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => !d.classList.contains('panel') && (d as HTMLElement).offsetParent !== null);
      const overlayBtn = overlays.length ? (overlays[overlays.length - 1].querySelector('.lb-close, .topbar button, button[aria-label]') as HTMLButtonElement | null) : null;
      if (overlayBtn) { overlayBtn.click(); return; }
      if (location.hash && location.hash !== '#/' && location.hash !== '#') { navigate('/'); return; }
      void cap.Plugins?.App?.minimizeApp?.();
    });
  }
  if (window.kurokawaDesktop) {
    window.kurokawaDesktop.onOpenFile((p) => void openIncoming(new File([p.data], p.name)));
    (window.kurokawaDesktop as DesktopBridge & { onOpenUrl?(cb: (u: string) => void): void }).onOpenUrl?.((u) => void handleUrl(u));
    // Menu / keyboard commands from the shell: views listen for `kr:command`; a few are global.
    (window.kurokawaDesktop as DesktopBridge & { onCommand?(cb: (c: string) => void): void }).onCommand?.((c) => {
      if (c === 'library') navigate('/');
      else if (c === 'settings') navigate('/settings');
      else if (c === 'update') void import('./updates').then((u) => u.checkForUpdate().then((rel) => { if (rel) u.showUpdateSheet(rel); else toast(t('upToDate')); }).catch(() => toast(t('updateFailed'), 'error')));
      else document.dispatchEvent(new CustomEvent('kr:command', { detail: c }));
    });
  }
}

interface ImmersivePlugin { setImmersive(o: { on: boolean }): Promise<void> }
interface StatusBarPlugin { hide(): Promise<void>; show(): Promise<void> }
/** Hide / show the system bars while reading (Android via our plugin, iOS via StatusBar). */
interface BrightnessPlugin { setBrightness(o: { value: number }): Promise<void>; getBrightness(): Promise<{ value: number }> }
function brightnessPlugin(): BrightnessPlugin | null {
  const k = (window.Capacitor as (CapGlobal & { Plugins?: { Kurokawa?: Partial<BrightnessPlugin> } }) | undefined)?.Plugins?.Kurokawa;
  return k?.setBrightness && k.getBrightness ? (k as BrightnessPlugin) : null;
}
export function canDeviceBrightness(): boolean { return !!brightnessPlugin(); }
/** Screen brightness 0–1 (phones and tablets); -1 hands control back to the system. */
export async function setDeviceBrightness(value: number): Promise<void> { try { await brightnessPlugin()?.setBrightness({ value }); } catch { /* ignore */ } }
export async function getDeviceBrightness(): Promise<number> { try { return (await brightnessPlugin()?.getBrightness())?.value ?? 0.5; } catch { return 0.5; } }

export async function setImmersive(on: boolean): Promise<void> {
  const desk = window.kurokawaDesktop as (DesktopBridge & { setImmersive?(on: boolean): Promise<boolean> }) | undefined;
  if (desk?.setImmersive) { try { await desk.setImmersive(on); } catch { /* ignore */ } return; }
  const plugins = (window.Capacitor as (CapGlobal & { Plugins?: { Kurokawa?: ImmersivePlugin; StatusBar?: StatusBarPlugin } }) | undefined)?.Plugins;
  try {
    if (nativePlatform() === 'android' && plugins?.Kurokawa?.setImmersive) { await plugins.Kurokawa.setImmersive({ on }); return; }
    if (plugins?.StatusBar) { if (on) await plugins.StatusBar.hide(); else await plugins.StatusBar.show(); }
  } catch { /* ignore */ }
}

// Screen wake lock while reading (Web API; works in Android WebView, desktop Chromium, Safari 16.4+).
let wakeLock: { release(): Promise<void>; addEventListener?: (t: string, f: () => void) => void } | null = null;
let wakeWanted = false;
async function acquireWake(): Promise<void> {
  if (!wakeWanted || wakeLock || document.visibilityState !== 'visible') return;
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void>; addEventListener?: (t: string, f: () => void) => void }> } };
    wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
    wakeLock?.addEventListener?.('release', () => { wakeLock = null; });
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void acquireWake(); });
export function keepAwake(on: boolean): void {
  wakeWanted = on;
  if (on) void acquireWake();
  else if (wakeLock) { void wakeLock.release().catch(() => undefined); wakeLock = null; }
}

/** Tell the Android shell whether volume keys should turn pages (they then stop changing the volume). */
export async function setVolumeKeys(on: boolean): Promise<void> {
  const kr = (window.Capacitor as (CapGlobal & { Plugins?: { Kurokawa?: { setVolumeKeys?(o: { on: boolean }): Promise<void> } } }) | undefined)?.Plugins?.Kurokawa;
  try { await kr?.setVolumeKeys?.({ on }); } catch { /* ignore */ }
}

/** Full screen: the window itself on the desktop app (so it also leaves the immersive fullscreen), the document elsewhere. */
export async function toggleFullscreen(view?: HTMLElement): Promise<void> {
  const desk = window.kurokawaDesktop as (DesktopBridge & { setFullscreen?(v: 'toggle' | boolean): Promise<boolean> }) | undefined;
  if (desk?.setFullscreen) { try { await desk.setFullscreen('toggle'); } catch { /* ignore */ } return; }
  // Phones and tablets (and browsers without the Fullscreen API): full screen means the
  // reader's immersive mode — chrome and system bars hidden — toggled from the view.
  const native = nativePlatform() === 'android' || nativePlatform() === 'ios';
  if (view && (native || !document.documentElement.requestFullscreen)) {
    const on = view.classList.toggle('immersive');
    await setImmersive(on || getSettings().hideSystemBars);
    return;
  }
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen?.(); }
  catch { if (view) view.classList.toggle('immersive'); }
}

/** Escape: leave window/HTML fullscreen or the reader's immersive mode, whichever is on. */
export async function leaveFullscreen(view?: HTMLElement): Promise<void> {
  const desk = window.kurokawaDesktop as (DesktopBridge & { setFullscreen?(v: 'toggle' | boolean): Promise<boolean> }) | undefined;
  if (desk?.setFullscreen) { try { await desk.setFullscreen(false); } catch { /* ignore */ } }
  else if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* ignore */ } }
  if (view?.classList.contains('immersive')) { view.classList.remove('immersive'); if (!getSettings().hideSystemBars) void setImmersive(false); }
}

async function restoreFromFile(file: File): Promise<void> {
  const { openSheet, h: hh, icon } = await import('./ui/dom');
  const sh = openSheet(t('restore'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const status = hh('p', { class: 'src' }, file.name);
  sh.body.append(hh('p', null, t('restoreConfirm')), status);
  sh.actions.append(hh('button', { class: 'btn small primary', type: 'button', onclick: async (e: Event) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    try { const { restoreBackup } = await import('./backup'); const n = await restoreBackup(file, (m) => { status.textContent = m; }); sh.close(); toast(t('restored', { n })); navigate('/'); }
    catch (err) { status.textContent = `${t('restoreFailed')} — ${String((err as Error).message ?? err)}`; }
  } }, icon('import'), t('restore')));
}
