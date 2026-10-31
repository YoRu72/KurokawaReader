// One download's page: its files (each to download, skip or put first), the figures, play while it comes.
import { h, icon, iconButton, toast } from '../ui/dom';
import { t, formatBytes, localDigits, formatDate } from '../i18n';
import { getEngine, displayName, isVideo } from '../engine';
import type { Task } from '../engine/types';
import { back } from '../router';
import { stateLabel, fmtEta } from './downloads';
import { historyOf, fileMap, lanes, speedChart, logList } from './taskmap';

export function taskView(id: string): HTMLElement & { dispose?: () => void } {
  const eng = getEngine();
  const title = h('div', { class: 'title' }, h('span', { dir: 'auto' }, '…'));
  const body = h('div', { class: 'body task-detail' });
  const root = h('div', { class: 'view task-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/')), title), body) as HTMLElement & { dispose?: () => void };
  let task: Task | null = null;
  const draw = () => {
    if (!task) return;
    const x = task;
    (title.firstChild as HTMLElement).textContent = displayName(x);
    const rows: [string, string][] = [[t('details'), stateLabel(x.state)], [t('bytesOf', { done: formatBytes(x.done), total: formatBytes(x.total) }), x.total ? `${localDigits(Math.round((x.done / x.total) * 100))}%` : '']];
    if (x.downSpeed) rows.push([t('speedDown', { s: '' }).trim(), t('perSecond', { n: formatBytes(x.downSpeed) })]);
    if (x.upSpeed) rows.push([t('speedUp', { s: '' }).trim(), t('perSecond', { n: formatBytes(x.upSpeed) })]);
    if (x.eta) rows.push([t('etaLeft', { t: '' }).trim(), fmtEta(x.eta)]);
    if (x.kind === 'torrent') rows.push([t('peersSeeds', { peers: localDigits(x.peers ?? 0), seeds: localDigits(x.seeds ?? 0) }), x.infoHash ?? '']);
    rows.push([t('saveTo'), x.dir || t('defaultFolder')], [formatDate(x.addedAt), x.doneAt ? formatDate(x.doneAt) : '']);
    const acts = h('div', { class: 'task-detail-actions' });
    if (x.state === 'paused') acts.append(h('button', { type: 'button', class: 'btn primary', onclick: () => void eng.resume(x.id) }, icon('play'), t('resume')));
    else if (x.state !== 'done' && x.state !== 'failed' && eng.can.pause) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void eng.pause(x.id) }, icon('pause'), t('pause')));
    if (x.state === 'done' && eng.open) acts.append(h('button', { type: 'button', class: 'btn primary', onclick: () => void eng.open!(x.id) }, icon('play'), t('open')), h('button', { type: 'button', class: 'btn tonal', onclick: () => void eng.open!(x.id, -1) }, icon('folder'), t('openFolder')));
    const video = x.files.find((f) => isVideo(f.path) && f.priority > 0);
    if (video && (eng.streamUrl || x.state === 'done')) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('./player').then((m) => m.playTaskFile(x, video.index)).catch((e) => toast(String(e.message ?? e), 'error')) }, icon('film'), t(x.state === 'done' ? 'play' : 'stream')));
    acts.append(h('button', { type: 'button', class: 'btn text danger', onclick: () => { if (x.state !== 'done' && !confirm(t('confirmRemoveFiles', { name: displayName(x) }))) { void eng.remove(x.id, false).then(() => back('/')); return; } void eng.remove(x.id, x.state !== 'done').then(() => back('/')); } }, icon('trash'), t('removeTask')));
    const files = x.files.length > 1 || (x.files.length === 1 && x.kind === 'torrent') ? h('section', { class: 'card' }, h('h3', null, t('filesTitle')), h('div', { class: 'file-rows' }, ...x.files.map((f) => h('div', { class: 'file-row detail' },
      h('span', { class: 'grow', dir: 'auto' }, f.path, h('small', { class: 'src' }, ` · ${formatBytes(f.done)} / ${formatBytes(f.size)}`)),
      eng.setFiles ? h('select', { class: 'prio', onchange: (e: Event) => { const v = Number((e.target as HTMLSelectElement).value) as 0 | 1 | 2; const p = x.files.map((g) => (g.index === f.index ? v : g.priority)); void eng.setFiles!(x.id, p).catch((er) => toast(String(er.message ?? er), 'error')); } },
        ...([[0, t('fileSkip')], [1, t('fileNormal')], [2, t('fileHigh')]] as [number, string][]).map(([v, l]) => h('option', { value: String(v), selected: f.priority === v }, l))) : null,
      isVideo(f.path) && (eng.streamUrl || x.state === 'done') && f.priority > 0 ? iconButton('film', t('play'), () => void import('./player').then((m) => m.playTaskFile(x, f.index)).catch((er) => toast(String(er.message ?? er), 'error'))) : null)))) : null;
    const hst = historyOf(x);
    const map = x.kind !== 'torrent' ? h('section', { class: 'card' }, h('h3', null, t('connectionsTitle')), fileMap(x), lanes(x), speedChart(hst)) : h('section', { class: 'card' }, h('h3', null, t('speedTitle')), fileMap(x), speedChart(hst));
    const log = h('section', { class: 'card' }, h('h3', null, t('logTitle')), logList(hst));
    body.replaceChildren(
      h('section', { class: 'card task-head' }, h('div', { class: 'task-bar big' + (x.total ? '' : ' busy-any') }, h('i', { style: { width: `${x.total ? (x.done / x.total) * 100 : 0}%` } })), h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', { dir: 'auto' }, v)])), acts),
      map, files ?? h('span'),
      x.error ? h('p', { class: 'hint error' }, x.error) : h('span'), log);
  };
  const off = eng.onChange((ts) => { const found = ts.find((x) => x.id === id); if (!found) { if (task) back('/'); return; } task = found; draw(); });
  root.dispose = () => off();
  return root;
}
