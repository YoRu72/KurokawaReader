// Packs: the heavy native parts the app no longer carries — Python (yt-dlp) and ffmpeg (yt-dlp's merging, Convert,
// Make smaller, clips, chapters). They are fetched from this version's release the first time something needs them
// (an add-on installed, a file converted), checked against their SHA-256, and can be removed again in Settings.
// On Android both come from youtubedl-android's own bundles; on the desktop ffmpeg is the static build that used to
// sit inside the installer.
import { h, icon, openSheet, toast } from './ui/dom';
import { t, formatBytes, localDigits } from './i18n';
import { ktPlugin, listen } from './native';
import { REPO, APP_VERSION } from './repo';
import { request } from './http';

export type PackName = 'python' | 'ffmpeg' | 'mpv';
type Status = Record<PackName, { version: string | null; size: number }> & { abi?: string; platform?: string; arch?: string };
type Prog = { name: string; done: number; total: number };
type Plug = { packStatus(): Promise<Status>; packInstall(o: { name: string; url: string; sha256: string; version: string }): Promise<void>; packCancel(o: { name: string }): Promise<void>; packRemove(o: { name: string }): Promise<void>; addListener(ev: string, fn: (p: Prog) => void): unknown };
type Desk = { packStatus(): Promise<Status>; packInstall(o: { name: string; url: string; sha256: string; version: string }): Promise<void>; packCancel(name: string): Promise<void>; packRemove(name: string): Promise<void>; onPackProgress(fn: (p: Prog) => void): () => void };
const plug = (): Plug | null => { const p = ktPlugin() as unknown as Plug | null; return p?.packStatus ? p : null; };
const desk = (): Desk | null => { const d = window.kurokawaTools as unknown as Desk | undefined; return d?.packStatus ? d : null; };
/** Whether this build fetches packs at all (Android and the desktop do; the web has no native parts). */
export const packsHere = (): boolean => !!(plug() || desk());
/** The packs this platform has (the desktop has only ffmpeg: yt-dlp there is a single program). */
export const packNames = (): PackName[] => (desk() ? ['ffmpeg'] : plug() ? ['python', 'ffmpeg', 'mpv'] : []);

export async function status(): Promise<Status | null> { const d = desk(); if (d) return d.packStatus(); const p = plug(); return p ? p.packStatus() : null; }

type Entry = { file: string; size: number; sha256: string };
type Manifest = { ydl?: string; version?: string; versions?: Record<string, string>; packs: Record<string, Record<string, Entry>> };
/** A pack's version in this release's file (the mpv pack has its own; the others are youtubedl-android's). */
const versionOf = (m: Manifest, n: PackName): string | undefined => m.versions?.[n] ?? m.ydl ?? m.version;
let manifest: Promise<Manifest> | null = null;
const base = () => `https://github.com/${REPO}/releases/download/tools-v${APP_VERSION}/`;
/** What this release offers: its packs file (Android), or the desktop's ffmpeg with its checksum beside it. */
async function readManifest(): Promise<Manifest> {
  manifest ??= (async () => {
    const r = await request(base() + 'KurokawaTools-packs.json'); if (r.status !== 200) throw new Error(`packs: HTTP ${r.status}`);
    return JSON.parse(r.body) as Manifest;
  })();
  manifest.catch(() => { manifest = null; });
  return manifest;
}
async function entryFor(name: PackName, st: Status): Promise<{ url: string; size: number; sha256: string; version: string }> {
  const m = await readManifest();
  const key = st.abi ?? `${st.platform}-${st.arch}`;
  const e = m.packs[name]?.[key]; if (!e) throw new Error(t('packNoneForDevice', { what: key }));
  return { url: base() + e.file, size: e.size, sha256: e.sha256, version: versionOf(m, name) ?? APP_VERSION };
}
/** Packs that are missing (or older than this release's). */
async function missing(names: PackName[], st: Status): Promise<PackName[]> {
  const out: PackName[] = [];
  for (const n of names) { const v = st[n]?.version; if (!v) { out.push(n); continue; } try { const m = await readManifest(); const want = versionOf(m, n); if (want && v !== want) out.push(n); } catch { /* offline: the one here will do */ } }
  return out;
}
export const packLabel = (n: PackName): string => (n === 'python' ? t('packPython') : n === 'mpv' ? t('packMpv') : t('packFfmpeg'));

