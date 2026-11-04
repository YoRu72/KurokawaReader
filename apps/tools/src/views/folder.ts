// A download's folder shown inside the app (the files beside it, each opened, played, shared or sent to the system's
// apps), and a download renamed — its name and its extension apart — with the file on disk following.
import { h, icon, openSheet, toast } from '../ui/dom';
import { t, formatBytes } from '../i18n';
import { getEngine, isVideo } from '../engine';
import type { Task } from '../engine/types';
import { ktPlugin, nativePlatform } from '../native';
import { splitName } from '../downloads/probe';

type Entry = { name: string; path: string; dir: boolean; size: number; mtime: number };
type Lister = { listDir?(o: { path: string }): Promise<{ entries: Entry[]; exists?: boolean }> };
type DeskLister = { listDir?(p: string): Promise<{ entries: Entry[] }>; openPath?(p: string): Promise<unknown> };

async function list(dir: string): Promise<Entry[]> {
  const d = window.kurokawaTools as unknown as DeskLister | undefined; if (d?.listDir) return (await d.listDir(dir)).entries ?? [];
  const p = ktPlugin() as unknown as Lister | null; if (p?.listDir) return (await p.listDir({ path: dir })).entries ?? [];
  return [];
}
const dirOf = (x: Task): string => { const d = (x.dir ?? '').replace(/[\\/]$/, ''); return x.kind === 'torrent' && x.files.length > 1 ? `${d}/${x.name}` : d; };

/** The folder of `x`: on a computer the system's file manager with the file selected; on a phone the system's
 *  Files app at the folder when it opens one, else the folder listed here. */
export async function showInFolder(x: Task): Promise<void> {
  const eng = getEngine();
  if (nativePlatform() !== 'android') { await eng.open?.(x.id, -1).catch(() => undefined); return; }
  const r = await eng.open?.(x.id, -1).catch(() => null);
  const opened = !!(r && typeof r === 'object' && r.opened); if (opened) return;
  folderSheet((r && typeof r === 'object' && r.dir) || dirOf(x), x);
}

/** The files in `dir`, each tappable (a video plays, the rest open), with Share and Open with… on hold. */
export function folderSheet(dir: string, x?: Task): void {
  const sh = openSheet(t('folderTitle'), t('close')); const listEl = h('div', { class: 'dest-list' });
  sh.body.append(h('p', { class: 'src', dir: 'ltr' }, dir), listEl);
  void (async () => {
    const entries = (await list(dir).catch(() => [])).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!entries.length) { listEl.append(h('p', { class: 'hint' }, t('folderEmpty'))); return; }
    const kp = ktPlugin() as unknown as { openChooser?(o: { path: string; title: string }): Promise<void>; shareFile?(o: { path: string; title: string }): Promise<void>; openWith?(o: { path?: string; mime: string; title: string }): Promise<void> } | null;
    for (const e of entries) {
      const row = h('button', { type: 'button', class: 'dest-row', onclick: () => {
        if (e.dir) { sh.close(); folderSheet(e.path, x); return; }
        if (isVideo(e.name) || /\.(mp3|m4a|flac|ogg|opus|wav|aac)$/i.test(e.name)) { sh.close(); void import('./player').then(async (m) => { const { localFileUrl } = await import('../player/files'); const u = await localFileUrl(e.path); if (u) await m.openPlayer(u, e.name, { localPath: e.path }); }); return; }
        if (x && x.state === 'done' && x.files.length <= 1) { void getEngine().open?.(x.id).catch(() => toast(t('fileGone'), 'error')); return; }
        void kp?.openWith?.({ path: e.path, mime: 'application/octet-stream', title: e.name }).catch((er) => toast(String((er as Error).message ?? er), 'error'));
      } }, icon(e.dir ? 'folder' : isVideo(e.name) ? 'play' : 'file'), h('span', { class: 'name grow', dir: 'auto' }, e.name), h('small', { class: 'src' }, e.dir ? '' : formatBytes(e.size)));
      if (!e.dir && kp) row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); const m = openSheet(e.name, t('close'), { stack: true }); m.body.append(h('button', { type: 'button', class: 'dest-row', onclick: () => { m.close(); void kp.openChooser?.({ path: e.path, title: e.name }); } }, icon('external'), h('span', { class: 'name' }, t('openWith'))), h('button', { type: 'button', class: 'dest-row', onclick: () => { m.close(); void kp.shareFile?.({ path: e.path, title: e.name }); } }, icon('share'), h('span', { class: 'name' }, t('share')))); });
      listEl.append(row);
    }
  })();
}

/** The name and the extension of `x`, each in its own field; the file on disk renamed with it. */
export function renameSheet(x: Task): void {
  const eng = getEngine(); const sh = openSheet(t('rename'), t('cancel'));
  const cur = x.kind === 'torrent' && x.files.length > 1 ? { stem: x.name, ext: '' } : splitName(x.files[0]?.path.split(/[\\/]/).pop() || x.name);
  const name = h('input', { type: 'text', dir: 'auto', value: cur.stem, class: 'grow' }) as HTMLInputElement;
  const ext = h('input', { type: 'text', dir: 'ltr', value: cur.ext, class: 'ext-in', placeholder: t('extension'), spellcheck: 'false', autocapitalize: 'off' }) as HTMLInputElement;
  sh.body.append(h('p', { class: 'hint' }, x.kind === 'torrent' && x.files.length > 1 ? t('renameFolderHint') : t('renameHint')), h('div', { class: 'save-as-row' }, name, h('span', { class: 'dot' }, '.'), ext));
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    const stem = name.value.trim(); const e = ext.value.trim().replace(/^\.+/, ''); if (!stem) { name.focus(); return; }
    const full = e ? `${stem}.${e}` : stem;
    try { await eng.rename!(x.id, full); toast(t('renamed', { name: full })); sh.close(); }
    catch (er) { const m = String((er as Error).message ?? er); toast(m === 'exists' ? t('renameExists') : m === 'notDone' ? t('renameNotDone') : m, 'error'); }
  } }, icon('check'), t('rename')));
  setTimeout(() => { name.focus(); name.select(); }, 60);
}
