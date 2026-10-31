// The downloads: every task as a card — its name, a progress bar, speeds, peers, what is left — with pause,
// resume, play, remove; filters over them (all, active, finished, failed); the + for a new one.
import { h, icon, iconButton, toast, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits, countItems } from '../i18n';
import { getEngine, onEngineChange, displayName, isVideo, platformEngineProblem } from '../engine';
import type { Task, TaskState } from '../engine/types';
import { navigate } from '../router';
import { addSheet } from './add';
import { getSettings } from '../settings';
import { canArchive, isArchiveName } from '../archives';
import { allCategories, categoryOf, categoryName } from '../downloads/categories';
import { updateSettings } from '../settings';

const ACTIVE: TaskState[] = ['queued', 'metadata', 'downloading', 'checking', 'seeding'];
export const stateLabel = (s: TaskState): string => t(({ queued: 'stateQueued', metadata: 'stateMetadata', downloading: 'stateDownloading', seeding: 'stateSeeding', paused: 'statePaused', done: 'stateDone', failed: 'stateFailed', checking: 'stateChecking' } as const)[s]);
export const fmtEta = (s: number): string => { if (s < 60) return `${localDigits(Math.round(s))} ${t('perSecond', { n: '' }).replace('/', '').trim() || 's'}`.trim(); if (s < 3600) return `${localDigits(Math.round(s / 60))} min`; return `${localDigits(Math.floor(s / 3600))} h ${localDigits(Math.round((s % 3600) / 60))} min`; };

