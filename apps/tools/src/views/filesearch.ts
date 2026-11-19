// «Everywhere in my folders» — the Files page's fast search on a computer with the Tauri shell (Tools 0.21): the
// shell's file index (src-tauri/src/filesearch.rs over kt-core's fileindex) searched as the user types, the newest
// search stopping the one before; the hits in a virtualised list (only the rows in sight are in the page, so ten
// thousand stay smooth), each with its kind, its name with the match marked, its folder, size and date; filter chips
// (kind, size, date) and a sort; the folders chosen, left out, the index's size, Rebuild, Remove index and the pause in
// a sheet. Loaded on first use by files.ts; nothing of it exists on a phone, in Electron or on the web.
import { h, icon, iconButton, toast, openSheet } from '../ui/dom';
import { t, formatBytes, formatDateShort, formatDate, localDigits } from '../i18n';
import type { Entry } from './files';

export type Hit = { name: string; path: string; dir: string; size: number; mtime: number; folder: boolean; link: boolean; kind: string };
type Res = { hits?: Hit[]; total?: number; micros?: number; cancelled?: boolean; idle?: boolean };
export type RootSt = { path: string; entries: number; walked: boolean; lastWalk: number; unreadable: number; exclude: string[] };
export type Status = { running: boolean; busy: boolean; paused: boolean; pauseOnBattery: boolean; onBattery: boolean | null; batteryPaused: boolean; entries: number; folders: number; files: number; memory: number; fileBytes: number; note: string | null; progress: { entries: number; current: string }; roots: RootSt[]; excludeNames: string[] };
export type Q = { text: string; kinds?: string[]; sizeMin?: number; sizeMax?: number; after?: number; before?: number; sort?: string; desc?: boolean; limit?: number };
type Refused = { ok: boolean; reason?: string; other?: string | null };
/** The bridge's methods this needs (desktop-tauri/bridge.js — the Tauri shell's own). */
export type FsBridge = {
  fileSearchStatus(): Promise<Status>; fileSearch(o: Q): Promise<Res>;
  fileSearchAdd(o: { path: string }): Promise<Refused>; fileSearchRemove(o: { path: string }): Promise<{ ok: boolean }>;
  fileSearchExclude(o: { root: string; path: string; remove?: boolean }): Promise<Refused>;
  fileSearchRebuild(): Promise<{ ok: boolean }>; fileSearchForget(): Promise<{ ok: boolean }>;
  fileSearchPause(o: { paused?: boolean; pauseOnBattery?: boolean }): Promise<Status>; pickDir(): Promise<string | null>;
};
export const fsBridge = (): FsBridge | null => { const d = window.kurokawaTools as unknown as Partial<FsBridge> | undefined; return d?.fileSearch && d.fileSearchStatus && d.pickDir ? (d as FsBridge) : null; };

/** What the Files page lends: opening an entry, its usual menu, going to a folder, and the in-folder filter. */
export type Ctx = { open(e: Entry): void; menu(e: Entry, ev: Event): void; go(dir: string): void; filter(): void; onClose(): void };
export type Everywhere = { el: HTMLElement; focus(): void; close(): void; dispose(): void };

