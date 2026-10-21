// App updates: checks the GitHub release feed, and installs in-app where the
// platform allows it — APK on Android (system installer), EXE on Windows
// (runs the installer), AltStore/SideStore hand-off on iOS, reload on the web.
import { h, icon, openSheet, toast, append } from './ui/dom';
import { t, getLang } from './i18n';
import { getSettings, updateSettings } from './settings';
import { nativePlatform } from './native';

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
const REPO = 'YoRu72/KurokawaReader';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 30 * 60 * 1000; // every launch, at most twice an hour

export interface ReleaseInfo { version: string; url: string; notes: string; assets: { name: string; url: string; size: number }[] }

function cmp(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number), pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

export async function fetchLatest(): Promise<ReleaseInfo> {
  const r = await fetch(API, { headers: { accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  const j = (await r.json()) as { tag_name: string; html_url: string; body?: string; assets: { name: string; browser_download_url: string; size: number }[] };
  localStorage.setItem('kr.update.lastCheck', String(Date.now()));
  return { version: j.tag_name.replace(/^v/, ''), url: j.html_url, notes: j.body ?? '', assets: j.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })) };
}

export function lastChecked(): number { return Number(localStorage.getItem('kr.update.lastCheck') ?? 0); }

/** Returns the release when it is newer than the running build. */
export async function checkForUpdate(ignoreSkipped = false): Promise<ReleaseInfo | null> {
  const rel = await fetchLatest();
  if (cmp(rel.version, APP_VERSION) <= 0) return null;
  if (!ignoreSkipped && localStorage.getItem('kr.update.skip') === rel.version) return null;
  return rel;
}

/** Start-up check (respects the setting, the interval and connectivity). */
export function scheduleAutoCheck(): void {
  if (!getSettings().autoUpdateCheck || !navigator.onLine) return;
  if (Date.now() - lastChecked() < CHECK_EVERY_MS) return;
  setTimeout(() => { checkForUpdate().then((rel) => { if (rel) offerUpdate(rel); }).catch(() => undefined); }, 4000);
}

function offerUpdate(rel: ReleaseInfo): void {
  const el = h('div', { class: 'toast update-toast', role: 'status' }, h('span', null, t('updateAvailableShort', { v: rel.version })),
    h('button', { type: 'button', class: 'btn small primary', onclick: () => { el.remove(); showUpdateSheet(rel); } }, icon('download'), t('updateNow')),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), onclick: () => el.remove() }, icon('close')));
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 30000);
}

/* ---------- platform installers ---------- */

interface AndroidPlugin { deviceInfo(): Promise<{ abis: string[] }>; installApk(o: { path: string }): Promise<void> }
interface FsPlugin { writeFile(o: { path: string; data: string; directory: string; recursive?: boolean }): Promise<{ uri: string }> }
function androidPlugins(): { kr: AndroidPlugin; fs: FsPlugin } | null {
  const cap = (window as unknown as { Capacitor?: { getPlatform?(): string; Plugins?: { Kurokawa?: AndroidPlugin; Filesystem?: FsPlugin } } }).Capacitor;
  if (cap?.getPlatform?.() !== 'android' || !cap.Plugins?.Kurokawa || !cap.Plugins.Filesystem) return null;
  return { kr: cap.Plugins.Kurokawa, fs: cap.Plugins.Filesystem };
}

async function downloadWithProgress(url: string, onProgress: (p: number) => void): Promise<Blob> {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(String(r.status));
  const total = Number(r.headers.get('content-length') ?? 0);
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; if (total) onProgress(Math.round((got / total) * 100)); }
  return new Blob(chunks as BlobPart[]);
}
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}

async function installAndroid(rel: ReleaseInfo, onProgress: (p: number) => void): Promise<void> {
  const p = androidPlugins();
  if (!p) throw new Error('native');
  const { abis } = await p.kr.deviceInfo().catch(() => ({ abis: [] as string[] }));
  const pick = abis.map((abi) => rel.assets.find((a) => a.name.endsWith(`-${abi}.apk`))).find(Boolean) ?? rel.assets.find((a) => a.name.endsWith('-universal.apk')) ?? rel.assets.find((a) => a.name.endsWith('.apk'));
  if (!pick) throw new Error('no apk');
  const blob = await downloadWithProgress(pick.url, onProgress);
  const { uri } = await p.fs.writeFile({ path: `kr-update/${pick.name}`, data: await blobToBase64(blob), directory: 'CACHE', recursive: true });
  await p.kr.installApk({ path: uri });
}

async function installDesktop(rel: ReleaseInfo, onProgress: (p: number) => void): Promise<void> {
  const d = window.kurokawaDesktop as (typeof window.kurokawaDesktop & { installUpdate?(url: string): Promise<void>; onUpdateProgress?(cb: (p: number) => void): void }) | undefined;
  if (!d?.installUpdate) throw new Error('desktop');
  const os = (d as { platform?: string }).platform ?? 'win32';
  const asset = os === 'darwin' ? rel.assets.find((a) => /\.dmg$/.test(a.name))
    : os === 'linux' ? rel.assets.find((a) => /\.AppImage$/.test(a.name))
    : rel.assets.find((a) => /win-x64\.exe$/.test(a.name) && !/portable/.test(a.name));
  if (!asset) throw new Error('no installer for this platform');
  d.onUpdateProgress?.(onProgress);
  await d.installUpdate(asset.url);
}

