// The downloads: every task as a card — its name, a progress bar, speeds, peers, what is left — with pause,
// resume, play, remove; filters over them (all, active, finished, failed) and the options sheet (filter, sort,
// display, as the reader's Library has it); a search; selecting several for one action; the + for a new one.
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
import { dlPrefs, applyFilters, sortTasks, groupOf, activeFilters, downloadsOptionsSheet } from './downloadsOptions';
import { historyOf, sparkline } from './taskmap';

const ACTIVE: TaskState[] = ['queued', 'metadata', 'downloading', 'checking', 'seeding'];
export const stateLabel = (s: TaskState): string => t(({ queued: 'stateQueued', metadata: 'stateMetadata', downloading: 'stateDownloading', seeding: 'stateSeeding', paused: 'statePaused', done: 'stateDone', failed: 'stateFailed', checking: 'stateChecking' } as const)[s]);
/** Time left as a clock (3:15, 1:02:40), the way the details page shows it — no unit words to translate. */
export const fmtEta = (s: number): string => { s = Math.max(0, Math.round(s)); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return localDigits(hh ? `${hh}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`); };

export function downloadsView(filter = 'all'): HTMLElement & { dispose?: () => void } {
  let tasks: Task[] = []; let current = filter; let cat = ''; let query = ''; const picked = new Set<string>(); let selecting = false;
  const list = h('div', { class: 'task-list' });
  const empty = h('div', { class: 'empty', hidden: true }, h('div', { class: 'glyph' }, icon('download')), h('h2', null, t('downloadsEmptyTitle')), h('p', null, t('downloadsEmptyBody')));
  const chips = h('div', { class: 'chips filter-chips' });
  const problem = platformEngineProblem();
  const note = problem ? h('p', { class: 'hint engine-note' }, icon('info'), t('engineUnavailable', { why: problem })) : null;
  const fab = h('button', { type: 'button', class: 'fab', 'aria-label': t('addDownload'), 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e: Event) => { const b = e.currentTarget as HTMLElement; void import('./fabMenu').then((m) => m.fabMenu(b)); } }, icon('plus'), h('span', null, t('addDownload')));
  const title = h('div', { class: 'title' }, h('span', null, t('navDownloads')), h('small', { class: 'count' }));
  const err = (e: unknown) => toast(String((e as Error).message ?? e), 'error');
  const moreMenu = () => {
    const sh = openSheet(t('navDownloads'), t('close'));
    const row = (ic: string, label: string, fn: () => void) => sh.body.append(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, label)));
    row('pause', t('pauseAll'), () => void Promise.all(tasks.filter((x) => ACTIVE.includes(x.state)).map((x) => getEngine().pause(x.id))).catch(err));
    row('play', t('resumeAll'), () => void Promise.all(tasks.filter((x) => x.state === 'paused').map((x) => getEngine().resume(x.id))).catch(err));
    row('trash', t('clearDone'), () => void Promise.all(tasks.filter((x) => x.state === 'done' || x.state === 'failed').map((x) => getEngine().remove(x.id, false))).then((r) => toast(t('tasksRemoved', { n: countItems(r.length) }))).catch(err));
    if (getSettings().addons.includes('debrid')) row('cloud', t('cloud'), () => void import('./cloud').then((m) => m.cloudSheet()));
    row('settings', t('settings'), () => navigate('/settings'));
  };
  const actions = h('div', { class: 'topbar-actions' }, iconButton('more', t('more'), moreMenu));
  // Search, options (with how many filters are on), select
  const searchIn = h('input', { type: 'search', class: 'search-input', placeholder: t('dlSearch'), dir: 'auto', oninput: () => { query = searchIn.value; draw(); } }) as HTMLInputElement;
  const searchRow = h('div', { class: 'dl-search', hidden: true }, searchIn);
  const optBtn = iconButton('filter', t('dlOptions'), () => downloadsOptionsSheet(tasks, draw)); optBtn.classList.add('opt-badge');
  actions.prepend(iconButton('search', t('search'), () => { searchRow.hidden = !searchRow.hidden; if (!searchRow.hidden) searchIn.focus(); else { searchIn.value = ''; query = ''; draw(); } }), optBtn, iconButton('check', t('dlSelect'), () => setSelecting(!selecting)));
  const selectBar = h('div', { class: 'select-bar', hidden: true });
  // The status bar, as Prism's: total speeds, active · queued, the next scheduled start, the limiter at a tap, free space.
  const statusBar = h('footer', { class: 'dl-status', 'aria-live': 'off' }); let free = -1; let freeAt = 0;
  const drawStatus = () => {
    const s = getSettings(); const down = tasks.reduce((a, x) => a + (x.downSpeed || 0), 0); const up = tasks.reduce((a, x) => a + (x.upSpeed || 0), 0);
    const act = tasks.filter((x) => x.state === 'downloading' || x.state === 'metadata' || x.state === 'checking').length; const queued = tasks.filter((x) => x.state === 'queued').length;
    const next = s.schedule.enabled ? nextStart(s.schedule) : null;
    const lim = s.limits.down;
    statusBar.replaceChildren(...[
      h('span', { class: 'sb down', title: t('sbTotalDown') }, icon('download'), h('b', { dir: 'ltr' }, t('perSecond', { n: formatBytes(down) }))),
      up ? h('span', { class: 'sb', title: t('sbTotalUp') }, h('span', { class: 'sb-up' }, '↑'), h('b', { dir: 'ltr' }, t('perSecond', { n: formatBytes(up) }))) : null,
      h('span', { class: 'sb' }, t('sbActive', { a: localDigits(act), q: localDigits(queued) })),
      next ? h('span', { class: 'sb' }, icon('clock'), t('sbNext', { time: next })) : null,
      h('span', { class: 'grow' }),
      getEngine().can.limits ? h('button', { type: 'button', class: 'sb sb-btn' + (lim ? ' on' : ''), onclick: () => toggleLimiter() }, icon('flash'), lim ? t('sbLimit', { v: t('perSecond', { n: formatBytes(lim) }) }) : t('sbLimitOff')) : null,
      free >= 0 ? h('span', { class: 'sb' }, t('sbFree', { size: formatBytes(free) })) : null].filter((n): n is HTMLElement => !!n));
    if (Date.now() - freeAt > 60000) { freeAt = Date.now(); void import('../archives').then((m) => m.freeSpaceAt(getSettings().downloadDir || '')).then((f) => { if (f !== free) { free = f; drawStatus(); } }).catch(() => undefined); }
  };
  const toggleLimiter = () => { void import('../ui/dropzone').then((m) => m.toggleLimiter()); };
  const onLimits = () => drawStatus(); window.addEventListener('kt:limits', onLimits);
  const root = h('div', { class: 'view downloads-view' }, h('header', { class: 'topbar' }, title, actions), h('div', { class: 'body' }, note, searchRow, chips, statusBar, empty, list), selectBar, fab) as HTMLElement & { dispose?: () => void };

  const FILTERS: [string, string][] = [['all', t('filterAll')], ['active', t('filterActive')], ['done', t('filterDone')], ['failed', t('filterFailed')]];
  const catOf = (x: Task) => categoryOf(displayName(x), x.kind);
  const drawChips = () => {
    const cats = allCategories().filter((c) => tasks.some((x) => catOf(x).id === c.id));
    chips.replaceChildren(...FILTERS.map(([k, label]) => h('button', { type: 'button', class: 'chip' + (current === k ? ' on' : ''), 'aria-pressed': String(current === k), onclick: () => { current = k; navigate(`/${k === 'all' ? '' : `?f=${k}`}`, true); draw(); } }, label)),
      ...(cats.length > 1 ? [h('span', { class: 'chip-sep' }), ...cats.map((c) => h('button', { type: 'button', class: 'chip' + (cat === c.id ? ' on' : ''), onclick: () => { cat = cat === c.id ? '' : c.id; draw(); } }, icon(c.icon), categoryName(c)))] : []),
      h('button', { type: 'button', class: 'chip sort-chip', onclick: () => downloadsOptionsSheet(tasks, draw, 'sort') }, icon('sort'), t((({ progress: 'sortProgress', speed: 'sortSpeed', eta: 'sortEta' } as Record<string, string>)[getSettings().sort] ?? `sort_${getSettings().sort}`) as 'sort_added')));
  };
  const ORDER: Record<TaskState, number> = { downloading: 0, metadata: 1, checking: 2, queued: 3, seeding: 4, paused: 5, failed: 6, done: 7 };
  const shown = () => {
    const list = tasks.filter((x) => (current === 'all' ? true : current === 'active' ? ACTIVE.includes(x.state) || x.state === 'paused' : current === 'done' ? x.state === 'done' : x.state === 'failed') && (!cat || catOf(x).id === cat));
    return sortTasks(applyFilters(list, query));
  };
  const cards = new Map<string, HTMLElement>(); const heads = new Map<string, HTMLElement>();
  const draw = () => {
    drawChips();
    const P = dlPrefs(); const vis = shown();
    optBtn.dataset.n = String(activeFilters(P));
    list.className = `task-list look-${P.look}`;
    (title.querySelector('.count') as HTMLElement).textContent = tasks.length ? (vis.length !== tasks.length ? t('dlCountOf', { n: localDigits(vis.length), all: countItems(tasks.length) }) : countItems(tasks.length)) : '';
    empty.hidden = tasks.length > 0;
    for (const id of [...picked]) if (!tasks.some((x) => x.id === id)) picked.delete(id);
    // The order of the list: under each group's heading when grouped (groups in the order they first come).
    const nodes: HTMLElement[] = [];
    if (P.group === 'none') nodes.push(...vis.map((x) => cardFor(x)));
    else {
      const groups = new Map<string, { label: string; items: Task[] }>();
      for (const x of vis) { const g = groupOf(x, P.group)!; const e = groups.get(g.key) ?? groups.set(g.key, { label: g.label, items: [] }).get(g.key)!; e.items.push(x); }
      for (const [key, g] of groups) { let hd = heads.get(key); if (!hd) { hd = h('h3', { class: 'task-group' }); heads.set(key, hd); } hd.replaceChildren(h('span', null, g.label), h('small', null, localDigits(g.items.length))); nodes.push(hd, ...g.items.map((x) => cardFor(x))); }
    }
    const keep = new Set(nodes);
    for (const [id, el] of cards) if (!keep.has(el)) { el.remove(); cards.delete(id); }
    for (const [k, el] of heads) if (!keep.has(el)) { el.remove(); heads.delete(k); }
    nodes.forEach((el, i) => { if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null); });
    if (!vis.length && tasks.length) list.append(h('p', { class: 'empty small' }, t('noResults')));
    else list.querySelector(':scope > p.empty')?.remove();
    drawSelectBar(); drawStatus();
  };
  const cardFor = (x: Task): HTMLElement => { let el = cards.get(x.id); if (!el) { el = card(x); cards.set(x.id, el); } else update(el, x); return el; };
  /* ---------- several at once ---------- */
  const setSelecting = (on: boolean) => { selecting = on; if (!on) picked.clear(); root.classList.toggle('selecting', on); draw(); };
  const pick = (x: Task) => { if (picked.has(x.id)) picked.delete(x.id); else picked.add(x.id); if (!picked.size) { setSelecting(false); return; } draw(); };
  const drawSelectBar = () => {
    selectBar.hidden = !selecting; if (!selecting) return;
    for (const [id, el] of cards) { el.classList.toggle('picked', picked.has(id)); const cb = el.querySelector<HTMLInputElement>('.task-pick'); if (cb) cb.checked = picked.has(id); }
    const sel = tasks.filter((x) => picked.has(x.id)); const eng = getEngine();
    const each = (fn: (x: Task) => Promise<unknown>, done?: string) => () => void Promise.all(sel.map(fn)).then(() => { if (done) toast(done); setSelecting(false); }).catch((e) => toast(String((e as Error).message ?? e), 'error'));
    const links = sel.map((x) => x.source.magnet ?? x.source.url).filter(Boolean).join('\n');
    selectBar.replaceChildren(iconButton('close', t('close'), () => setSelecting(false)), h('span', { class: 'grow' }, t('dlSelected', { n: localDigits(sel.length) })),
      iconButton('list', t('dlSelectAll'), () => { for (const x of shown()) picked.add(x.id); draw(); }),
      ...(sel.some((x) => ACTIVE.includes(x.state)) && eng.can.pause ? [iconButton('pause', t('pause'), each((x) => (ACTIVE.includes(x.state) ? eng.pause(x.id) : Promise.resolve())))] : []),
      ...(sel.some((x) => x.state === 'paused' || x.state === 'failed') ? [iconButton('play', t('resume'), each((x) => (x.state === 'paused' || x.state === 'failed' ? eng.resume(x.id) : Promise.resolve())))] : []),
      ...(links ? [iconButton('copy', t('copyLink'), () => void navigator.clipboard?.writeText(links).then(() => toast(t('copied'))))] : []),
      iconButton('trash', t('removeKeepFiles'), each((x) => eng.remove(x.id, false), t('tasksRemoved', { n: countItems(sel.length) }))),
      ...(eng.id !== 'aria2' || !getSettings().aria2.use ? [h('button', { type: 'button', class: 'btn text small danger', onclick: () => { if (!confirm(t('dlConfirmRemoveFiles', { n: countItems(sel.length) }))) return; each((x) => eng.remove(x.id, true), t('tasksRemoved', { n: countItems(sel.length) }))(); } }, t('removeWithFiles'))] : []));
  };
  const bar = (x: Task) => (x.total ? Math.min(100, (x.done / x.total) * 100) : 0);
  const line2 = (x: Task): string => {
    const show = dlPrefs().show; const parts: string[] = [stateLabel(x.state)];
    if (!show.size) { /* sizes hidden */ } else if (x.total) parts.push(t('bytesOf', { done: formatBytes(x.done), total: formatBytes(x.total) })); else if (x.done) parts.push(formatBytes(x.done));
    if (x.state === 'downloading' || x.state === 'metadata') { if (x.downSpeed && show.speed) parts.push(t('speedDown', { s: t('perSecond', { n: formatBytes(x.downSpeed) }) })); if (x.eta && show.eta) parts.push(t('etaLeft', { t: fmtEta(x.eta) })); }
    if (x.state === 'seeding' && x.upSpeed) parts.push(t('speedUp', { s: t('perSecond', { n: formatBytes(x.upSpeed) }) }));
    if (show.peers && x.kind === 'torrent' && (x.peers !== undefined || x.seeds !== undefined) && x.state !== 'done') parts.push(t('peersSeeds', { peers: localDigits(x.peers ?? 0), seeds: localDigits(x.seeds ?? 0) }));
    if (x.state === 'failed' && x.error) parts.push(x.error);
    return parts.join(' · ');
  };
  const card = (x: Task): HTMLElement => {
    const el = h('article', { class: `task-card state-${x.state}`, dataset: { id: x.id } },
      h('input', { type: 'checkbox', class: 'task-pick', 'aria-label': t('dlSelect'), onclick: (e: Event) => { e.stopPropagation(); pick(tasks.find((y) => y.id === x.id) ?? x); } }),
      h('button', { type: 'button', class: 'task-main', onclick: () => { if (selecting) pick(tasks.find((y) => y.id === x.id) ?? x); else navigate(`/task/${encodeURIComponent(x.id)}`); },
        oncontextmenu: (e: Event) => { e.preventDefault(); if (!selecting) setSelecting(true); pick(tasks.find((y) => y.id === x.id) ?? x); } },
        h('span', { class: 'task-kind' }, icon(x.kind === 'torrent' ? 'magnet' : catOf(x).icon)),
        h('span', { class: 'task-text' }, h('span', { class: 'task-name', dir: 'auto' }, displayName(x)), h('span', { class: 'task-line' }, line2(x)), h('span', { class: 'task-bar' }, h('i', { style: { width: `${bar(x)}%` } })))),
      h('span', { class: 'task-actions' }));
    update(el, x); return el;
  };
  const update = (el: HTMLElement, x: Task) => {
    { const hst = historyOf(x); const old = el.querySelector('.kt-spark'); const sp = x.state === 'downloading' ? sparkline(hst) : null; if (sp) { if (old) old.replaceWith(sp); else el.querySelector('.task-text')?.append(sp); } else old?.remove(); }
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
    if (x.state === 'done' && isVideo(displayName(x))) acts.append(iconButton('play', t('play'), (e) => { e.stopPropagation(); void import('./player').then((m) => m.playTaskFile(x, x.files.find((f) => isVideo(f.path))?.index ?? 0)).catch((er) => toast(String(er.message ?? er), 'error')); }));
    else if (x.state === 'done' && eng.open) acts.append(iconButton('play', t('open'), (e) => { e.stopPropagation(); void eng.open!(x.id).catch((er) => toast(String(er.message ?? er), 'error')); }));
    acts.append(iconButton('more', t('more'), (e) => { e.stopPropagation(); taskMenu(x); }));
  };
  const taskMenu = (x: Task) => {
    const sh = openSheet(displayName(x), t('close'));
    const eng = getEngine();
    const row = (ic: string, label: string, fn: () => void) => sh.body.append(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, label)));
    row('info', t('details'), () => navigate(`/task/${encodeURIComponent(x.id)}`));
    if (x.state === 'done' && eng.open) { row('play', t('open'), () => void eng.open!(x.id)); row('folder', t('openFolder'), () => void eng.open!(x.id, -1)); }
    if (x.state === 'done' && x.kind !== 'torrent' && canArchive() && isArchiveName(displayName(x)) && x.dir && !x.dir.startsWith('content:')) row('archive', t('extract'), async () => { if (!getSettings().addons.includes('archives')) { const { needAddon } = await import('../addons/need'); if (!(await needAddon('archives', t('addonWhyArchives')))) return; } void import('./extract').then((m) => m.extractSheet(`${x.dir.replace(/[\\/]$/, '')}/${x.name}`)); });
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
  // Keys (Prism's): F search, A select all, Delete remove the selected, Space pause/resume them, Escape leave.
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected || document.querySelector('.sheet')) return;
    const el = e.target as HTMLElement; if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) { if (e.key === 'Escape' && el === searchIn) { searchIn.value = ''; query = ''; searchRow.hidden = true; draw(); } return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); searchRow.hidden = false; searchIn.focus(); }
    else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); if (!selecting) setSelecting(true); for (const x of shown()) picked.add(x.id); draw(); }
    else if (e.key === 'Escape' && selecting) setSelecting(false);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selecting && picked.size) { e.preventDefault(); void Promise.all([...picked].map((id) => getEngine().remove(id, false))).then(() => { toast(t('tasksRemoved', { n: countItems(picked.size) })); setSelecting(false); }); }
    else if (e.key === ' ' && selecting && picked.size) { e.preventDefault(); const eng = getEngine(); void Promise.all(tasks.filter((x) => picked.has(x.id)).map((x) => (x.state === 'paused' || x.state === 'failed' ? eng.resume(x.id) : ACTIVE.includes(x.state) ? eng.pause(x.id) : Promise.resolve()))); }
  };
  window.addEventListener('keydown', onKey);
  root.dispose = () => { off(); offEngine(); window.removeEventListener('keydown', onKey); window.removeEventListener('kt:limits', onLimits); };
  return root;
}
/** The next time the scheduler starts, as «HH:MM» (with the weekday when it is not today). */
function nextStart(sch: { start: string; days: number[] }): string | null {
  const [hh, mm] = sch.start.split(':').map(Number); if (!Number.isFinite(hh)) return null;
  const now = new Date();
  for (let d = 0; d < 8; d++) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, hh, mm || 0);
    if (at <= now) continue; if (sch.days.length && !sch.days.includes(at.getDay())) continue;
    const time = localDigits(`${String(hh).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}`);
    return d === 0 ? time : `${new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(at)} ${time}`;
  }
  return null;
}
