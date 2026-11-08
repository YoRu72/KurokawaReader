// The downloads: every task as a card — its name, a progress bar, speeds, peers, what is left — with pause,
// resume, play, remove; filters over them (all, active, finished, failed) and the options sheet (filter, sort,
// display, as the reader's Library has it); a search; selecting several for one action; the + for a new one.
import { swipeable } from '../ui/swipe';
import { canBrowse, openBrowser } from '../browser';
import { h, icon, iconButton, toast, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits, countItems } from '../i18n';
import { isStalled, phaseShort } from '../downloads/live';
import { getEngine, onEngineChange, displayName, isVideo, platformEngineProblem, retryPlatformEngine, mainFilePath } from '../engine';
import { canShareFiles, shareFiles } from '../ui/shareMany';
import { noteOf, countFinished, autoClean, retryFailed, exportList, importList, stats } from '../downloads/extras';
import type { Task, TaskState } from '../engine/types';
import { navigate } from '../router';
import { getSettings, onSettingsChange } from '../settings';
import { nativePlatform, ktPlugin, clipboardText } from '../native';
import { canArchive, isArchiveName } from '../archives';
import { allCategories, categoryOf, categoryName } from '../downloads/categories';
import { updateSettings } from '../settings';
import { dlPrefs, applyFilters, sortTasks, groupOf, activeFilters, downloadsOptionsSheet } from './downloadsOptions';
import { historyOf, sparkline } from './taskmap';
/** The add sheet, loaded on the first tap that opens it (it and the video panel are not on the first screen). */
const addSheet = (...a: Parameters<typeof import('./add').addSheet>): void => { void import('./add').then((m) => m.addSheet(...a)); };
const isMedia = (n: string): boolean => /\.(mkv|mp4|m4v|webm|avi|mov|ts|m2ts|wmv|flv|ogv|3gp|mp3|m4a|flac|ogg|opus|wav|aac)$/i.test(n);

const ACTIVE: TaskState[] = ['queued', 'metadata', 'downloading', 'checking', 'seeding'];
export const stateLabel = (s: TaskState): string => t(({ queued: 'stateQueued', metadata: 'stateMetadata', downloading: 'stateDownloading', seeding: 'stateSeeding', paused: 'statePaused', done: 'stateDone', failed: 'stateFailed', checking: 'stateChecking' } as const)[s]);
/** Time left as a clock (3:15, 1:02:40), the way the details page shows it — no unit words to translate. */
export const fmtEta = (s: number): string => { s = Math.max(0, Math.round(s)); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return localDigits(hh ? `${hh}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`); };

