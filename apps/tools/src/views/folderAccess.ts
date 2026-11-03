// A download folder Android does not let the app write to. On Android 11 and later an app may write only to its
// own folders, Download and Documents — not to a folder of its own at the storage's root, such as «A K Tools» —
// unless it has «All files access». The fix is offered when the folder is chosen and when a download fails
// there: allow that access, or keep the app's folder in Download.
import { h, icon, openSheet, toast } from '../ui/dom';
import { t } from '../i18n';
import { ktPlugin, nativePlatform } from '../native';
import { updateSettings } from '../settings';

type P = { folderAccess?(o: { dir?: string; ask?: boolean }): Promise<{ all: boolean; writable: boolean; defaultDir: string }> };
const plug = (): P | null => (nativePlatform() === 'android' ? (ktPlugin() as unknown as P | null) : null);

/** Whether downloads can go to `dir`; when not, what to do asked (true: it can now). */
export async function ensureFolderAccess(dir: string): Promise<boolean> {
  const p = plug(); if (!p?.folderAccess || !dir || dir.startsWith('content:')) return true;
  const st = await p.folderAccess({ dir }).catch(() => null); if (!st || st.writable) return true;
  return new Promise((resolve) => {
    const sh = openSheet(t('folderNoAccess'), t('close')); let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; document.removeEventListener('visibilitychange', again); clearInterval(tm); sh.close(); resolve(v); };
    const again = async () => { if (!sh.el.isConnected) { if (!done) { done = true; document.removeEventListener('visibilitychange', again); clearInterval(tm); resolve(false); } return; } if (document.hidden) return; const s = await p.folderAccess!({ dir }).catch(() => null); if (s?.writable) { toast(t('folderAccessOk')); finish(true); } };
    const tm = window.setInterval(() => void again(), 1500); document.addEventListener('visibilitychange', again);
    sh.body.append(h('p', { class: 'hint', dir: 'auto' }, t('folderNoAccessWhy', { dir })),
      h('div', { class: 'row-actions wrap' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => void p.folderAccess!({ dir, ask: true }) }, icon('key'), t('folderAllowAll')),
        h('button', { type: 'button', class: 'btn tonal', onclick: () => { updateSettings({ downloadDir: '' }); toast(t('folderUseApp', { dir: st.defaultDir })); finish(false); } }, icon('folder'), t('folderUseAppBtn'))),
      h('p', { class: 'src small' }, t('folderAllowAllHint')));
  });
}