const KINDS: [string, string, string][] = [['video', 'filesKindVideo', 'film'], ['audio', 'filesKindMusic', 'music'], ['picture', 'filesKindImages', 'images'], ['document', 'filesKindDocs', 'file'], ['archive', 'filesKindArchives', 'archive'], ['folder', 'fsKindFolder', 'folder']];
const KIND_ICON: Record<string, string> = { video: 'film', audio: 'music', picture: 'images', document: 'file', archive: 'archive', folder: 'folder', other: 'file' };
const MB = 1024 * 1024;
const SIZES: [string, string, number | undefined, number | undefined][] = [['any', 'fsSizeAny', undefined, undefined], ['small', 'fsSizeSmall', undefined, MB - 1], ['mid', 'fsSizeMid', MB, 100 * MB], ['large', 'fsSizeLarge', 100 * MB, 1024 * MB], ['huge', 'fsSizeHuge', 1024 * MB + 1, undefined]];
const DAY = 86_400_000;
const DATES: [string, string, number | undefined, boolean][] = [['any', 'fsDateAny', undefined, false], ['today', 'fsDateToday', 0, false], ['week', 'fsDateWeek', 7, false], ['month', 'fsDateMonth', 30, false], ['year', 'fsDateYear', 365, false], ['older', 'fsDateOlder', 365, true]];
const SORTS: [string, string][] = [['relevance', 'fsSortRelevance'], ['name', 'sortName'], ['path', 'fsSortPath'], ['size', 'sortSize'], ['date', 'sortDate']];
type Ui = { kinds: string[]; size: string; date: string; sort: string; desc: boolean };
const UI_KEY = 'kt.fsearch.ui';
const loadUi = (): Ui => { const d: Ui = { kinds: [], size: 'any', date: 'any', sort: 'relevance', desc: false }; try { return { ...d, ...(JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as Partial<Ui>) }; } catch { return d; } };
const saveUi = (u: Ui) => { try { localStorage.setItem(UI_KEY, JSON.stringify(u)); } catch { /* none */ } };
/** A figure as data: Western digits, grouped (never the Eastern ones). */
const num = (n: number): string => localDigits(new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(n))));
/** The first hits asked for; more as the list is scrolled down, up to the shell's cap. */
const FIRST = 500; const CAP = 10_000;
export const ROW_H = 60;

/** The query the chips and the typed text make (exported for the test's sake: the shapes the shell is sent). */
export function buildQuery(text: string, u: Ui, limit: number, now = Date.now()): Q {
  const q: Q = { text: text.trim(), sort: u.sort, desc: u.desc, limit };
  if (u.kinds.length) q.kinds = [...u.kinds];
  const s = SIZES.find(([k]) => k === u.size); if (s?.[2] !== undefined) q.sizeMin = s[2]; if (s?.[3] !== undefined) q.sizeMax = s[3];
  const d = DATES.find(([k]) => k === u.date);
  if (d && d[2] !== undefined) {
    const start = new Date(now); start.setHours(0, 0, 0, 0); const edge = d[2] === 0 ? start.getTime() : now - d[2] * DAY;
    if (d[3]) q.before = edge; else q.after = edge;
  }
  return q;
}
/** The words to mark in a name: the typed words without the operators (path:, ext:, kind:, a leading -), their
 *  wildcards' literal runs. */
export function markWords(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]+)"|(\S+)/g)) {
    const w = (m[1] ?? m[2] ?? '').toLowerCase(); if (!w || /^-/.test(w) || /^[a-z]+:/.test(w)) continue;
    for (const part of w.split(/[*?]+/)) if (part && !part.includes('/') && !part.includes('\\')) out.push(part);
  }
  return out.sort((a, b) => b.length - a.length);
}
/** The name with each word's places wrapped in <mark>. */
function marked(name: string, words: string[]): (Node | string)[] {
  if (!words.length) return [name];
  const low = name.toLowerCase(); const on = new Uint8Array(name.length);
  for (const w of words) { let i = low.indexOf(w); while (i >= 0) { on.fill(1, i, i + w.length); i = low.indexOf(w, i + w.length); } }
  const parts: (Node | string)[] = []; let i = 0;
  while (i < name.length) { let j = i; while (j < name.length && on[j] === on[i]) j++; const s = name.slice(i, j); parts.push(on[i] ? h('mark', { class: 'fs-mark' }, s) : s); i = j; }
  return parts;
}
const entryOf = (x: Hit): Entry => ({ name: x.name, path: x.path, dir: x.folder, size: x.size, mtime: x.mtime, ext: x.folder ? undefined : (x.name.split('.').pop() ?? '').toLowerCase() });
const noteText = (n: string | null): string | null => (!n ? null : /looking every few seconds/.test(n) ? t('fsNotePolling') : t('fsNoteRebuilt'));
// (A path inside a sentence is isolated, so «/home/u/Media» keeps its own order in an Arabic line.)
const iso = (p: string): string => (p ? `\u2068${p}\u2069` : p);
const refusalText = (r: Refused, root = ''): string => ({ inside: t('fsRefInside', { other: iso(r.other ?? '') }), holds: t('fsRefHolds', { other: iso(r.other ?? '') }), same: t('fsRefSame'), appData: t('fsRefAppData'), missing: t('fsRefMissing'), tooMany: t('fsRefMany'), outside: t('fsRefOutside', { root: iso(root) }) } as Record<string, string>)[r.reason ?? ''] ?? t('filesFailed');