export function downloadsView(filter = 'all'): HTMLElement & { dispose?: () => void } {
  let tasks: Task[] = []; let current = filter; let cat = ''; let query = ''; const picked = new Set<string>(); let selecting = false;
  const list = h('div', { class: 'task-list' });
  const empty = h('div', { class: 'empty', hidden: true }, h('div', { class: 'glyph' }, icon('download')), h('h2', null, t('downloadsEmptyTitle')), h('p', null, t(document.documentElement.classList.contains('pc') ? 'downloadsEmptyBodyPc' : 'downloadsEmptyBody')));
  const chips = h('div', { class: 'chips filter-chips' });
  const problem = platformEngineProblem();
  // (The computer's aria2c not running: why, and a way to start it again here.)
  const note = problem ? h('p', { class: 'hint engine-note' }, icon('info'), h('span', { class: 'grow' }, t('engineUnavailable', { why: problem })),
    h('button', { type: 'button', class: 'btn tonal small', onclick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; if (await retryPlatformEngine()) note?.remove(); else { b.disabled = false; toast(t('engineUnavailable', { why: platformEngineProblem() ?? '' }), 'error', 5000); } } }, icon('refresh'), t('retry'))) : null;
  // (Downloads the last run left mid-way — the app killed, the phone off: offered back in one tap, once.)
  const recovery = h('div', { class: 'hint recovery-note', hidden: true });
  let recoveryDismissed = false;
  const drawRecovery = () => {
    const cut = tasks.filter((x) => x.meta?.interrupted && x.state !== 'done' && x.state !== 'downloading');
    recovery.hidden = recoveryDismissed || !cut.length; if (recovery.hidden) return;
    recovery.replaceChildren(icon('info'), h('span', { class: 'grow' }, t('recoveryNote', { n: countItems(cut.length) })),
      h('button', { type: 'button', class: 'btn tonal small', onclick: async () => { recoveryDismissed = true; recovery.hidden = true; for (const x of cut) { try { await getEngine().resume(x.id); } catch { /* one at a time */ } } } }, icon('play'), t('resumeAll')),
      h('button', { type: 'button', class: 'btn text small', onclick: () => { recoveryDismissed = true; recovery.hidden = true; } }, t('dismiss')));
  };
  const fab = h('button', { type: 'button', class: 'fab', 'aria-label': t('addDownload'), 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e: Event) => { const b = e.currentTarget as HTMLElement; void import('./fabMenu').then((m) => m.fabMenu(b)); } }, icon('plus'), h('span', null, t('addDownload')));
  const title = h('div', { class: 'title' }, h('span', null, t('navDownloads')), h('small', { class: 'count' }));
  const err = (e: unknown) => toast(String((e as Error).message ?? e), 'error');
  const moreMenu = () => {
    const sh = openSheet(t('navDownloads'), t('close'));
    const row = (ic: string, label: string, fn: () => void) => sh.body.append(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, label)));
    row('copy', t('pasteDownload'), () => void (async () => { const text = await clipboardText(); if (!text.trim()) { toast(t('clipboardEmpty'), 'error'); return; } addSheet(text.trim()); })());
    // (Slow mode: the downloads held to a gentle speed — a call, a game, a shared connection —, and back.)
    { const slow = !!getSettings().slowMode; row('clock', slow ? t('slowModeOff') : t('slowModeOn'), () => { const st = getSettings(); const was = st.slowMode; const limits = was ? (was.prev ?? { down: 0, up: 0 }) : { down: 512 * 1024, up: 64 * 1024 }; updateSettings({ limits, slowMode: was ? undefined : { prev: st.limits } }); void getEngine().setLimits?.(limits); toast(was ? t('slowModeOff') : t('slowModeOnToast')); }); }
    void import('../downloads/wifishare').then((m) => { if (m.canShareWifi() && tasks.some((x) => x.state === 'done')) row('wifi', t('wifiShareDone'), () => void m.shareWifiSheet(tasks)); });
    row('pause', t('pauseAll'), () => void Promise.all(tasks.filter((x) => ACTIVE.includes(x.state)).map((x) => getEngine().pause(x.id))).catch(err));
    row('play', t('resumeAll'), () => void Promise.all(tasks.filter((x) => x.state === 'paused').map((x) => getEngine().resume(x.id))).catch(err));
    row('trash', t('clearDone'), () => void Promise.all(tasks.filter((x) => x.state === 'done' || x.state === 'failed').map((x) => getEngine().remove(x.id, false))).then((r) => toast(t('tasksRemoved', { n: countItems(r.length) }))).catch(err));
    { const mb = window.kurokawaTools as unknown as { mini?(o: { action: string }): Promise<unknown> } | undefined; if (mb?.mini) row('mini', t('miniOpen'), () => void mb.mini!({ action: 'open' })); }
    row('folder', t('removeMissing'), () => void removeMissing(tasks).catch(err));
    if (tasks.some((x) => x.state === 'failed')) row('refresh', t('retryFailed'), () => void retryFailed(tasks).then((n) => toast(t('retriedN', { n: countItems(n) }))).catch(err));
    row('upload', t('exportList'), () => void exportListFile(tasks));
    row('download', t('importList'), () => importListSheet(tasks));
    row('chart', t('dlStats'), () => statsSheet(tasks));
    row('history', t('trashTitle'), () => void import('./trash').then((m) => m.trashSheet()));
    if (getSettings().addons.includes('debrid')) row('cloud', t('cloud'), () => void import('./cloud').then((m) => m.cloudSheet()));
    row('settings', t('settings'), () => navigate('/settings'));
  };
  // (The app's browser, opened straight away — no address needed: a site's downloads caught as they start.)
  const browseBtn = canBrowse() ? iconButton('globe', t('browseOpen'), () => openBrowser('')) : null; browseBtn?.classList.add('browse-btn');
  // (Translate on screen, when its add-on is here: its page, where the bubble — or the computer's shortcuts — start.)
  const screenHere = nativePlatform() === 'android' || !!(window.kurokawaTools as unknown as { screenStatus?: unknown } | undefined)?.screenStatus;
  const screenBtn = screenHere ? iconButton('translate', t('scrTitle'), () => navigate('/screen')) : null; screenBtn?.classList.add('screen-btn');
  const showScreen = () => { if (screenBtn) screenBtn.hidden = !getSettings().addons.includes('screen'); }; showScreen();
  const offScreen = onSettingsChange(showScreen);
  const actions = h('div', { class: 'topbar-actions' }, ...(screenBtn ? [screenBtn] : []), ...(browseBtn ? [browseBtn] : []), iconButton('more', t('more'), moreMenu));
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
  const root = h('div', { class: 'view downloads-view' }, h('header', { class: 'topbar' }, title, actions), h('div', { class: 'body' }, note, recovery, searchRow, chips, statusBar, empty, list), selectBar, fab) as HTMLElement & { dispose?: () => void };

  const FILTERS: [string, string][] = [['all', t('filterAll')], ['active', t('filterActive')], ['done', t('filterDone')], ['failed', t('filterFailed')]];
  const catOf = (x: Task) => categoryOf(displayName(x), x.kind);
  const drawChips = () => {
    const cats = allCategories().filter((c) => tasks.some((x) => catOf(x).id === c.id));
    chips.replaceChildren(...FILTERS.map(([k, label]) => h('button', { type: 'button', class: 'chip' + (current === k ? ' on' : ''), 'aria-pressed': String(current === k), onclick: () => { current = k; navigate(`/${k === 'all' ? '' : `?f=${k}`}`, true); draw(); } }, label)),
      ...(cats.length > 1 ? [h('span', { class: 'chip-sep' }), ...cats.map((c) => h('button', { type: 'button', class: 'chip' + (cat === c.id ? ' on' : ''), onclick: () => { cat = cat === c.id ? '' : c.id; draw(); } }, icon(c.icon), categoryName(c)))] : []),
      h('button', { type: 'button', class: 'chip sort-chip', onclick: () => downloadsOptionsSheet(tasks, draw, 'sort') }, icon('sort'), t((({ progress: 'sortProgress', speed: 'sortSpeed', eta: 'sortEta' } as Record<string, string>)[getSettings().sort] ?? `sort_${getSettings().sort}`) as 'sort_added')));
  };
  const shown = () => {
    const list = tasks.filter((x) => (current === 'all' ? true : current === 'active' ? ACTIVE.includes(x.state) || x.state === 'paused' : current === 'done' ? x.state === 'done' : x.state === 'failed') && (!cat || catOf(x).id === cat));
    return sortTasks(applyFilters(list, query));
  };
  const cards = new Map<string, HTMLElement>(); const heads = new Map<string, HTMLElement>();
  const draw = () => {
    drawChips(); drawRecovery();
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
      iconButton('trash', t('removeTask'), () => removeSheet(sel, () => setSelecting(false))));
  };
  const bar = (x: Task) => (x.total ? Math.min(100, (x.done / x.total) * 100) : 0);
  const line2 = (x: Task): string => {
    const show = dlPrefs().show; const parts: string[] = [x.heldBy === 'metered' ? t('heldMetered') : x.heldBy === 'battery' ? t('heldBattery') : stateLabel(x.state)];
    if (!show.size) { /* sizes hidden */ } else if (x.total) parts.push(t('bytesOf', { done: formatBytes(x.done), total: formatBytes(x.total) })); else if (x.done) parts.push(formatBytes(x.done));
    if (x.state === 'downloading' || x.state === 'metadata') { if (x.downSpeed && show.speed) parts.push(t('speedDown', { s: t('perSecond', { n: formatBytes(x.downSpeed) }) })); if (x.eta && show.eta) parts.push(t('etaLeft', { t: fmtEta(x.eta) })); }
    if ((x.kind === 'video' || x.meta?.hls) && (x.state === 'downloading' || x.state === 'metadata')) { const m = x.meta ?? {}; if (m.frags) parts.push(t('hlsPieces', { i: localDigits(String(m.frag ?? 0)), n: localDigits(String(m.frags)) })); if (m.phase) parts.push(phaseShort(m.phase)); }
    if (x.state === 'downloading' && isStalled(x)) parts.push(t('stalled'));
    if (x.kind === 'torrent' && x.state === 'downloading' && x.readyFile !== undefined && x.readyFile >= 0) parts.push(`▶ ${t('readyToPlay')}`);
    if (x.meta?.dhtFallback && x.state === 'downloading' && !x.peers && !x.seeds) parts.push(t('dhtAsked'));
    if (x.state === 'seeding' && x.upSpeed) parts.push(t('speedUp', { s: t('perSecond', { n: formatBytes(x.upSpeed) }) }));
    if (show.peers && x.kind === 'torrent' && (x.peers !== undefined || x.seeds !== undefined) && x.state !== 'done') parts.push(t('peersSeeds', { peers: localDigits(x.peers ?? 0), seeds: localDigits(x.seeds ?? 0) }));
    if (x.state === 'failed' && x.error) parts.push(x.error === 'page' ? t('errPageShort') : x.error === 'noFolderAccess' ? t('errNoFolderAccessShort') : x.error);
    { const n = noteOf(x.id); if (n) parts.push(`✎ ${n}`); }
    return parts.join(' · ');
  };
  const card = (x: Task): HTMLElement => {
    const el = h('article', { class: `task-card state-${x.state}`, dataset: { id: x.id } },
      h('input', { type: 'checkbox', class: 'task-pick', 'aria-label': t('dlSelect'), onclick: (e: Event) => { e.stopPropagation(); pick(tasks.find((y) => y.id === x.id) ?? x); } }),
      h('button', { type: 'button', class: 'task-main', onclick: () => { if (selecting) pick(tasks.find((y) => y.id === x.id) ?? x); else navigate(`/task/${encodeURIComponent(x.id)}`); },
        oncontextmenu: (e: Event) => { e.preventDefault(); const cur = tasks.find((y) => y.id === x.id) ?? x; // (A computer's right-click: its menu at the pointer; a phone's long press: choosing.)
          if (document.documentElement.classList.contains('pc') && !selecting) { taskMenu(cur, e); return; } if (!selecting) setSelecting(true); pick(cur); } },
        h('span', { class: 'task-kind' }, icon(x.kind === 'torrent' ? 'magnet' : catOf(x).icon)),
        h('span', { class: 'task-text' }, h('span', { class: 'task-name', dir: 'auto' }, displayName(x)), h('span', { class: 'task-line' }, line2(x)), h('span', { class: 'task-bar' }, h('i', { style: { width: `${bar(x)}%` } })))),
      h('span', { class: 'task-actions' }));
    // (A phone: swiped to the right, its first action — pause, resume, retry —; to the left, removed (asked first).)
    swipeable(el, () => { const cur = tasks.find((y) => y.id === x.id) ?? x; const eng = getEngine();
      const right = ACTIVE.includes(cur.state) && eng.can.pause ? { label: t('pause'), icon: 'pause', run: () => void eng.pause(cur.id).catch((er) => toast(String(er.message ?? er), 'error')) }
        : cur.state === 'paused' || cur.state === 'failed' ? { label: t(cur.state === 'failed' ? 'retry' : 'resume'), icon: cur.state === 'failed' ? 'refresh' : 'play', run: () => void eng.resume(cur.id).catch((er) => toast(String(er.message ?? er), 'error')) } : null;
      return { right, left: { label: t('removeTask'), icon: 'trash', run: () => removeSheet([cur]) } }; }, icon, () => !selecting);
    update(el, x); return el;
  };
  const update = (el: HTMLElement, x: Task) => {
    { const hst = historyOf(x); const old = el.querySelector('.kt-spark'); const sp = x.state === 'downloading' ? sparkline(hst) : null; if (sp) { if (old) old.replaceWith(sp); else el.querySelector('.task-text')?.append(sp); } else old?.remove(); }
    { const keep = ['swiping', 'swipe-r', 'swipe-l', 'armed'].filter((c) => el.classList.contains(c)); el.className = `task-card state-${x.state}`; el.classList.add(...keep); }
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
    // (Done: a video or a sound plays in the app; anything else opens in the system's viewer.)
    else if (x.state === 'done' && eng.open) { const media = x.files.some((f) => f.priority > 0 && isMedia(f.path)) || isMedia(x.name); acts.append(iconButton(media ? 'play' : 'external', t(media ? 'play' : 'open'), (e) => { e.stopPropagation(); if (media) { void import('./player').then((m) => m.playTaskFile(x, x.files.find((f) => f.priority > 0 && isMedia(f.path))?.index ?? 0)).catch((er) => toast(String((er as Error).message ?? er), 'error')); return; } void eng.open!(x.id).catch((er) => toast(String(er.message ?? er) === 'notFound' ? t('fileGone') : String(er.message ?? er), 'error')); })); }
    acts.append(iconButton('more', t('more'), (e) => { e.stopPropagation(); taskMenu(x, e); }));
  };
  const taskMenu = (x: Task, at?: Event) => {
    const sh = openSheet(displayName(x), t('close'), { at });
    const eng = getEngine();
    const row = (ic: string, label: string, fn: () => void) => sh.body.append(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, label)));
    row('info', t('details'), () => navigate(`/task/${encodeURIComponent(x.id)}`));
    if (x.state === 'done' && eng.open) { row('external', t('open'), () => void eng.open!(x.id).catch((er) => toast(String(er.message ?? er) === 'notFound' ? t('fileGone') : String(er.message ?? er), 'error'))); row('folder', t('showInFolder'), () => void import('./folder').then((m) => m.showInFolder(x))); if (canShareFiles() && mainFilePath(x)) row('share', t('share'), () => void shareFiles([mainFilePath(x)]).catch((er) => toast(String(er.message ?? er), 'error'))); if (eng.rename) row('pen', t('rename'), () => void import('./folder').then((m) => m.renameSheet(x))); }
    if (x.state === 'done' && x.kind !== 'torrent' && canArchive() && isArchiveName(displayName(x)) && x.dir && !x.dir.startsWith('content:')) row('archive', t('extract'), async () => { if (!getSettings().addons.includes('archives')) { const { needAddon } = await import('../addons/need'); if (!(await needAddon('archives', t('addonWhyArchives')))) return; } void import('./extract').then((m) => m.extractSheet(`${x.dir.replace(/[\\/]$/, '')}/${x.name}`)); });
    if (x.state === 'done' && x.kind !== 'torrent' && canArchive() && isArchiveName(displayName(x)) && x.dir && !x.dir.startsWith('content:')) row('folder', t('archiveBrowse'), () => void import('./archiveBrowse').then((m) => m.browseArchive(`${x.dir.replace(/[\\/]$/, '')}/${x.name}`)));
    // (An app among what came — a plain download, or a torrent's files —: installed from here; several, one row each.)
    if (x.state === 'done' && x.dir && !x.dir.startsWith('content:')) {
      const base = x.dir.replace(/[\\/]$/, '');
      const apps = x.kind === 'torrent' ? x.files.filter((f) => /\.(apk|apks|xapk|apkm)$/i.test(f.path)).map((f) => ({ path: `${base}/${f.path}`, name: f.path.split('/').pop() ?? f.path })) : /\.(apk|apks|xapk|apkm)$/i.test(displayName(x)) ? [{ path: `${base}/${displayName(x)}`, name: displayName(x) }] : [];
      if (apps.length) void import('./apk').then((m) => { if (!m.canInstallApps()) return; const at = sh.body.children[1] ?? null; for (const a of apps.slice(0, 8)) sh.body.insertBefore(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); void m.installSheet(a.path); } }, icon('apps'), h('span', { class: 'name' }, apps.length > 1 ? `${t('installApp')} · ${a.name}` : t('installApp'))), at); });
    }
    // (An iOS app among what came: looked into, and handed to the iPhone's installer.)
    if (x.state === 'done' && (x.kind !== 'torrent' ? /\.ipa$/i.test(displayName(x)) : x.files.some((f) => /\.ipa$/i.test(f.path)))) {
      const f = x.kind === 'torrent' ? x.files.find((g) => /\.ipa$/i.test(g.path)) : undefined; const rel = f ? f.path : displayName(x);
      row('apps', t('ipaTitle'), () => void (async () => {
        let file: Blob | undefined;
        try { if (x.dir && !x.dir.startsWith('content:')) { const { localFileUrl } = await import('../player/files'); const { localPathOf } = await import('../engine/localPath'); const lp = f ? localPathOf(x, f.index) : `${x.dir.replace(/[\\/]$/, '')}/${rel}`; const u = lp ? await localFileUrl(lp) : null; if (u) file = await (await fetch(u)).blob(); } } catch { /* the link alone */ }
        const m = await import('./ipa'); await m.ipaSheet({ file, url: x.source.url, name: rel.split('/').pop() });
      })());
    }
    if (x.state === 'done' && x.dir && !x.dir.startsWith('content:') && x.kind !== 'torrent') { const fp = `${x.dir.replace(/[\\/]$/, '')}/${displayName(x)}`; void import('./convert').then((m) => { const k = m.kindOf(displayName(x)); const at = sh.body.children[2] ?? null; if (m.canConvert() && k) { sh.body.insertBefore(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); void m.convertSheet(fp, 'convert'); } }, icon('convert'), h('span', { class: 'name' }, t('convertTitle'))), at); if (k !== 'image' || true) sh.body.insertBefore(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); void m.convertSheet(fp, 'shrink'); } }, icon('archive'), h('span', { class: 'name' }, t('shrinkTitle'))), at); } }); row('check', t('verifyTitle'), () => void import('../downloads/prism').then((m) => m.verifySheet(fp))); }
    if (x.source.magnet) row('copy', t('copyMagnet'), () => void navigator.clipboard?.writeText(x.source.magnet!).then(() => toast(t('copied'))));
    if (x.source.url) row('copy', t('copyLink'), () => void navigator.clipboard?.writeText(x.source.url!).then(() => toast(t('copied'))));
    if (eng.move && (x.state === 'queued' || x.state === 'paused' || (x.state === 'downloading' && eng.id === 'native'))) {
      const mv = (how: -2 | -1 | 1 | 2) => () => { if (getSettings().sort !== 'queue') { updateSettings({ sort: 'queue', dl: { ...dlPrefs(), desc: false } }); toast(t('sortedQueue')); } void eng.move!(x.id, how).catch((er) => toast(String(er.message ?? er), 'error')); };
      sh.body.append(h('div', { class: 'move-row' }, h('span', { class: 'grow' }, t('queuePlace')), iconButton('top', t('moveTop'), mv(-2)), iconButton('up', t('moveUp'), mv(-1)), iconButton('down', t('moveDown'), mv(1)), iconButton('bottom', t('moveBottom'), mv(2))));
    }
    if (x.kind === 'http' && x.state === 'failed' && x.source.url) void import('../browser').then((m) => { if (m.canBrowse()) row('globe', t('openInBrowser'), () => m.openBrowser(x.source.url!)); });
    if (x.kind === 'http' && x.state !== 'done' && eng.setUrl) row('link', t('newUrl'), () => newUrlSheet(x));
    if ((x.kind === 'http' && x.source.url) || (x.kind === 'torrent' && x.source.magnet)) { if (x.state === 'done' || x.state === 'failed' || x.state === 'seeding') row('refresh', t('redownload'), () => { if (!confirm(t('confirmRedownload', { name: displayName(x) }))) return; void (async () => { await eng.remove(x.id, true); await eng.add({ source: x.source, dir: x.dir, name: x.kind === 'http' ? displayName(x) : undefined, meta: x.meta }); toast(t('taskAdded', { name: displayName(x) })); })().catch((er) => toast(String(er.message ?? er), 'error')); }); }
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal danger', onclick: () => { sh.close(); removeSheet([x]); } }, icon('trash'), t('removeTask')));
  };
  let cleaned = false; const got = (ts: Task[]) => { tasks = ts; countFinished(ts); if (!cleaned && ts.length) { cleaned = true; void autoClean(ts).then((n) => { if (n) toast(t('autoCleaned', { n: countItems(n) })); }); } draw(); };
  let off = getEngine().onChange(got);
  const offEngine = onEngineChange((e) => { off(); off = e.onChange(got); });
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
  root.dispose = () => { off(); offEngine(); offScreen(); window.removeEventListener('keydown', onKey); window.removeEventListener('kt:limits', onLimits); };
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