export function downloadsView(filter = 'all'): HTMLElement & { dispose?: () => void } {
  let tasks: Task[] = []; let current = filter; let cat = '';
  const list = h('div', { class: 'task-list' });
  const empty = h('div', { class: 'empty', hidden: true }, h('div', { class: 'glyph' }, icon('download')), h('h2', null, t('downloadsEmptyTitle')), h('p', null, t('downloadsEmptyBody')));
  const chips = h('div', { class: 'chips filter-chips' });
  const problem = platformEngineProblem();
  const note = problem ? h('p', { class: 'hint engine-note' }, icon('info'), t('engineUnavailable', { why: problem })) : null;
  const fab = h('button', { type: 'button', class: 'fab', 'aria-label': t('addDownload'), onclick: () => addSheet() }, icon('plus'), h('span', null, t('addDownload')));
  const title = h('div', { class: 'title' }, h('span', null, t('navDownloads')), h('small', { class: 'count' }));
  const actions = h('div', { class: 'topbar-actions' },
    iconButton('pause', t('pauseAll'), () => void Promise.all(tasks.filter((x) => ACTIVE.includes(x.state)).map((x) => getEngine().pause(x.id))).catch((e) => toast(String(e.message ?? e), 'error'))),
    iconButton('play', t('resumeAll'), () => void Promise.all(tasks.filter((x) => x.state === 'paused').map((x) => getEngine().resume(x.id))).catch((e) => toast(String(e.message ?? e), 'error'))),
    iconButton('trash', t('clearDone'), () => void Promise.all(tasks.filter((x) => x.state === 'done' || x.state === 'failed').map((x) => getEngine().remove(x.id, false))).then((r) => toast(t('tasksRemoved', { n: countItems(r.length) }))).catch((e) => toast(String(e.message ?? e), 'error'))),
    ...(getSettings().addons.includes('debrid') ? [iconButton('cloud', t('cloud'), () => void import('./cloud').then((m) => m.cloudSheet()))] : []),
    iconButton('settings', t('settings'), () => navigate('/settings')));
  const root = h('div', { class: 'view downloads-view' }, h('header', { class: 'topbar' }, title, actions), h('div', { class: 'body' }, note, chips, empty, list), fab) as HTMLElement & { dispose?: () => void };

  const FILTERS: [string, string][] = [['all', t('filterAll')], ['active', t('filterActive')], ['done', t('filterDone')], ['failed', t('filterFailed')]];
  const catOf = (x: Task) => categoryOf(displayName(x), x.kind);
  const drawChips = () => {
    const cats = allCategories().filter((c) => tasks.some((x) => catOf(x).id === c.id));
    chips.replaceChildren(...FILTERS.map(([k, label]) => h('button', { type: 'button', class: 'chip' + (current === k ? ' on' : ''), 'aria-pressed': String(current === k), onclick: () => { current = k; navigate(`/${k === 'all' ? '' : `?f=${k}`}`, true); draw(); } }, label)),
      ...(cats.length > 1 ? [h('span', { class: 'chip-sep' }), ...cats.map((c) => h('button', { type: 'button', class: 'chip' + (cat === c.id ? ' on' : ''), onclick: () => { cat = cat === c.id ? '' : c.id; draw(); } }, icon(c.icon), categoryName(c)))] : []),
      h('button', { type: 'button', class: 'chip sort-chip', onclick: () => sortSheet() }, icon('sort'), t(`sort_${getSettings().sort}` as 'sort_added')));
  };
  const sortSheet = () => { const sh = openSheet(t('sortBy'), t('close')); sh.body.append(h('div', { class: 'dest-list' }, ...(['added', 'name', 'size', 'state'] as const).map((k) => h('label', { class: 'dest-row' + (getSettings().sort === k ? ' on' : '') }, h('input', { type: 'radio', name: 'kt-sort', checked: getSettings().sort === k, onchange: () => { updateSettings({ sort: k }); sh.close(); draw(); } }), h('span', { class: 'name' }, t(`sort_${k}` as 'sort_added')))))); };
  const ORDER: Record<TaskState, number> = { downloading: 0, metadata: 1, checking: 2, queued: 3, seeding: 4, paused: 5, failed: 6, done: 7 };
  const shown = () => {
    const list = tasks.filter((x) => (current === 'all' ? true : current === 'active' ? ACTIVE.includes(x.state) || x.state === 'paused' : current === 'done' ? x.state === 'done' : x.state === 'failed') && (!cat || catOf(x).id === cat));
    const k = getSettings().sort;
    return k === 'name' ? [...list].sort((a, b) => displayName(a).localeCompare(displayName(b))) : k === 'size' ? [...list].sort((a, b) => (b.total || 0) - (a.total || 0)) : k === 'state' ? [...list].sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.addedAt - a.addedAt) : [...list].sort((a, b) => b.addedAt - a.addedAt);
  };
  const cards = new Map<string, HTMLElement>();
  const draw = () => {
    drawChips();
    const vis = shown();
    (title.querySelector('.count') as HTMLElement).textContent = tasks.length ? countItems(tasks.length) : '';
    empty.hidden = tasks.length > 0;
    const keep = new Set(vis.map((x) => x.id));
    for (const [id, el] of cards) if (!keep.has(id)) { el.remove(); cards.delete(id); }
    vis.forEach((x, i) => {
      let el = cards.get(x.id);
      if (!el) { el = card(x); cards.set(x.id, el); }
      else update(el, x);
      if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null);
    });
  };
  const bar = (x: Task) => (x.total ? Math.min(100, (x.done / x.total) * 100) : 0);
  const line2 = (x: Task): string => {
    const parts: string[] = [stateLabel(x.state)];
    if (x.total) parts.push(t('bytesOf', { done: formatBytes(x.done), total: formatBytes(x.total) })); else if (x.done) parts.push(formatBytes(x.done));
    if (x.state === 'downloading' || x.state === 'metadata') { if (x.downSpeed) parts.push(t('speedDown', { s: t('perSecond', { n: formatBytes(x.downSpeed) }) })); if (x.eta) parts.push(t('etaLeft', { t: fmtEta(x.eta) })); }
    if (x.state === 'seeding' && x.upSpeed) parts.push(t('speedUp', { s: t('perSecond', { n: formatBytes(x.upSpeed) }) }));
    if (x.kind === 'torrent' && (x.peers !== undefined || x.seeds !== undefined) && x.state !== 'done') parts.push(t('peersSeeds', { peers: localDigits(x.peers ?? 0), seeds: localDigits(x.seeds ?? 0) }));
    if (x.state === 'failed' && x.error) parts.push(x.error);
    return parts.join(' · ');
  };
  const card = (x: Task): HTMLElement => {
    const el = h('article', { class: `task-card state-${x.state}`, dataset: { id: x.id } },
      h('button', { type: 'button', class: 'task-main', onclick: () => navigate(`/task/${encodeURIComponent(x.id)}`) },
        h('span', { class: 'task-kind' }, icon(x.kind === 'torrent' ? 'magnet' : catOf(x).icon)),
        h('span', { class: 'task-text' }, h('span', { class: 'task-name', dir: 'auto' }, displayName(x)), h('span', { class: 'task-line' }, line2(x)), h('span', { class: 'task-bar' }, h('i', { style: { width: `${bar(x)}%` } })))),
      h('span', { class: 'task-actions' }));
    update(el, x); return el;
  };
  const update = (el: HTMLElement, x: Task) => {
    el.className = `task-card state-${x.state}`;
    (el.querySelector('.task-name') as HTMLElement).textContent = displayName(x);
    (el.querySelector('.task-line') as HTMLElement).textContent = line2(x);
    (el.querySelector('.task-bar i') as HTMLElement).style.width = `${bar(x)}%`;
    (el.querySelector('.task-bar') as HTMLElement).classList.toggle('busy-any', x.state === 'metadata' || x.state === 'checking' || (x.state === 'downloading' && !x.total));
    const acts = el.querySelector('.task-actions') as HTMLElement; acts.replaceChildren();
    const eng = getEngine();
    if (ACTIVE.includes(x.state) && eng.can.pause) acts.append(iconButton('pause', t('pause'), (e) => { e.stopPropagation(); void eng.pause(x.id).catch((er) => toast(String(er.message ?? er), 'error')); }));
    if (x.state === 'paused') acts.append(iconButton('play', t('resume'), (e) => { e.stopPropagation(); void eng.resume(x.id).catch((er) => toast(String(er.message ?? er), 'error')); }));
    if (x.state === 'failed') acts.append(iconButton('refresh', t('retry'), (e) => { e.stopPropagation(); void eng.resume(x.id).catch(() => eng.remove(x.id, false).then(() => eng.add({ source: x.source, dir: x.dir, name: x.name, meta: x.meta }))).catch((er) => toast(String(er.message ?? er), 'error')); }));
    if (x.state === 'done' && isVideo(displayName(x)) && getSettings().addons.includes('player')) acts.append(iconButton('play', t('play'), (e) => { e.stopPropagation(); void import('./player').then((m) => m.playTaskFile(x, x.files.find((f) => isVideo(f.path))?.index ?? 0)).catch((er) => toast(String(er.message ?? er), 'error')); }));
    else if (x.state === 'done' && eng.open) acts.append(iconButton('play', t('open'), (e) => { e.stopPropagation(); void eng.open!(x.id).catch((er) => toast(String(er.message ?? er), 'error')); }));
    acts.append(iconButton('more', t('more'), (e) => { e.stopPropagation(); taskMenu(x); }));
  };
  const taskMenu = (x: Task) => {
    const sh = openSheet(displayName(x), t('close'));
    const eng = getEngine();
    const row = (ic: string, label: string, fn: () => void) => sh.body.append(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, label)));
    row('info', t('details'), () => navigate(`/task/${encodeURIComponent(x.id)}`));
    if (x.state === 'done' && eng.open) { row('play', t('open'), () => void eng.open!(x.id)); row('folder', t('openFolder'), () => void eng.open!(x.id, -1)); }
    if (x.state === 'done' && x.kind !== 'torrent' && getSettings().addons.includes('archives') && canArchive() && isArchiveName(displayName(x)) && x.dir && !x.dir.startsWith('content:')) row('archive', t('extract'), () => void import('./extract').then((m) => m.extractSheet(`${x.dir.replace(/[\\/]$/, '')}/${x.name}`)));
    if (x.state === 'done' && x.kind !== 'torrent' && x.dir && !x.dir.startsWith('content:') && /\.(apk|apks|xapk|apkm)$/i.test(displayName(x))) void import('./apk').then((m) => { if (m.canInstallApps()) sh.body.insertBefore(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); void m.installSheet(`${x.dir.replace(/[\\/]$/, '')}/${displayName(x)}`); } }, icon('apps'), h('span', { class: 'name' }, t('installApp'))), sh.body.children[1] ?? null); });
    if (x.state === 'done' && x.dir && !x.dir.startsWith('content:') && x.kind !== 'torrent') { const fp = `${x.dir.replace(/[\\/]$/, '')}/${displayName(x)}`; void import('./convert').then((m) => { const k = m.kindOf(displayName(x)); const at = sh.body.children[2] ?? null; if (m.canConvert() && k) { sh.body.insertBefore(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); void m.convertSheet(fp, 'convert'); } }, icon('convert'), h('span', { class: 'name' }, t('convertTitle'))), at); if (k !== 'image' || true) sh.body.insertBefore(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); void m.convertSheet(fp, 'shrink'); } }, icon('archive'), h('span', { class: 'name' }, t('shrinkTitle'))), at); } }); row('check', t('verifyTitle'), () => void import('../downloads/prism').then((m) => m.verifySheet(fp))); }
    if (x.source.magnet) row('copy', t('copyMagnet'), () => void navigator.clipboard?.writeText(x.source.magnet!).then(() => toast(t('copied'))));
    if (x.source.url) row('copy', t('copyLink'), () => void navigator.clipboard?.writeText(x.source.url!).then(() => toast(t('copied'))));
    row('trash', t('removeKeepFiles'), () => void eng.remove(x.id, false).then(() => toast(t('taskRemoved'))).catch((er) => toast(String(er.message ?? er), 'error')));
    if (eng.id !== 'aria2' || !getSettings().aria2.use) sh.actions.append(h('button', { type: 'button', class: 'btn tonal danger', onclick: () => { if (!confirm(t('confirmRemoveFiles', { name: displayName(x) }))) return; sh.close(); void eng.remove(x.id, true).then(() => toast(t('taskRemoved'))).catch((er) => toast(String(er.message ?? er), 'error')); } }, icon('trash'), t('removeWithFiles')));
  };
  let off = getEngine().onChange((ts) => { tasks = ts; draw(); });
  const offEngine = onEngineChange((e) => { off(); off = e.onChange((ts) => { tasks = ts; draw(); }); });
  draw();
  root.dispose = () => { off(); offEngine(); };
  return root;
}
