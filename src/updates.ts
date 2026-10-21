// App updates: checks the GitHub release feed, and installs in-app where the
// platform allows it — APK on Android (system installer), EXE on Windows
// (runs the installer), AltStore/SideStore hand-off on iOS, reload on the web.
import { h, icon, openSheet, toast, pickSheet } from './ui/dom';
import { t, getLang } from './i18n';
import { getSettings, updateSettings } from './settings';
import { nativePlatform } from './native';

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
const REPO = 'YoRu72/KurokawaReader';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 30 * 60 * 1000; // every launch, at most twice an hour

export interface ReleaseInfo { version: string; url: string; notes: string; publishedAt?: string; assets: { name: string; url: string; size: number }[] }
export interface Progress { pct: number; got: number; total: number; speed: number }

function cmp(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number), pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

export async function fetchLatest(): Promise<ReleaseInfo> {
  const r = await fetch(API, { headers: { accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  const j = (await r.json()) as { tag_name: string; html_url: string; body?: string; published_at?: string; assets: { name: string; browser_download_url: string; size: number }[] };
  localStorage.setItem('kr.update.lastCheck', String(Date.now()));
  return { version: j.tag_name.replace(/^v/, ''), url: j.html_url, notes: j.body ?? '', publishedAt: j.published_at, assets: j.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })) };
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
  setTimeout(() => { checkForUpdate().then((rel) => { if (rel) showUpdateSheet(rel); }).catch(() => undefined); }, 3000);
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

async function downloadWithProgress(url: string, onProgress: (p: Progress) => void, size = 0, signal?: AbortSignal): Promise<Blob> {
  const r = await fetch(url, { signal });
  if (!r.ok || !r.body) throw new Error(String(r.status));
  const total = Number(r.headers.get('content-length') ?? 0) || size;
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = []; let got = 0;
  const t0 = performance.now(); let lastT = t0, lastGot = 0, speed = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks.push(value); got += value.length;
    const now = performance.now();
    if (now - lastT > 400) { speed = (got - lastGot) / ((now - lastT) / 1000); lastT = now; lastGot = got; }
    onProgress({ pct: total ? Math.round((got / total) * 100) : 0, got, total, speed });
  }
  return new Blob(chunks as BlobPart[]);
}
export function fmtMB(n: number): string { return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`; }
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}

type Asset = ReleaseInfo['assets'][number];

/** The file that fits this device: APK by ABI, EXE / DMG / AppImage by OS, IPA on iOS. */
export async function suitableAsset(rel: ReleaseInfo): Promise<Asset | undefined> {
  const platform = nativePlatform();
  if (platform === 'android') {
    const p = androidPlugins();
    const { abis } = p ? await p.kr.deviceInfo().catch(() => ({ abis: [] as string[] })) : { abis: [] as string[] };
    return abis.map((abi) => rel.assets.find((a) => a.name.endsWith(`-${abi}.apk`))).find(Boolean) ?? rel.assets.find((a) => a.name.endsWith('-universal.apk')) ?? rel.assets.find((a) => a.name.endsWith('.apk'));
  }
  if (platform === 'ios') return rel.assets.find((a) => a.name.endsWith('.ipa'));
  if (platform === 'desktop') {
    const os = (window.kurokawaDesktop as { platform?: string } | undefined)?.platform ?? 'win32';
    const portable = !!(await (window.kurokawaDesktop as { isPortable?: () => Promise<boolean> } | undefined)?.isPortable?.().catch(() => false));
    return os === 'darwin' ? rel.assets.find((a) => /\.dmg$/.test(a.name))
      : os === 'linux' ? rel.assets.find((a) => /\.AppImage$/.test(a.name))
      : rel.assets.find((a) => /win-x64.*\.exe$/.test(a.name) && /portable/.test(a.name) === portable);
  }
  return rel.assets.find((a) => a.name.endsWith('web.zip'));
}

/** Download `asset` and hand it to the platform installer (or save/share it when there is none). */
async function installAsset(asset: Asset, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<void> {
  const platform = nativePlatform();
  if (platform === 'android') {
    const p = androidPlugins(); if (!p) throw new Error('native');
    // Native download: GitHub's asset redirects carry no CORS headers, so the WebView cannot fetch them.
    const kr = p.kr as AndroidPlugin & { downloadFile?(o: { url: string; name: string }): Promise<{ path: string; size: number }>; addListener?(ev: string, fn: (d: Progress) => void): Promise<{ remove(): void }> };
    let sub: { remove(): void } | undefined;
    try {
      sub = await kr.addListener?.('downloadProgress', (d) => onProgress({ pct: d.pct, got: d.got, total: d.total || asset.size, speed: d.speed }));
      let path: string;
      if (kr.downloadFile) ({ path } = await kr.downloadFile({ url: asset.url, name: asset.name }));
      else { const blob = await downloadWithProgress(asset.url, onProgress, asset.size, signal); ({ uri: path } = await p.fs.writeFile({ path: `kr-update/${asset.name}`, data: await blobToBase64(blob), directory: 'CACHE', recursive: true })); }
      if (/\.apk$/i.test(asset.name)) await p.kr.installApk({ path });
      else toast(t('savedTo', { f: asset.name }));
    } finally { sub?.remove(); }
    return;
  }
  if (platform === 'desktop' && /\.(exe|dmg|AppImage)$/i.test(asset.name)) {
    const d = window.kurokawaDesktop as (typeof window.kurokawaDesktop & { installUpdate?(url: string): Promise<void>; onUpdateProgress?(cb: (p: number | Progress) => void): void }) | undefined;
    if (!d?.installUpdate) throw new Error('desktop');
    d.onUpdateProgress?.((p) => onProgress(typeof p === 'number' ? { pct: p, got: 0, total: asset.size, speed: 0 } : p));
    await d.installUpdate(asset.url);
    return;
  }
  // Anything else: download in-app and hand the file over (share sheet / Downloads); when the
  // browser blocks the cross-origin download, open it in a tab instead.
  try {
    const blob = await downloadWithProgress(asset.url, onProgress, asset.size, signal);
    const { shareFile } = await import('./ui/share');
    await shareFile(blob, asset.name, asset.name);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    window.open(asset.url, '_blank', 'noopener');
  }
}

export function showUpdateSheet(rel: ReleaseInfo): void {
  const s = openSheet(t('updateAvailable', { v: rel.version }), t('close'));
  s.body.style.fontFamily = 'var(--font-ui)';
  s.el.classList.add('update-sheet');
  const platform = nativePlatform();
  // Header: version chips, date
  const date = rel.publishedAt ? new Date(rel.publishedAt).toLocaleDateString(getLang() === 'ar' ? 'ar-SA-u-nu-arab-ca-gregory' : 'en-GB', { dateStyle: 'medium' }) : '';
  s.body.append(h('div', { class: 'upd-head' },
    h('span', { class: 'upd-chip' }, APP_VERSION), icon('arrowRight'), h('span', { class: 'upd-chip new' }, rel.version),
    date ? h('span', { class: 'upd-date' }, date) : null));
  // What's new: bullet lines from the release notes (the install table is left out)
  const section = /## What's new\s*([\s\S]*?)(?:\n## |$)/.exec(rel.notes)?.[1] ?? '';
  const lines = section.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-') || l.startsWith('*')).slice(0, 20);
  if (lines.length) s.body.append(h('h4', { class: 'upd-title' }, t('whatsNew')), h('ul', { class: 'upd-notes' }, ...lines.map((l) => h('li', { dir: 'auto' }, l.replace(/^[-*•]\s*/, '').replace(/\*\*/g, '')))));
  // Download block
  const fileLine = h('p', { class: 'upd-file' });
  const status = h('p', { class: 'src upd-status' });
  const bar = h('div', { class: 'progress-bar', hidden: true }, h('span'));
  const barFill = bar.firstElementChild as HTMLElement;
  s.body.append(fileLine, bar, status);
  let asset: Asset | undefined;
  let ctl: AbortController | null = null;
  const describe = () => { fileLine.replaceChildren(icon('download'), h('span', null, asset ? `${asset.name} · ${fmtMB(asset.size)}` : t('noFileForPlatform'))); };
  void suitableAsset(rel).then((a) => { asset = a; describe(); install.disabled = !a && platform !== 'web'; });

  const onProgress = (p: Progress) => {
    bar.hidden = false; barFill.style.width = `${p.pct}%`;
    const parts = [`${p.pct}%`];
    if (p.total) parts.push(`${fmtMB(p.got)} / ${fmtMB(p.total)}`);
    if (p.speed) parts.push(`${fmtMB(p.speed)}/s`);
    status.textContent = parts.join(' · ');
  };
  const install = h('button', { class: 'btn small primary', type: 'button', onclick: async () => {
    if (platform === 'web') { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); location.reload(); return; }
    if (!asset) return;
    if (platform === 'ios') { location.href = `altstore://install?url=${encodeURIComponent(asset.url)}`; return; }
    install.disabled = true; cancel.hidden = false; ctl = new AbortController();
    try { await installAsset(asset, onProgress, ctl.signal); status.textContent = t('installStarted'); barFill.style.width = '100%'; }
    catch (err) { bar.hidden = true; status.textContent = (err as Error).name === 'AbortError' ? t('cancelled') : `${t('updateFailed')} — ${String((err as Error).message ?? err)}`; install.disabled = false; }
    finally { cancel.hidden = true; ctl = null; }
  } }, icon('download'), platform === 'web' ? t('reloadToUpdate') : platform === 'ios' ? t('installWithAltStore') : t('downloadInstall')) as HTMLButtonElement;
  const cancel = h('button', { class: 'btn small', type: 'button', hidden: true, onclick: () => ctl?.abort() }, t('cancel'));
  const choose = h('button', { class: 'btn small', type: 'button', onclick: () => {
    pickSheet(t('chooseFile'), rel.assets.map((a): [string, string, string] => [a.name, `${a.name} · ${fmtMB(a.size)}`, 'download']), asset?.name ?? '', (name) => { asset = rel.assets.find((a) => a.name === name); describe(); install.disabled = !asset; }, t('close'));
  } }, icon('folder'), t('chooseFile'));
  const link = h('a', { class: 'btn small outlined', href: rel.url, target: '_blank', rel: 'noopener' }, icon('external'), t('openReleasePage'));
  if (platform === 'ios' ) s.body.append(h('p', { class: 'src' }, t('iosUpdateHint')));
  s.actions.append(install, cancel, choose, link,
    h('button', { class: 'btn small', type: 'button', onclick: () => { localStorage.setItem('kr.update.skip', rel.version); s.close(); toast(t('versionSkipped', { v: rel.version })); } }, t('skipVersion')));
  if (platform === 'ios' && asset === undefined) void suitableAsset(rel).then((a) => { if (a) s.actions.insertBefore(h('a', { class: 'btn small tonal', href: `sidestore://install?url=${encodeURIComponent(a.url)}` }, icon('download'), t('installWithSideStore')), cancel); });
}

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