/** The packs among `names` that have to be fetched, with where from and how big (null: nothing to fetch). */
export async function packsToFetch(names: PackName[]): Promise<{ n: PackName; e: Awaited<ReturnType<typeof entryFor>> }[]> {
  const st = await status(); if (!st) return [];
  const need = await missing(names.filter((n) => packNames().includes(n)), st); if (!need.length) return [];
  // (The mpv pack is the player's better engine, not a must: a release or a phone without it plays with the web view.)
  const got = await Promise.all(need.map(async (n) => { try { return { n, e: await entryFor(n, st) }; } catch (err) { if (n === 'mpv') return null; throw err; } }));
  return got.filter((x): x is { n: PackName; e: Awaited<ReturnType<typeof entryFor>> } => !!x);
}
let runningPack: PackName | null = null;
export function cancelPack(): void { if (!runningPack) return; const d = desk(); if (d) void d.packCancel(runningPack); else void plug()?.packCancel({ name: runningPack }); }
/** Downloads the packs one after another; `progress(i, done, total)` for the i-th. */
export async function fetchPacks(list: { n: PackName; e: Awaited<ReturnType<typeof entryFor>> }[], progress: (i: number, done: number, total: number) => void): Promise<void> {
  const d = desk(); let i = 0;
  const onP = (p: Prog) => { const k = list.findIndex((x) => x.n === p.name); if (k >= 0) progress(k, p.done, p.total || list[k].e.size); };
  const off: { remove(): void } | (() => void) = d ? d.onPackProgress(onP) : await listen<Prog>(plug()! as never, 'packProgress', onP);
  try {
    for (const r of list) {
      runningPack = r.n; progress(i, 0, r.e.size);
      if (d) await d.packInstall({ name: r.n, url: r.e.url, sha256: r.e.sha256, version: r.e.version }); else await plug()!.packInstall({ name: r.n, url: r.e.url, sha256: r.e.sha256, version: r.e.version });
      progress(i, r.e.size, r.e.size); i++;
    }
  } finally { runningPack = null; if (typeof off === 'function') off(); else off.remove(); }
}
/** Makes sure the packs are here: the download card offers them (with their size) and shows them coming. */
export async function ensurePacks(names: PackName[], why: string, opts: { start?: boolean } = {}): Promise<boolean> {
  let list: Awaited<ReturnType<typeof packsToFetch>>;
  try { list = await packsToFetch(names); } catch (e) { toast(t('packUnavailable', { why: String((e as Error).message ?? e) }), 'error', 7000); return false; }
  if (!list.length) return true;
  const { getCard } = await import('./ui/getCard');
  return getCard({ icon: 'download', title: list.map((x) => packLabel(x.n)).join(' + '), why: `${why} ${t('packWhyShort')}`, steps: list.map((x) => ({ label: packLabel(x.n), size: x.e.size })), run: (p) => fetchPacks(list, p), cancel: cancelPack, start: opts.start });
}
export async function removePack(n: PackName): Promise<void> { const d = desk(); if (d) await d.packRemove(n); else await plug()?.packRemove({ name: n }); }

/** A native call that may answer «pack:ffmpeg» (or python): the pack fetched, then the call made again. */
export async function withPacks<T>(names: PackName[], why: string, fn: () => Promise<T>): Promise<T> {
  if (!(await ensurePacks(names, why))) throw new Error(t('cancelled'));
  try { return await fn(); }
  catch (e) { const m = /pack:(python|ffmpeg)/.exec(String((e as Error).message ?? e)); if (m && (await ensurePacks([m[1] as PackName], why))) return fn(); throw e; }
}

/** Settings → Storage: each pack, its size here, and Remove. */
export function packsCard(): HTMLElement | null {
  if (!packsHere()) return null;
  const list = h('div', { class: 'addons-list' });
  const draw = async () => {
    const st = await status().catch(() => null); if (!st) return;
    list.replaceChildren(...packNames().map((n) => {
      const v = st[n]?.version;
      return h('div', { class: 'addon-row' }, icon(n === 'python' ? 'puzzle' : 'film'), h('div', { class: 'grow' }, h('b', null, packLabel(n)), h('small', { class: 'src' }, v ? `${formatBytes(st[n].size)} · ${t('packHere')}` : t('packNotHere'))),
        v ? h('button', { type: 'button', class: 'btn text small', onclick: async () => { await removePack(n); toast(t('packRemoved', { what: packLabel(n), size: formatBytes(st[n].size) })); void draw(); } }, icon('trash'), t('remove'))
          : h('button', { type: 'button', class: 'btn tonal small', onclick: async () => { if (await ensurePacks([n], t('packManual'))) void draw(); } }, icon('download'), t('download')));
    }));
  };
  void draw();
  return h('div', { class: 'packs' }, h('p', { class: 'hint' }, t('packsHint')), list);
}