/** A fresh link for a download whose link ran out: the same file, gone on from where it stopped. */
export function newUrlSheet(x: Task): void {
  const sh = openSheet(t('newUrl'), t('close'));
  const input = h('input', { type: 'url', dir: 'ltr', class: 'wide-input', value: '', placeholder: x.source.url ?? 'https://', autocomplete: 'off' }) as HTMLInputElement;
  const go = h('button', { type: 'button', class: 'btn primary' }, icon('link'), t('newUrlSet')) as HTMLButtonElement;
  go.addEventListener('click', () => {
    const v = input.value.trim(); if (!/^https?:\/\/\S+$/i.test(v)) { toast(t('invalidLink'), 'error'); input.focus(); return; }
    go.disabled = true; void getEngine().setUrl!(x.id, v).then(() => { toast(t('newUrlSet')); sh.close(); }).catch((e) => { go.disabled = false; toast(String((e as Error).message ?? e), 'error'); });
  });
  sh.body.append(h('p', { class: 'hint' }, t('newUrlHint')), input); sh.actions.append(go);
  setTimeout(() => input.focus(), 50);
}
/** Prism's «remove the ones whose files are gone»: finished downloads whose file was deleted outside the app. */
async function removeMissing(ts: Task[]): Promise<void> {
  const { existing } = await import('../downloads/net');
  const done = ts.filter((x) => (x.state === 'done' || x.state === 'seeding') && x.dir && !x.dir.startsWith('content:'));
  const paths = done.map((x) => `${x.dir!.replace(/[\\/]$/, '')}/${x.kind === 'torrent' ? x.name : displayName(x)}`);
  const there = paths.length ? await existing(paths) : [];
  if (!there) { toast(t('notHere'), 'error'); return; }
  const gone = done.filter((_, i) => !there[i]);
  if (!gone.length) { toast(t('noneMissing')); return; }
  for (const x of gone) await getEngine().remove(x.id, false);
  toast(t('removedMissing', { n: countItems(gone.length) }));
}


