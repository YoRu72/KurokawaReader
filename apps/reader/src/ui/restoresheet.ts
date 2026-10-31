// Restoring: from a file, or from one of the automatic backups kept on the device — and what to bring back of
// it (Mihon's restore options): the settings, the reading (places, bookmarks, notes, highlights, tags), the
// books themselves (a full backup's), the fonts.
import { h, icon, openSheet, toast } from './dom';
import { t, countBooks, formatBytes } from '../i18n';

export async function restoreSheet(onDone?: () => void): Promise<void> {
  const { autoBackups, autoBackupFile } = await import('../backup');
  const sh = openSheet(t('restore'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const input = h('input', { type: 'file', accept: '.json,.zip,application/json,application/zip', hidden: true }) as HTMLInputElement;
  input.addEventListener('change', () => { const f = input.files?.[0]; input.value = ''; if (f) { sh.close(); partsSheet(f, onDone); } });
  const list = h('div', { class: 'dest-list' });
  list.append(h('button', { type: 'button', class: 'dest-row', onclick: () => input.click() }, icon('import'), h('span', { class: 'grow' }, t('restoreFromFile'))));
  const autos = await autoBackups();
  if (autos.length) list.append(h('h4', { class: 'section-title small' }, t('autoBackups')));
  for (const e of autos) list.append(h('button', { type: 'button', class: 'dest-row', onclick: async () => { const f = await autoBackupFile(e); if (!f) { toast(t('restoreFailed'), 'error'); return; } sh.close(); partsSheet(f, onDone); } },
    icon('clock'), h('span', { class: 'grow' }, h('b', null, new Date(e.at).toLocaleString()), h('small', { class: 'src' }, ` · ${countBooks(e.books)} · ${formatBytes(e.size)}`))));
  sh.body.append(list, input);
}

function partsSheet(file: File, onDone?: () => void): void {
  const sh = openSheet(t('restoreWhat'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const full = /\.zip$/i.test(file.name) || file.type.includes('zip');
  const box = (label: string, on = true) => { const c = h('input', { type: 'checkbox', checked: on }) as HTMLInputElement; return { c, el: h('label', { class: 'check-row' }, c, h('span', null, label)) }; };
  const settings = box(t('restoreSettings')); const reading = box(t('restoreReading')); const books = box(t('restoreBooks'), full); const fonts = box(t('restoreFonts'), full);
  sh.body.append(h('p', { class: 'hint', dir: 'auto' }, file.name), settings.el, reading.el, ...(full ? [books.el, fonts.el] : []));
  const status = h('p', { class: 'src' }); sh.body.append(status);
  const go = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    go.disabled = true;
    try {
      const { restoreBackup } = await import('../backup');
      const n = await restoreBackup(file, (title) => { status.textContent = title; }, { settings: settings.c.checked, reading: reading.c.checked, books: books.c.checked, fonts: fonts.c.checked });
      sh.close(); toast(t('restored', { n })); onDone?.();
    } catch (err) { status.textContent = `${t('restoreFailed')} — ${String((err as Error).message ?? err)}`; go.disabled = false; }
  } }, icon('undo'), t('restore')) as HTMLButtonElement;
  sh.actions.append(go);
}