/** Opens the «Everywhere» panel in the Files page `host` (under its top bar). */
export function openEverywhere(host: HTMLElement, ctx: Ctx): Everywhere {
  const br = fsBridge()!;
  const ui = loadUi();
  let st: Status | null = null; let hits: Hit[] = []; let total = 0; let micros = 0; let seq = 0; let shownText = ''; let limit = FIRST;
  let gone = false; let debounce = 0; let poll = 0; let focusT = 0; let more = false; let active = -1;
  const input = h('input', { type: 'search', class: 'fs-input', placeholder: t('fsPlaceholder'), 'aria-label': t('fsPlaceholder'), autocomplete: 'off', spellcheck: 'false', dir: 'auto' }) as HTMLInputElement;
  const modeHere = h('button', { type: 'button', class: 'fs-mode-btn', role: 'radio', 'aria-checked': 'false', onclick: () => { close(); ctx.filter(); } }, icon('folder'), h('span', null, t('fsThisFolder')));
  const modeAll = h('button', { type: 'button', class: 'fs-mode-btn on', role: 'radio', 'aria-checked': 'true', title: `${t('fsEverywhere')} (Ctrl+Shift+F)`, onclick: () => input.focus() }, icon('search'), h('span', null, t('fsEverywhere')));
  const manageBtn = iconButton('settings', t('fsManage'), () => manageSheet()); manageBtn.classList.add('fs-manage');
  const closeBtn = iconButton('close', t('close'), () => close()); closeBtn.classList.add('fs-close');
  const chips = h('div', { class: 'fs-chips chip-row wrap', role: 'toolbar', 'aria-label': t('fsFilters') });
  const line = h('div', { class: 'fs-line', role: 'status', 'aria-live': 'polite' });
  const banner = h('div', { class: 'fs-banner', hidden: true });
  const space = h('div', { class: 'fs-space', role: 'listbox', 'aria-label': t('fsEverywhere') });
  const scroller = h('div', { class: 'fs-scroll', tabindex: '0' }, space);
  const empty = h('div', { class: 'fs-empty', hidden: true });
  const el = h('section', { class: 'fs-panel', 'aria-label': t('fsEverywhere') },
    h('div', { class: 'fs-bar' }, h('div', { class: 'fs-mode', role: 'radiogroup', 'aria-label': t('search') }, modeHere, modeAll), h('div', { class: 'fs-field' }, icon('search'), input), manageBtn, closeBtn),
    chips, banner, line, empty, scroller);
  const top = host.querySelector(':scope > .topbar'); if (top) top.after(el); else host.prepend(el);
  host.classList.add('fs-on');

  // ---- the chips
  const menuChip = (label: string, on: boolean, ic: string, pick: (ev: MouseEvent) => void) => h('button', { type: 'button', class: 'chip small fs-chip' + (on ? ' on' : ''), 'aria-haspopup': 'menu', onclick: pick }, icon(ic), h('span', null, label), icon('chevronDown'));
  const choose = (ev: MouseEvent, title: string, opts: [string, string][], cur: string, set: (k: string) => void, extra?: HTMLElement) => {
    const sh = openSheet(title, t('close'), { at: ev });
    sh.body.append(h('div', { class: 'dest-list' }, ...opts.map(([k, label]) => h('button', { type: 'button', class: 'dest-row' + (k === cur ? ' on' : ''), 'aria-pressed': String(k === cur), onclick: () => { sh.close(); set(k); } }, icon(k === cur ? 'check' : 'circle'), h('span', { class: 'name' }, label)))), ...(extra ? [extra] : []));
  };
  const drawChips = () => {
    const kindChips = KINDS.map(([k, label, ic]) => { const on = ui.kinds.includes(k); return h('button', { type: 'button', class: 'chip small fs-chip' + (on ? ' on' : ''), 'aria-pressed': String(on), dataset: { kind: k }, onclick: () => { ui.kinds = on ? ui.kinds.filter((x) => x !== k) : [...ui.kinds, k]; changed(); } }, icon(ic), h('span', null, t(label as 'fsKindFolder'))); });
    const sz = SIZES.find(([k]) => k === ui.size) ?? SIZES[0]; const dt = DATES.find(([k]) => k === ui.date) ?? DATES[0]; const so = SORTS.find(([k]) => k === ui.sort) ?? SORTS[0];
    const sizeChip = menuChip(ui.size === 'any' ? t('fsSize') : t(sz[1] as 'fsSizeAny'), ui.size !== 'any', 'storage', (ev) => choose(ev, t('fsSize'), SIZES.map(([k, l]) => [k, t(l as 'fsSizeAny')]), ui.size, (k) => { ui.size = k; changed(); }));
    const dateChip = menuChip(ui.date === 'any' ? t('fsDate') : t(dt[1] as 'fsDateAny'), ui.date !== 'any', 'calendar', (ev) => choose(ev, t('fsDate'), DATES.map(([k, l]) => [k, t(l as 'fsDateAny')]), ui.date, (k) => { ui.date = k; changed(); }));
    const sortChip = menuChip(t(so[1] as 'fsSortRelevance'), ui.sort !== 'relevance' || ui.desc, ui.desc ? 'arrowDown' : 'sort', (ev) => {
      // (The order: the same choice again turns it round, as the folder's own sort does.)
      choose(ev, t('fsSort'), SORTS.map(([k, l]) => [k, t(l as 'fsSortRelevance') + (k === ui.sort && k !== 'relevance' ? (ui.desc ? ' ↓' : ' ↑') : '')]), ui.sort, (k) => { if (k === ui.sort && k !== 'relevance') ui.desc = !ui.desc; else { ui.sort = k; ui.desc = k === 'size' || k === 'date'; } changed(); });
    }); sortChip.classList.add('fs-sort');
    const filtered = ui.kinds.length || ui.size !== 'any' || ui.date !== 'any';
    chips.replaceChildren(...kindChips, h('span', { class: 'fs-sep', 'aria-hidden': 'true' }), sizeChip, dateChip, sortChip,
      ...(filtered ? [h('button', { type: 'button', class: 'chip small fs-chip fs-clear', onclick: () => clearFilters() }, icon('close'), h('span', null, t('fsClearFilters')))] : []));
  };
  const clearFilters = () => { ui.kinds = []; ui.size = 'any'; ui.date = 'any'; changed(); };
  const filtersOn = () => ui.kinds.length > 0 || ui.size !== 'any' || ui.date !== 'any';
  const changed = () => { saveUi(ui); drawChips(); limit = FIRST; void search(); };

  // ---- the list (virtual: only the rows in sight, and a few around them, are in the page)
  const rows = new Map<number, HTMLElement>(); let words: string[] = [];
  const rowOf = (i: number): HTMLElement => {
    const x = hits[i]; const e = entryOf(x);
    const showIn = iconButton('folder', t('fsShowInFolder'), (ev) => { ev.stopPropagation(); showInFolder(x); }); showIn.classList.add('fs-show');
    const moreBtn = iconButton('more', t('more'), (ev) => { ev.stopPropagation(); ctx.menu(e, ev); }); moreBtn.classList.add('fs-more');
    const r = h('div', { class: 'fs-row' + (i === active ? ' active' : ''), role: 'option', 'aria-selected': String(i === active), dataset: { i: String(i) }, style: { top: `${i * ROW_H}px` },
      onclick: () => { active = i; openHit(x); }, oncontextmenu: (ev: MouseEvent) => { ev.preventDefault(); ctx.menu(e, ev); } },
      h('span', { class: `fs-ic k-${x.kind}` }, icon(KIND_ICON[x.kind] ?? 'file')),
      // (Each line a block in the page's direction holding the isolated name or folder: it starts where the row starts,
      // whichever way the name itself runs.)
      h('span', { class: 'fs-main' }, h('span', { class: 'fs-l1' }, h('bdi', { class: 'fs-name', title: x.name }, ...marked(x.name, words))), h('span', { class: 'fs-l2' }, h('bdi', { class: 'fs-dir', dir: 'ltr', title: x.dir }, x.dir))),
      h('bdi', { class: 'fs-size' }, x.folder ? '' : formatBytes(x.size)),
      h('bdi', { class: 'fs-date', title: formatDate(x.mtime) }, formatDateShort(x.mtime)),
      showIn, moreBtn);
    return r;
  };
  let raf = 0;
  const paint = () => {
    raf = 0; if (gone) return;
    const vh = scroller.clientHeight || 600; const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_H) - 6); const last = Math.min(hits.length - 1, Math.ceil((scroller.scrollTop + vh) / ROW_H) + 6);
    for (const [i, r] of rows) if (i < first || i > last) { r.remove(); rows.delete(i); }
    for (let i = first; i <= last; i++) if (!rows.has(i)) { const r = rowOf(i); rows.set(i, r); space.append(r); }
    // (Near the end of what came: more asked for, the same search with a larger limit.)
    if (last >= hits.length - 30 && hits.length < Math.min(total, CAP) && !more && hits.length) { more = true; limit = Math.min(CAP, Math.max(limit * 4, hits.length + FIRST)); void search(true); }
  };
  const repaint = (all = false) => { if (all) { for (const r of rows.values()) r.remove(); rows.clear(); } if (!raf) raf = requestAnimationFrame(paint); };
  const onScroll = () => repaint();
  scroller.addEventListener('scroll', onScroll, { passive: true });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => repaint()) : null; ro?.observe(scroller);
  const setActive = (i: number) => {
    if (!hits.length) return; active = Math.max(0, Math.min(hits.length - 1, i));
    const y = active * ROW_H; if (y < scroller.scrollTop) scroller.scrollTop = y; else if (y + ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + ROW_H - scroller.clientHeight;
    for (const [k, r] of rows) { r.classList.toggle('active', k === active); r.setAttribute('aria-selected', String(k === active)); }
    repaint();
  };
  const onListKeys = (ev: KeyboardEvent) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive(active + 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (active <= 0) { active = -1; repaint(true); input.focus(); } else setActive(active - 1); }
    else if (ev.key === 'PageDown' || ev.key === 'PageUp') { ev.preventDefault(); const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_H) - 1); setActive(active + (ev.key === 'PageDown' ? page : -page)); }
    else if (ev.key === 'Enter' && hits[active]) { ev.preventDefault(); openHit(hits[active]); }
    else if ((ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) && hits[active]) { ev.preventDefault(); const r = rows.get(active); const b = r?.getBoundingClientRect(); ctx.menu(entryOf(hits[active]), b ? ({ clientX: b.left + 40, clientY: b.bottom, type: 'keyboard', currentTarget: r } as unknown as Event) : ev); }
  };
  scroller.addEventListener('keydown', onListKeys);
  const onInputKeys = (ev: KeyboardEvent) => {
    if (ev.key === 'ArrowDown' && hits.length) { ev.preventDefault(); scroller.focus(); setActive(0); }
    else if (ev.key === 'Enter' && hits.length) { ev.preventDefault(); openHit(hits[Math.max(0, active)]); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (input.value) { input.value = ''; onType(); } else close(); }
  };
  input.addEventListener('keydown', onInputKeys);
  const onType = () => { clearTimeout(debounce); limit = FIRST; debounce = window.setTimeout(() => void search(), 60); };
  input.addEventListener('input', onType);

  const openHit = (x: Hit) => { if (x.folder) { close(); ctx.go(x.path); return; } ctx.open(entryOf(x)); };
  const showInFolder = (x: Hit) => { close(); ctx.go(x.dir); };

  // ---- what shows: the hits, or why there are none
  const ready = () => !!st && st.roots.length > 0;
  const indexing = () => !!st && st.busy && st.roots.some((r) => !r.walked);
  const drawState = () => {
    if (gone) return;
    const text = input.value.trim(); const asked = !!text || filtersOn();
    // (The banner: still looking through, paused, or the index's own word.)
    const bits: (Node | string)[] = [];
    if (st && st.busy && ready()) bits.push(h('span', { class: 'fs-spin', 'aria-hidden': 'true' }), h('span', null, `${t('fsIndexing')} ${t('fsIndexingCount', { n: num(st.progress.entries) })}`));
    if (st && (st.paused || st.batteryPaused) && st.busy) bits.push(h('span', { class: 'fs-paused' }, st.batteryPaused ? t('fsPausedBattery') : t('fsPaused')), ...(st.paused ? [h('button', { type: 'button', class: 'btn text small', onclick: () => void br.fileSearchPause({ paused: false }).then((s) => { st = s; drawState(); schedule(); }) }, t('fsResume'))] : []));
    const note = noteText(st?.note ?? null); if (note && !bits.length) bits.push(h('span', null, note));
    banner.replaceChildren(...bits); banner.hidden = !bits.length || !asked;
    const card = (ic: string, title: string, hint: string, btn?: HTMLElement) => empty.replaceChildren(h('div', { class: 'fs-card' }, h('span', { class: 'fs-card-ic' }, icon(ic)), h('h3', null, title), h('p', { class: 'hint' }, hint), btn ?? null));
    let showEmpty = true;
    if (!st) empty.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner small' })));
    else if (!ready()) card('folderPlus', t('fsChooseTitle'), t('fsChooseHint'), h('button', { type: 'button', class: 'btn primary fs-choose', onclick: () => manageSheet() }, icon('plus'), t('fsChooseBtn')));
    else if (!asked && indexing()) card('refresh', t('fsIndexing'), t('fsIndexingCount', { n: num(st.progress.entries) }));
    else if (!asked) card('search', t('fsEverywhere'), t('fsReadyHint', { n: num(st.entries) }));
    else if (!hits.length && shownText === key()) { card('search', t('fsNoResults', { q: text || '…' }), t('fsNoResultsHint'), filtersOn() ? h('button', { type: 'button', class: 'btn tonal', onclick: () => clearFilters() }, t('fsClearFilters')) : undefined); }
    else showEmpty = !hits.length;
    if (showEmpty && st && ready() && asked && !hits.length && shownText !== key()) empty.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner small' })));
    empty.hidden = !showEmpty; scroller.hidden = showEmpty;
    empty.classList.toggle('indexing', !!st && !asked && indexing());
    line.replaceChildren(...(asked && hits.length ? [h('span', null, total > hits.length ? t('fsShowing', { n: num(hits.length), total: num(total) }) : t('fsCount', { n: num(total) })), h('small', { class: 'fs-took' }, t('fsTook', { ms: localDigits((micros / 1000).toFixed(micros < 10_000 ? 1 : 0)) }))] : []));
    line.hidden = !(asked && hits.length);
  };
  const key = () => JSON.stringify([input.value.trim(), ui]);

  // ---- asking the shell
  const search = async (keepScroll = false) => {
    const my = ++seq; const text = input.value.trim(); const k = key();
    if (!ready() || (!text && !filtersOn())) { hits = []; total = 0; shownText = k; more = false; repaint(true); space.style.height = '0px'; drawState(); return; }
    words = markWords(text); drawState();
    let r: Res;
    try { r = await br.fileSearch(buildQuery(text, ui, limit)); } catch { if (my === seq) { more = false; } return; }
    if (gone || my !== seq || r.cancelled) return;
    if (r.idle) { more = false; await refresh(); return; }
    hits = r.hits ?? []; total = r.total ?? hits.length; micros = r.micros ?? 0; shownText = k; more = false;
    if (!keepScroll) { scroller.scrollTop = 0; active = -1; }
    space.style.height = `${hits.length * ROW_H}px`; repaint(true); drawState();
  };
  const refresh = async () => {
    try { st = await br.fileSearchStatus(); } catch { st = st ?? null; }
    if (gone) return; drawState(); schedule();
  };
  // (While the folders are looked through: the state read again now and then, and the search asked again so new
  // finds appear; nothing runs once it is done.)
  const schedule = () => { clearTimeout(poll); if (gone || !st || !st.busy) return; poll = window.setTimeout(() => { void refresh().then(() => { if (!gone && (input.value.trim() || filtersOn())) void search(true); }); }, 900); };

  // ---- the folders to search
  const manageSheet = () => {
    const sh = openSheet(t('fsManage'), t('close'), { onClose: () => { if (!gone) void refresh().then(() => void search()); } });
    sh.el.classList.add('fs-sheet');
    const draw = (s: Status) => {
      if (!sh.el.isConnected) return; st = s;
      const rootRow = (r: RootSt) => h('div', { class: 'fs-root' },
        h('div', { class: 'fs-root-head' }, h('span', { class: 'fs-root-ic' }, icon('folder')),
          h('span', { class: 'fs-root-main' }, h('bdi', { class: 'fs-root-path', dir: 'ltr', title: r.path }, r.path), h('small', { class: 'src' }, r.walked || r.entries ? t('fsEntries', { n: num(r.entries) }) : t('fsNotYet'), r.unreadable ? ` · ${t('fsUnreadable', { n: num(r.unreadable) })}` : '')),
          h('span', { class: 'fs-root-acts' },
            h('button', { type: 'button', class: 'btn tonal small fs-exclude', onclick: () => void exclude(r.path) }, t('fsExclude')),
            h('button', { type: 'button', class: 'btn danger small fs-remove', onclick: () => void br.fileSearchRemove({ path: r.path }).then(() => reread()) }, t('fsRemoveFolder')))),
        r.exclude.length ? h('div', { class: 'fs-excl' }, h('small', { class: 'fs-excl-title' }, t('fsExcluded')), ...r.exclude.map((x) => h('div', { class: 'fs-excl-row' }, icon('eyeOff'), h('bdi', { dir: 'ltr', class: 'grow', title: x }, x), h('button', { type: 'button', class: 'btn text small', onclick: () => void br.fileSearchExclude({ root: r.path, path: x, remove: true }).then(() => reread()) }, t('fsTakeBack'))))) : null);
      const sw = (label: string, hint: string | null, on: boolean, set: (v: boolean) => void, cls: string) => { const i = h('input', { type: 'checkbox', role: 'switch', checked: on, onchange: () => set(i.checked) }) as HTMLInputElement; return h('label', { class: `switch-row fs-switch ${cls}` }, h('span', { class: 'grow' }, label, hint ? h('small', null, hint) : null), i); };
      const facts = s.roots.length ? h('p', { class: 'fs-facts hint' }, h('bdi', null, t('fsEntries', { n: num(s.entries) })), ' · ', h('bdi', null, t('fsIndexSize', { size: formatBytes(s.fileBytes) })), ' · ', h('bdi', null, t('fsMemory', { size: formatBytes(s.memory) }))) : null;
      sh.body.replaceChildren(
        h('h4', { class: 'section-title' }, t('fsFolders')),
        s.roots.length ? h('div', { class: 'fs-roots' }, ...s.roots.map(rootRow)) : h('p', { class: 'hint' }, t('fsChooseHint')),
        h('button', { type: 'button', class: 'btn tonal fs-add', onclick: () => void add() }, icon('folderPlus'), t('fsAddFolder')),
        ...(facts ? [facts] : []), ...(s.note ? [h('p', { class: 'hint' }, noteText(s.note))] : []),
        sw(t('fsPauseSwitch'), t('fsPauseHint'), s.paused, (v) => void br.fileSearchPause({ paused: v }).then(draw), 'fs-pause'),
        sw(t('fsBatterySwitch'), null, s.pauseOnBattery, (v) => void br.fileSearchPause({ pauseOnBattery: v }).then(draw), 'fs-battery'));
      sh.actions.replaceChildren(h('div', { class: 'fs-sheet-btns' },
        h('button', { type: 'button', class: 'btn tonal fs-rebuild', disabled: !s.roots.length, onclick: () => void br.fileSearchRebuild().then(() => { toast(t('fsRebuilt')); reread(); }) }, icon('refresh'), t('fsRebuild')),
        h('button', { type: 'button', class: 'btn danger fs-forget', disabled: !s.roots.length && !s.fileBytes, onclick: () => forget() }, icon('trash'), t('fsForget'))));
    };
    const reread = () => void br.fileSearchStatus().then(draw).catch(() => undefined);
    const add = async () => {
      const p = await br.pickDir().catch(() => null); if (!p || !sh.el.isConnected) return;
      const r = await br.fileSearchAdd({ path: p }).catch(() => ({ ok: false, reason: 'missing' }) as Refused);
      if (!r.ok) { toast(refusalText(r), 'error', 5000); return; }
      toast(t('fsAdded', { name: iso(p) })); reread();
    };
    const exclude = async (root: string) => {
      const p = await br.pickDir().catch(() => null); if (!p || !sh.el.isConnected) return;
      const r = await br.fileSearchExclude({ root, path: p }).catch(() => ({ ok: false, reason: 'outside' }) as Refused);
      if (!r.ok) { toast(refusalText(r, root), 'error', 5000); return; } reread();
    };
    const forget = () => {
      const ask = openSheet(t('fsForget'), t('cancel'), { stack: true });
      ask.body.append(h('p', null, t('fsForgetAsk')));
      ask.actions.append(h('div', { class: 'fs-sheet-btns' }, h('button', { type: 'button', class: 'btn tonal', onclick: () => ask.close() }, t('cancel')), h('button', { type: 'button', class: 'btn danger fs-forget-go', onclick: () => { ask.close(); void br.fileSearchForget().then(() => { toast(t('fsForgotten')); hits = []; total = 0; reread(); }); } }, t('fsForgetGo'))));
    };
    if (st) draw(st); else sh.body.append(h('div', { class: 'center' }, h('div', { class: 'spinner small' })));
    reread();
  };

  // ---- life
  const close = () => { if (gone) return; dispose(); el.remove(); host.classList.remove('fs-on'); ctx.onClose(); };
  function dispose() {
    if (gone) return; gone = true; seq++;
    clearTimeout(debounce); clearTimeout(poll); clearTimeout(focusT); if (raf) cancelAnimationFrame(raf); raf = 0;
    scroller.removeEventListener('scroll', onScroll); scroller.removeEventListener('keydown', onListKeys); input.removeEventListener('keydown', onInputKeys); input.removeEventListener('input', onType); ro?.disconnect();
    rows.clear();
  }
  drawChips(); drawState(); void refresh();
  focusT = window.setTimeout(() => { if (!gone) input.focus(); }, 30);
  return { el, focus: () => { input.focus(); input.select(); }, close, dispose };
}