/** Removing downloads, as Flud asks it: from the list only, or — the box ticked — their files deleted from the
 *  device too (what is half-downloaded as well). */
export function removeSheet(tasks: Task[], done?: () => void): void {
  if (!tasks.length) return; const eng = getEngine();
  const sh = openSheet(tasks.length === 1 ? t('removeTask') : t('removeTasksN', { n: localDigits(tasks.length) }), t('close'), { stack: true });
  const canDelete = eng.id !== 'aria2' || !getSettings().aria2.use;
  const box = h('input', { type: 'checkbox', checked: false, disabled: !canDelete }) as HTMLInputElement;
  sh.body.append(h('p', { dir: 'auto' }, tasks.length === 1 ? displayName(tasks[0]) : t('removeTasksAsk', { n: localDigits(tasks.length) })),
    h('label', { class: 'row switch-row remove-files' }, h('span', null, t('deleteFromDevice'), h('small', { class: 'src' }, t('deleteFromDeviceHint'))), box));
  sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => sh.close() }, t('cancel')), h('button', { type: 'button', class: 'btn primary danger', onclick: async () => {
    sh.close(); let n = 0;
    for (const x of tasks) { try { await eng.remove(x.id, box.checked); n++; } catch (er) { toast(String((er as Error).message ?? er), 'error'); } }
    toast(box.checked ? t('removedWithFiles', { n: localDigits(n) }) : t('tasksRemoved', { n: countItems(n) })); done?.();
  } }, icon('trash'), t('remove')));
}

