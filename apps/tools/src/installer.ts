// Getting a Kurokawa app onto this device — an update of this one, or another of the apps — from its GitHub
// release: the file that fits (APK by ABI, EXE/DMG/AppImage by OS), fetched over several connections with
// its progress shown, then the system's installer opened (Android), the installer run (Windows), or the
// release page opened where nothing can be installed from here.
import { nativePlatform, ktPlugin } from './native';
import { REPO } from './repo';

export interface Release { tag: string; version: string; url: string; notes: string; publishedAt?: string; prerelease: boolean; assets: { name: string; url: string; size: number }[] }
export interface Progress { pct: number; got: number; total: number; speed?: number; connections?: number }
type Raw = { tag_name: string; html_url: string; body?: string; published_at?: string; prerelease?: boolean; draft?: boolean; assets: { name: string; browser_download_url: string; size: number }[] };

export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}
/** The newest release whose tag starts with `prefix` (v for the reader, tools-v for this app). */
export async function latestRelease(prefix: string, beta = false): Promise<Release | null> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: { accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  const all = ((await r.json()) as Raw[]).filter((x) => !x.draft && x.tag_name.startsWith(prefix) && /^\d/.test(x.tag_name.slice(prefix.length)) && (beta || !x.prerelease || prefix === 'tools-v'));
  all.sort((a, b) => cmpVersion(b.tag_name.slice(prefix.length), a.tag_name.slice(prefix.length)));
  const j = all[0]; if (!j) return null;
  return { tag: j.tag_name, version: j.tag_name.slice(prefix.length), url: j.html_url, notes: j.body ?? '', publishedAt: j.published_at, prerelease: !!j.prerelease, assets: j.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })) };
}

type Asset = Release['assets'][number];
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

type Dl = { downloadFile(o: { url: string; name: string; id?: string; connections?: number }): Promise<{ path: string; size: number }>; cancelDownload?(o: { id: string }): Promise<void>; installApk(o: { path: string }): Promise<void>; addListener(ev: string, fn: (d: Progress & { id?: string }) => void): Promise<{ remove(): void }> };
/** Fetches the asset and starts the install; `onProgress` as it comes. Android and Windows install here;
 *  elsewhere the file is handed to the system / the release page opened. */
export async function fetchAndInstall(asset: Asset, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<'installing' | 'opened'> {
  const platform = nativePlatform();
  if (platform === 'android') {
    const kr = ktPlugin() as unknown as Dl | null; if (!kr) throw new Error('native');
    const id = `install:${asset.name}`; let last = 0;
    const sub = await kr.addListener('downloadProgress', (d) => { if (d.id !== id) return; const total = d.total > 0 ? d.total : asset.size; const got = Math.max(d.got, last); last = got; onProgress({ got, total, speed: d.speed, connections: d.connections, pct: total ? Math.min(100, Math.floor((got / total) * 100)) : d.pct }); });
    signal?.addEventListener('abort', () => void kr.cancelDownload?.({ id }));
    try { const { path } = await kr.downloadFile({ url: asset.url, name: asset.name, id, connections: 8 }); await kr.installApk({ path }); return 'installing'; }
    finally { sub.remove(); }
  }
  if (platform === 'desktop' && window.kurokawaTools?.installUpdate) { await window.kurokawaTools.installUpdate(asset.url); return 'installing'; }
  const { openExternal } = await import('./native'); await openExternal(asset.url); return 'opened';
}
