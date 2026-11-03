// Getting a Kurokawa app onto this device — an update of this one, or another of the apps — from its GitHub
// release: the file that fits (APK by ABI, EXE/DMG/AppImage by OS), fetched over several connections with its
// progress shown, tried again when the connection drops, checked against the SHA-256 GitHub states for it, kept
// when the installer is dismissed (so a second tap installs without fetching it again), then the system's
// installer opened (Android — asking for the right to install first, and carrying on once it is given), the
// installer run (Windows), or the release page opened where nothing can be installed from here.
import { nativePlatform, ktPlugin } from './native';
import { REPO } from './repo';
import { request } from './http';
import { listReleases, cmpVersion as cmpV, sha256Of, type Rel, type RelAsset, type FetchText } from './updateCore';

export type Release = Rel;
export interface Progress { pct: number; got: number; total: number; speed?: number; connections?: number; phase?: 'download' | 'verify' | 'install' | 'retry'; attempt?: number }
export const cmpVersion = cmpV;

/** GitHub's API straight (it allows the app's origin); the feed through the app's own HTTP (it does not). */
const fetchText: FetchText = async (url, accept) => {
  if (url.startsWith('https://api.github.com/')) { try { const r = await fetch(url, { headers: accept ? { accept } : undefined, cache: 'no-store' }); return { status: r.status, body: await r.text() }; } catch { /* through the app below */ } }
  const r = await request(url, { headers: accept ? { accept } : undefined }); return { status: r.status, body: r.body };
};
const appNameOf = (prefix: string) => (prefix === 'tools-v' ? 'KurokawaTools' : 'KurokawaReader');
/** Every release of an app (by its tag prefix: v for the reader, tools-v for this one), newest first. */
export function releasesOf(prefix: string, beta = false): Promise<Release[]> {
  return listReleases({ repo: REPO, prefix, appName: appNameOf(prefix), prereleases: beta || prefix === 'tools-v', fetchText });
}
/** The newest release whose tag starts with `prefix`. */
export async function latestRelease(prefix: string, beta = false): Promise<Release | null> { return (await releasesOf(prefix, beta))[0] ?? null; }

type Asset = RelAsset;
export async function suitableAsset(rel: Release): Promise<Asset | undefined> {
  const platform = nativePlatform();
  if (platform === 'android') {
    const p = ktPlugin() as (ReturnType<typeof ktPlugin> & { deviceInfo?(): Promise<{ abis: string[] }> }) | null;
    const abis = p?.deviceInfo ? (await p.deviceInfo().catch(() => ({ abis: [] as string[] }))).abis : [];
    return abis.map((abi) => rel.assets.find((a) => a.name.endsWith(`-${abi}.apk`))).find(Boolean) ?? rel.assets.find((a) => a.name.endsWith('-universal.apk')) ?? rel.assets.find((a) => a.name.endsWith('.apk'));
  }
  if (platform === 'ios') return rel.assets.find((a) => a.name.endsWith('.ipa'));
  if (platform === 'desktop') {
    const os = (window.kurokawaTools as { os?: string } | undefined)?.os ?? (navigator.platform.startsWith('Mac') ? 'darwin' : /Linux/.test(navigator.platform) ? 'linux' : 'win32');
    return os === 'darwin' ? rel.assets.find((a) => /\.dmg$/.test(a.name)) : os === 'linux' ? rel.assets.find((a) => /\.AppImage$/.test(a.name)) : rel.assets.find((a) => /win-x64\.exe$/.test(a.name));
  }
  return undefined;
}

type Dl = {
  downloadFile(o: { url: string; name: string; id?: string; connections?: number }): Promise<{ path: string; size: number }>; cancelDownload?(o: { id: string }): Promise<void>;
  installApk(o: { path: string }): Promise<void>; apkInstall?(o: { id: string; path: string; deleteAfter?: boolean }): Promise<void>; canInstall?(): Promise<{ granted: boolean }>; exists?(o: { paths: string[] }): Promise<{ exists: boolean[] }>;
  hashFile?(o: { path: string }): Promise<{ sha256: string; size: number }>; deletePath?(o: { path: string }): Promise<void>;
  addListener(ev: string, fn: (d: Progress & { id?: string }) => void): unknown;
};
const KEPT = 'kt.update.file';
type Kept = { name: string; path: string; size: number; sha256?: string };
const kept = (): Kept | null => { try { return JSON.parse(localStorage.getItem(KEPT) ?? 'null') as Kept | null; } catch { return null; } };
/** An update fetched before and not installed (its installer dismissed): its path, when it is still whole. */
export async function keptDownload(asset: Asset): Promise<string | null> {
  const k = kept(); if (!k || k.name !== asset.name) return null;
  const kr = ktPlugin() as unknown as Dl | null; if (!kr?.exists) return null;
  const ok = (await kr.exists({ paths: [k.path] }).catch(() => ({ exists: [false] }))).exists[0];
  if (ok && (!asset.size || k.size === asset.size)) return k.path;
  localStorage.removeItem(KEPT); return null;
}
/** The update being fetched: one at a time, whichever sheet asked for it (a sheet opened again joins it). */
let running: { name: string; done: Promise<string>; subs: Set<(p: Progress) => void>; last: Progress | null; cancel: () => void } | null = null;
export const downloadRunning = (name: string): boolean => running?.name === name;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export class InstallError extends Error { constructor(public code: 'damaged' | 'permission' | 'cancelled' | 'network', msg?: string) { super(msg ?? code); this.name = code === 'cancelled' ? 'AbortError' : 'InstallError'; } }