/** The list as a file (links, magnets, names, folders, notes): saved where the platform saves files. */
async function exportListFile(tasks: Task[]): Promise<void> {
  const text = JSON.stringify(exportList(tasks), null, 1); const name = `kurokawa-downloads-${new Date().toISOString().slice(0, 10)}.json`;
  try { const { saveText } = await import('../native'); await saveText(name, text, 'application/json'); toast(t('exportedList', { n: countItems(tasks.length) })); }
  catch { try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } }
}
/** A list brought back: a file of the app's, or links pasted (one a line); those already here skipped. */
function importListSheet(tasks: Task[]): void {
  const sh = openSheet(t('importList'), t('close'));
  const area = h('textarea', { class: 'text-input', rows: '6', dir: 'ltr', placeholder: t('importListHint') }) as HTMLTextAreaElement;
  const fin = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const file = h('input', { type: 'file', accept: '.json,.txt', hidden: true, onchange: async () => { const f = file.files?.[0]; if (f) area.value = await f.text(); } }) as HTMLInputElement;
  sh.body.append(area, h('div', { class: 'row-actions' }, file, h('button', { type: 'button', class: 'btn tonal small', onclick: () => file.click() }, icon('folder'), t('importFromFile'))), h('label', { class: 'row switch-row' }, h('span', null, t('importFinishedToo')), fin));
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => { if (!area.value.trim()) return; const r = await importList(area.value, { finishedToo: fin.checked }, tasks); sh.close(); toast(t('importedList', { added: countItems(r.added), skipped: localDigits(r.skipped) })); } }, icon('download'), t('importList')));
}
/** What the app has fetched: in the list now, and since it was installed. */
function statsSheet(tasks: Task[]): void {
  const sh = openSheet(t('dlStats'), t('close')); const s = stats();
  const by = (f: (x: Task) => boolean) => tasks.filter(f).length; const size = tasks.reduce((n, x) => n + (x.state === 'done' || x.state === 'seeding' ? x.total || x.done : x.done), 0);
  const rows: [string, string][] = [[t('statsAllTime'), `${countItems(s.files)} · ${formatBytes(s.bytes)}`], [t('statsSince'), new Date(s.since).toLocaleDateString(document.documentElement.lang || undefined)],
    [t('statsInList'), countItems(tasks.length)], [t('filterDone'), localDigits(by((x) => x.state === 'done' || x.state === 'seeding'))], [t('filterActive'), localDigits(by((x) => ['downloading', 'metadata', 'checking', 'queued', 'paused'].includes(x.state)))], [t('filterFailed'), localDigits(by((x) => x.state === 'failed'))],
    [t('statsTorrents'), localDigits(by((x) => x.kind === 'torrent'))], [t('statsOnDisk'), formatBytes(size)]];
  const list = h('div', { class: 'info-list' }, ...rows.map(([k, v]) => h('div', { class: 'row' }, h('span', null, k), h('b', { dir: 'auto' }, v))));
  sh.body.append(list);
  // (The storage panel: what the deduplication index knows — files hashed, links made, bytes saved, what is still on disk.)
  const p = ktPlugin() as unknown as { dedupeStats?(): Promise<{ hashed: number; links: number; saved: number; present: number; bytes: number }> } | null;
  if (p?.dedupeStats) void p.dedupeStats().then((d) => { const more: [string, string][] = [[t('statsHashed'), countItems(d.hashed)], [t('statsLinked'), `${countItems(d.links)} · ${formatBytes(d.saved)}`], [t('statsIndexed'), `${countItems(d.present)} · ${formatBytes(d.bytes)}`]]; list.append(h('div', { class: 'files-sec' }, t('statsStorage')), ...more.map(([k, v]) => h('div', { class: 'row' }, h('span', null, k), h('b', { dir: 'auto' }, v)))); if (!getSettings().dedupe) list.append(h('p', { class: 'hint' }, t('dedupeOffHint'))); }).catch(() => undefined);
}
