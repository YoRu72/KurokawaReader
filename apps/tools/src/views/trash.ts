// Recently removed (Prism's trash): each with when it went and its size, put back with a tap, or all emptied.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, formatBytes, dateLocale } from '../i18n';
import { trashList, restore, emptyTrash, type Trashed } from '../downloads/trash';

export function trashSheet(): void {
  const sh = openSheet(t('trashTitle'), t('close')); sh.el.classList.add('trash-sheet');
  const list = h('div', { class: 'trash-list' });
  const when = (ms: number) => new Date(ms).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' });
  const draw = () => {
    const l = trashList();
    if (!l.length) { list.replaceChildren(h('p', { class: 'empty small' }, t('trashEmpty'))); sh.actions.replaceChildren(); return; }
    list.replaceChildren(...l.map((x: Trashed) => h('div', { class: 'trash-row' },
      h('span', { class: 'task-kind' }, icon(x.kind === 'torrent' ? 'magnet' : 'file')),
      h('span', { class: 'grow' }, h('span', { class: 'result-title', dir: 'auto' }, x.name), h('small', { class: 'src' }, [when(x.removedAt), x.total ? formatBytes(x.total) : '', x.filesDeleted ? t('trashFilesGone') : ''].filter(Boolean).join(' · '))),
      h('button', { type: 'button', class: 'btn tonal small', onclick: (e: Event) => { (e.currentTarget as HTMLButtonElement).disabled = true; void restore(x).then(() => { toast(t('trashRestored', { name: x.name })); draw(); }).catch((er) => { toast(String((er as Error).message ?? er), 'error'); draw(); }); } }, icon('refresh'), t('trashRestore')))));
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn text danger', onclick: () => { emptyTrash(); draw(); } }, icon('trash'), t('trashEmptyAll')));
  };
  sh.body.append(list); draw();
}