function download(kr: Dl, asset: Asset): NonNullable<typeof running> {
  if (running?.name === asset.name) return running;
  const subs = new Set<(p: Progress) => void>(); let stopped = false; let id = '';
  const run: NonNullable<typeof running> = { name: asset.name, subs, last: null, done: null as unknown as Promise<string>, cancel: () => { stopped = true; if (id) void kr.cancelDownload?.({ id }).catch(() => undefined); } };
  const tell = (p: Progress) => { run.last = p; subs.forEach((f) => f(p)); };
  run.done = (async () => {
    // Three tries (a dropped connection, a stalled mirror), a little longer apart each time.
    for (let attempt = 1; ; attempt++) {
      id = `install:${asset.name}:${attempt}`; let last = 0;
      const sub = await Promise.resolve(kr.addListener('downloadProgress', (d) => { if (d.id !== id) return; const total = d.total > 0 ? d.total : asset.size; const got = Math.max(d.got, last); last = got; tell({ got, total, speed: d.speed, connections: d.connections, pct: total ? Math.min(100, Math.floor((got / total) * 100)) : d.pct, phase: 'download', attempt }); })) as { remove?(): void } | undefined;
      try {
        const r = await kr.downloadFile({ url: asset.url, name: asset.name, id, connections: 16 });
        if (asset.size && r.size && r.size !== asset.size) throw new InstallError('damaged');
        // The file as GitHub states it, or it is not installed.
        const want = sha256Of(asset);
        if (want && kr.hashFile) { tell({ pct: 100, got: r.size, total: r.size, phase: 'verify' }); const hsh = await kr.hashFile({ path: r.path }); if (hsh.sha256.toLowerCase() !== want) { void kr.deletePath?.({ path: r.path }).catch(() => undefined); throw new InstallError('damaged'); } }
        localStorage.setItem(KEPT, JSON.stringify({ name: asset.name, path: r.path, size: r.size, sha256: want } satisfies Kept));
        return r.path;
      } catch (e) {
        if (stopped || /cancel/i.test(String((e as Error)?.message ?? e))) throw new InstallError('cancelled');
        if (attempt >= 3) throw e instanceof InstallError ? e : new InstallError('network', String((e as Error)?.message ?? e));
        tell({ pct: run.last?.pct ?? 0, got: run.last?.got ?? 0, total: asset.size, phase: 'retry', attempt: attempt + 1 }); await sleep(1500 * attempt);
        if (stopped) throw new InstallError('cancelled');
      } finally { sub?.remove?.(); }
    }
  })();
  running = run; void run.done.catch(() => undefined).finally(() => { if (running === run) running = null; });
  return run;
}
/** Waits until this app may install others (the person allowing it on the page the system opened). */
async function permitted(kr: Dl, timeoutMs = 180000): Promise<boolean> {
  const can = async () => (await kr.canInstall?.().catch(() => ({ granted: true })))?.granted ?? true;
  if (await can()) return true;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { await sleep(700); if (document.visibilityState === 'visible' && await can()) return true; }
  return false;
}

/** Fetches the asset and starts the install; `onProgress` as it comes. Android and Windows install here;
 *  elsewhere the file is handed to the system / the release page opened. `fetchOnly`: kept for later. */
/** Which installer an update goes through on Android (remembered): the app's own, or Android's. */
export function installVia(): 'app' | 'system' { try { return localStorage.getItem('kt.update.installer') === 'system' ? 'system' : 'app'; } catch { return 'app'; } }
export function setInstallVia(v: 'app' | 'system'): void { try { localStorage.setItem('kt.update.installer', v); } catch { /* storage blocked */ } }
export async function fetchAndInstall(asset: Asset, onProgress: (p: Progress) => void, signal?: AbortSignal, o: { fetchOnly?: boolean; onPermission?: () => void; via?: 'app' | 'system' } = {}): Promise<'installing' | 'opened' | 'fetched'> {
  const platform = nativePlatform();
  if (platform === 'android') {
    const kr = ktPlugin() as unknown as Dl | null; if (!kr) throw new Error('native');
    let path = await keptDownload(asset);
    if (path) onProgress({ pct: 100, got: asset.size, total: asset.size, phase: 'download' });
    else {
      const run = download(kr, asset); run.subs.add(onProgress); if (run.last) onProgress(run.last);
      const abort = () => run.cancel(); signal?.addEventListener('abort', abort, { once: true });
      try { path = await run.done; } finally { run.subs.delete(onProgress); signal?.removeEventListener('abort', abort); }
    }
    if (o.fetchOnly) return 'fetched';
    onProgress({ pct: 100, got: asset.size, total: asset.size, phase: 'install' });
    // (The app's own installer — Android's install session, its progress here, then Android's confirmation —, or
    // Android's package installer opened with the file: as chosen in the update sheet.)
    const via = o.via ?? installVia();
    const install = () => (via === 'app' && kr.apkInstall ? kr.apkInstall({ id: 'self-update', path: path!, deleteAfter: false }) : kr.installApk({ path: path! }));
    try { await install(); }
    catch (e) {
      if (!/permission/i.test(String((e as Error)?.message ?? e))) throw e;
      // The system's page to allow installing has been opened: once allowed, the install carries on by itself.
      o.onPermission?.();
      if (!(await permitted(kr))) throw new InstallError('permission');
      await install();
    }
    return 'installing';
  }
  if (platform === 'desktop' && window.kurokawaTools?.installUpdate) { await window.kurokawaTools.installUpdate(asset.url); return 'installing'; }
  const { openExternal } = await import('./native'); await openExternal(asset.url); return 'opened';
}