export function showUpdateSheet(rel: ReleaseInfo): void {
  const s = openSheet(t('updateAvailable', { v: rel.version }), t('close'));
  s.body.style.fontFamily = 'var(--font-ui)';
  s.body.style.fontSize = '14px';
  const notes = rel.notes.split('\n').filter((l) => l.trim() && !l.startsWith('|') && !l.startsWith('#')).slice(0, 12).join('\n');
  append(s.body, [h('p', { class: 'src' }, `${APP_VERSION} → ${rel.version}`), notes ? h('details', null, h('summary', null, t('whatsNew')), h('pre', { style: { whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: '13px', color: 'var(--md-on-surface-variant)' } }, notes)) : null]);
  const platform = nativePlatform();
  const status = h('p', { class: 'src', style: { marginTop: '10px' } });
  const bar = h('div', { class: 'progress-bar', hidden: true }, h('span'));
  const barFill = bar.firstElementChild as HTMLElement;
  s.body.append(status, bar);
  const link = h('a', { class: 'btn small outlined', href: rel.url, target: '_blank', rel: 'noopener' }, icon('external'), t('openReleasePage'));
  const run = (fn: (rel: ReleaseInfo, p: (n: number) => void) => Promise<void>) => async (ev: Event) => {
    const btn = ev.currentTarget as HTMLButtonElement; btn.disabled = true;
    bar.hidden = false; barFill.style.width = '0%';
    try { await fn(rel, (p) => { status.textContent = t('downloading', { p }); barFill.style.width = `${p}%`; }); barFill.style.width = '100%'; status.textContent = t('installStarted'); }
    catch (err) { bar.hidden = true; status.textContent = `${t('updateFailed')} — ${String((err as Error).message ?? err)}`; btn.disabled = false; }
  };
  if (platform === 'android') s.actions.append(h('button', { class: 'btn small primary', onclick: run(installAndroid) }, icon('download'), t('downloadInstall')), link);
  else if (platform === 'desktop') {
    const d = window.kurokawaDesktop as (typeof window.kurokawaDesktop & { isPortable?: () => Promise<boolean> }) | undefined;
    void d?.isPortable?.().then((portable) => { if (portable) s.body.append(h('p', { class: 'src' }, t('portableHint'))); });
    s.actions.append(h('button', { class: 'btn small primary', onclick: run(installDesktop) }, icon('download'), t('downloadInstall')), link);
  } else if (platform === 'ios') {
    const ipa = rel.assets.find((a) => a.name.endsWith('.ipa'));
    s.body.append(h('p', { class: 'src' }, t('iosUpdateHint')));
    if (ipa) s.actions.append(
      h('a', { class: 'btn small primary', href: `altstore://install?url=${encodeURIComponent(ipa.url)}` }, icon('download'), t('installWithAltStore')),
      h('a', { class: 'btn small tonal', href: `sidestore://install?url=${encodeURIComponent(ipa.url)}` }, icon('download'), t('installWithSideStore')));
    s.actions.append(link);
  } else {
    s.actions.append(h('button', { class: 'btn small primary', onclick: async () => { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); location.reload(); } }, icon('rotate'), t('reloadToUpdate')), link);
  }
  s.actions.append(h('button', { class: 'btn small', type: 'button', onclick: () => { localStorage.setItem('kr.update.skip', rel.version); s.close(); toast(t('versionSkipped', { v: rel.version })); } }, t('skipVersion')));
  void getLang;
}

/** Settings card body. */
export function renderUpdateCard(container: HTMLElement): void {
  const status = h('p', null, lastChecked() ? t('lastChecked', { d: new Date(lastChecked()).toLocaleString() }) : '');
  const cb = h('input', { type: 'checkbox', onchange: () => updateSettings({ autoUpdateCheck: cb.checked }) }) as HTMLInputElement;
  cb.checked = getSettings().autoUpdateCheck;
  const btn = h('button', { class: 'btn small tonal', onclick: async () => {
    btn.disabled = true; status.textContent = t('checking');
    try { const rel = await checkForUpdate(true); if (rel) { status.textContent = t('updateAvailable', { v: rel.version }); showUpdateSheet(rel); } else status.textContent = t('upToDate'); }
    catch { status.textContent = navigator.onLine ? t('updateFailed') : t('offlineService'); }
    btn.disabled = false;
  } }, icon('rotate'), t('checkUpdates'));
  container.append(h('p', null, `${t('version')} ${APP_VERSION}`), h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } }, btn, h('label', { class: 'row', style: { display: 'flex', gap: '10px', alignItems: 'center' } }, h('span', { class: 'switch' }, cb, h('i')), h('span', null, t('autoCheck')))), status);
}
