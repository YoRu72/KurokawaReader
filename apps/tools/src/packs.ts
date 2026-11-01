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

export type PackName = 'python' | 'ffmpeg';
type Status = Record<PackName, { version: string | null; size: number }> & { abi?: string; platform?: string; arch?: string };
type Prog = { name: string; done: number; total: number };
type Plug = { packStatus(): Promise<Status>; packInstall(o: { name: string; url: string; sha256: string; version: string }): Promise<void>; packCancel(o: { name: string }): Promise<void>; packRemove(o: { name: string }): Promise<void>; addListener(ev: string, fn: (p: Prog) => void): unknown };
type Desk = { packStatus(): Promise<Status>; packInstall(o: { name: string; url: string; sha256: string; version: string }): Promise<void>; packCancel(name: string): Promise<void>; packRemove(name: string): Promise<void>; onPackProgress(fn: (p: Prog) => void): () => void };
const plug = (): Plug | null => { const p = ktPlugin() as unknown as Plug | null; return p?.packStatus ? p : null; };
const desk = (): Desk | null => { const d = window.kurokawaTools as unknown as Desk | undefined; return d?.packStatus ? d : null; };
/** Whether this build fetches packs at all (Android and the desktop do; the web has no native parts). */
export const packsHere = (): boolean => !!(plug() || desk());
/** The packs this platform has (the desktop has only ffmpeg: yt-dlp there is a single program). */
export const packNames = (): PackName[] => (desk() ? ['ffmpeg'] : plug() ? ['python', 'ffmpeg'] : []);

export async function status(): Promise<Status | null> { const d = desk(); if (d) return d.packStatus(); const p = plug(); return p ? p.packStatus() : null; }

type Entry = { file: string; size: number; sha256: string };
type Manifest = { ydl?: string; version?: string; packs: Record<string, Record<string, Entry>> };
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
  return { url: base() + e.file, size: e.size, sha256: e.sha256, version: m.ydl ?? m.version ?? APP_VERSION };
}
/** Packs that are missing (or older than this release's). */
async function missing(names: PackName[], st: Status): Promise<PackName[]> {
  const out: PackName[] = [];
  for (const n of names) { const v = st[n]?.version; if (!v) { out.push(n); continue; } try { const m = await readManifest(); const want = m.ydl ?? m.version; if (want && v !== want) out.push(n); } catch { /* offline: the one here will do */ } }
  return out;
}
export const packLabel = (n: PackName): string => (n === 'python' ? t('packPython') : t('packFfmpeg'));

/** Makes sure the packs are here, asking first (with their size) and showing the download. True when they are. */
export async function ensurePacks(names: PackName[], why: string): Promise<boolean> {
  const st = await status(); if (!st) return true;
  names = names.filter((n) => packNames().includes(n));
  let need = await missing(names, st); if (!need.length) return true;
  let entries: { n: PackName; e: Awaited<ReturnType<typeof entryFor>> }[];
  try { entries = await Promise.all(need.map(async (n) => ({ n, e: await entryFor(n, st) }))); }
  catch (e) { toast(t('packUnavailable', { why: String((e as Error).message ?? e) }), 'error', 7000); return false; }
  const total = entries.reduce((s, x) => s + x.e.size, 0);
  return new Promise<boolean>((resolve) => {
    let done = false; const finish = (v: boolean) => { if (done) return; done = true; resolve(v); };
    const sh = openSheet(t('packTitle'), t('close'), { stack: true });
    // (Closed by its × or a tap outside: answered «no».)
    const mo = new MutationObserver(() => { if (!sh.el.isConnected) { mo.disconnect(); finish(false); } }); mo.observe(document.body, { childList: true, subtree: true });
    const rows = entries.map(({ n, e }) => { const bar = h('div', { class: 'task-bar' }, h('i', { style: { width: '0%' } })); const line = h('small', { class: 'src' }, formatBytes(e.size)); return { n, e, bar, line, el: h('div', { class: 'pack-row' }, icon(n === 'python' ? 'puzzle' : 'film'), h('div', { class: 'grow' }, h('b', null, packLabel(n)), line, bar)) }; });
    sh.body.append(h('p', null, why), h('p', { class: 'hint' }, t('packWhy', { size: formatBytes(total) })), ...rows.map((r) => r.el));
    const go = h('button', { type: 'button', class: 'btn primary' }, icon('download'), t('packDownload', { size: formatBytes(total) })) as HTMLButtonElement;
    const cancel = h('button', { type: 'button', class: 'btn tonal' }, t('cancel')) as HTMLButtonElement;
    sh.actions.append(cancel, go);
    let running: PackName | null = null;
    cancel.addEventListener('click', () => { if (running) { const d = desk(); if (d) void d.packCancel(running); else void plug()?.packCancel({ name: running }); } sh.close(); finish(false); });
    go.addEventListener('click', async () => {
      go.disabled = true; let off: { remove(): void } | (() => void) | null = null;
      const onP = (p: Prog) => { const r = rows.find((x) => x.n === p.name); if (!r) return; const f = p.total ? p.done / p.total : 0; (r.bar.firstChild as HTMLElement).style.width = `${Math.round(f * 100)}%`; r.line.textContent = `${formatBytes(p.done)} / ${formatBytes(p.total || r.e.size)} · ${localDigits(Math.round(f * 100))}%`; };
      try {
        const d = desk(); off = d ? d.onPackProgress(onP) : await listen<Prog>(plug()! as never, 'packProgress', onP);
        for (const r of rows) {
          running = r.n; r.line.textContent = t('packStarting');
          if (d) await d.packInstall({ name: r.n, url: r.e.url, sha256: r.e.sha256, version: r.e.version }); else await plug()!.packInstall({ name: r.n, url: r.e.url, sha256: r.e.sha256, version: r.e.version });
          (r.bar.firstChild as HTMLElement).style.width = '100%'; r.line.textContent = t('packReady'); r.el.classList.add('done');
        }
        running = null; toast(t('packInstalled', { what: rows.map((r) => packLabel(r.n)).join(' + ') })); sh.close(); finish(true);
      } catch (e) {
        running = null; const m = String((e as Error).message ?? e);
        sh.body.append(h('p', { class: 'plan-note bad' }, /cancel/i.test(m) ? t('cancelled') : /checksum/i.test(m) ? t('packChecksum') : t('packFailed', { why: m })));
        go.disabled = false; go.lastChild!.textContent = t('retry');
      } finally { if (typeof off === 'function') off(); else off?.remove(); }
    });
  });
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
