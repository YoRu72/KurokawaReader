// The Downloads page's options, the way the reader's Library sheet has them (Mihon's Filter · Sort · Display in
// one place), with what matters for downloads: filters by state, kind, category and size; sorting by when added,
// name, size, progress, speed or time left (a second tap turns the order round); and the look — comfortable,
// compact or names only — grouped by state, category or day, with the details each card shows.
import { h, icon, openSheet } from '../ui/dom';
import { t } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { displayName } from '../engine';
import type { Task, TaskState } from '../engine/types';
import { allCategories, categoryOf, categoryName } from '../downloads/categories';

export type DlSort = 'queue' | 'added' | 'name' | 'size' | 'state' | 'progress' | 'speed' | 'eta';
export type DlLook = 'comfortable' | 'compact' | 'minimal';
export type DlGroup = 'none' | 'state' | 'category' | 'day';
export interface DlPrefs {
  states: string[]; kinds: string[]; cats: string[]; sizes: string[];
  desc: boolean; look: DlLook; group: DlGroup; activeFirst: boolean;
  show: { speed: boolean; eta: boolean; peers: boolean; size: boolean };
}
export const DL_DEFAULT: DlPrefs = { states: [], kinds: [], cats: [], sizes: [], desc: true, look: 'comfortable', group: 'none', activeFirst: false, show: { speed: true, eta: true, peers: true, size: true } };
export const dlPrefs = (): DlPrefs => { const p = getSettings().dl as Partial<DlPrefs> | undefined; return { ...DL_DEFAULT, ...p, show: { ...DL_DEFAULT.show, ...p?.show } }; };
const setDl = (o: Partial<DlPrefs>) => updateSettings({ dl: { ...dlPrefs(), ...o } });

const STATE_GROUPS: [string, string, TaskState[]][] = [['downloading', 'stateDownloading', ['downloading', 'metadata', 'checking']], ['queued', 'stateQueued', ['queued']], ['paused', 'statePaused', ['paused']], ['seeding', 'stateSeeding', ['seeding']], ['done', 'stateDone', ['done']], ['failed', 'stateFailed', ['failed']]];
const KINDS: [string, string, string][] = [['torrent', 'kindTorrent', 'magnet'], ['http', 'kindHttp', 'link'], ['video', 'kindVideo', 'film'], ['debrid', 'kindDebrid', 'cloud']];
const SIZES: [string, string, (n: number) => boolean][] = [['s', 'sizeSmall', (n) => n > 0 && n < 100 * 1048576], ['m', 'sizeMedium', (n) => n >= 100 * 1048576 && n < 1073741824], ['l', 'sizeLarge', (n) => n >= 1073741824]];
const SORTS: [DlSort, string, string][] = [['queue', 'sortQueue', 'list'], ['added', 'sort_added', 'clock'], ['name', 'sort_name', 'type'], ['size', 'sort_size', 'archive'], ['progress', 'sortProgress', 'chart'], ['speed', 'sortSpeed', 'flash'], ['eta', 'sortEta', 'calendar'], ['state', 'sort_state', 'filter']];
const catOf = (x: Task) => categoryOf(displayName(x), x.kind);
const kindOf = (x: Task) => (x.meta as { kind?: string } | undefined)?.kind === 'video' ? 'video' : x.kind;
const ACTIVE: TaskState[] = ['downloading', 'metadata', 'checking', 'queued', 'seeding'];

/** How many filters are in force (for the badge on the options button). */
export const activeFilters = (p = dlPrefs()): number => p.states.length + p.kinds.length + p.cats.length + p.sizes.length;
export function applyFilters(tasks: Task[], q: string): Task[] {
  const p = dlPrefs(); const needle = q.trim().toLowerCase();
  const states = new Set(STATE_GROUPS.filter(([id]) => p.states.includes(id)).flatMap(([, , s]) => s));
  return tasks.filter((x) => (!states.size || states.has(x.state)) && (!p.kinds.length || p.kinds.includes(kindOf(x))) && (!p.cats.length || p.cats.includes(catOf(x).id))
    && (!p.sizes.length || SIZES.some(([id, , ok]) => p.sizes.includes(id) && ok(x.total || 0))) && (!needle || displayName(x).toLowerCase().includes(needle)));
}
const ORDER: Record<TaskState, number> = { downloading: 0, metadata: 1, checking: 2, queued: 3, seeding: 4, paused: 5, failed: 6, done: 7 };
export function sortTasks(list: Task[]): Task[] {
  const k = getSettings().sort as DlSort; const p = dlPrefs(); const dir = p.desc ? -1 : 1;
  const prog = (x: Task) => (x.total > 0 ? x.done / x.total : x.state === 'done' ? 1 : 0);
  const eta = (x: Task) => (x.eta && x.eta > 0 ? x.eta : x.state === 'done' ? 0 : Infinity);
  const pos = new Map(list.map((x, i) => [x.id, i]));
  const by: Record<DlSort, (a: Task, b: Task) => number> = {
    queue: (a, b) => ((pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0)) * dir,
    added: (a, b) => (a.addedAt - b.addedAt) * dir, name: (a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true }) * dir,
    size: (a, b) => ((a.total || 0) - (b.total || 0)) * dir, progress: (a, b) => (prog(a) - prog(b)) * dir, speed: (a, b) => ((a.downSpeed || 0) - (b.downSpeed || 0)) * dir,
    eta: (a, b) => (eta(a) === eta(b) ? 0 : eta(a) < eta(b) ? -1 : 1) * dir, state: (a, b) => (ORDER[a.state] - ORDER[b.state]) * -dir || b.addedAt - a.addedAt,
  };
  const out = [...list].sort(by[k] ?? by.added);
  return p.activeFirst ? out.sort((a, b) => Number(ACTIVE.includes(b.state)) - Number(ACTIVE.includes(a.state))) : out;
}
/** The heading a task goes under, when the list is grouped. */
export function groupOf(x: Task, g: DlGroup): { key: string; label: string } | null {
  if (g === 'state') { const s = STATE_GROUPS.find(([, , st]) => st.includes(x.state)) ?? STATE_GROUPS[0]; return { key: s[0], label: t(s[1] as 'stateDone') }; }
  if (g === 'category') { const c = catOf(x); return { key: c.id, label: categoryName(c) }; }
  if (g === 'day') {
    const d = new Date(x.addedAt); const today = new Date(); const day = (v: Date) => new Date(v.getFullYear(), v.getMonth(), v.getDate()).getTime(); const diff = Math.round((day(today) - day(d)) / 86400000);
    const label = diff === 0 ? t('dayToday') : diff === 1 ? t('dayYesterday') : diff < 7 ? t('dayThisWeek') : diff < 31 ? t('dayThisMonth') : new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(d);
    return { key: diff < 7 ? `d${Math.min(diff, 2)}` : diff < 31 ? 'm' : `${d.getFullYear()}-${d.getMonth()}`, label };
  }
  return null;
}

/** The sheet: Filter · Sort · Display. `changed` redraws the list behind it as each option is touched. */
export function downloadsOptionsSheet(tasks: Task[], changed: () => void, tab: 'filter' | 'sort' | 'display' = 'filter'): void {
  const sh = openSheet(t('dlOptions'), t('close'));
  const tabs = h('div', { class: 'segmented lib-sheet-tabs' }); const panel = h('div', { class: 'lib-sheet-panel' });
  const draw = (which: typeof tab) => {
    tabs.replaceChildren(...(['filter', 'sort', 'display'] as const).map((id) => h('button', { type: 'button', 'aria-pressed': String(id === which), onclick: () => draw(id) }, t(id === 'filter' ? 'filters' : id === 'sort' ? 'sortBy' : 'displayMode'))));
    panel.replaceChildren();
    const row = (label: string, on: boolean, click: () => void, ic?: string, trail?: string) => h('button', { type: 'button', class: 'lib-opt' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: () => { click(); draw(which); changed(); } }, ic ? icon(ic) : h('span', { class: 'lib-opt-check' }, on ? icon('check') : null), h('span', { class: 'grow' }, label), trail ? h('small', null, trail) : null);
    const toggleIn = (key: 'states' | 'kinds' | 'cats' | 'sizes', id: string) => { const p = dlPrefs(); const cur = new Set(p[key]); if (cur.has(id)) cur.delete(id); else cur.add(id); setDl({ [key]: [...cur] }); };
    const count = (f: (x: Task) => boolean) => String(tasks.filter(f).length);
    const p = dlPrefs();
    if (which === 'filter') {
      panel.append(h('h4', null, t('dlState')));
      for (const [id, label, st] of STATE_GROUPS) if (tasks.some((x) => st.includes(x.state)) || p.states.includes(id)) panel.append(row(t(label as 'stateDone'), p.states.includes(id), () => toggleIn('states', id), undefined, count((x) => st.includes(x.state))));
      const kinds = KINDS.filter(([id]) => tasks.some((x) => kindOf(x) === id) || p.kinds.includes(id));
      if (kinds.length > 1) { panel.append(h('h4', null, t('dlKind'))); for (const [id, label, ic] of kinds) panel.append(row(t(label as 'kindTorrent'), p.kinds.includes(id), () => toggleIn('kinds', id), p.kinds.includes(id) ? 'check' : ic, count((x) => kindOf(x) === id))); }
      const cats = allCategories().filter((c) => tasks.some((x) => catOf(x).id === c.id) || p.cats.includes(c.id));
      if (cats.length > 1) { panel.append(h('h4', null, t('dlCategory'))); for (const c of cats) panel.append(row(categoryName(c), p.cats.includes(c.id), () => toggleIn('cats', c.id), p.cats.includes(c.id) ? 'check' : c.icon, count((x) => catOf(x).id === c.id))); }
      panel.append(h('h4', null, t('dlSize'))); for (const [id, label, ok] of SIZES) panel.append(row(t(label as 'sizeSmall'), p.sizes.includes(id), () => toggleIn('sizes', id), undefined, count((x) => ok(x.total || 0))));
      if (activeFilters(p)) panel.append(h('button', { type: 'button', class: 'btn tonal small', onclick: () => { setDl({ states: [], kinds: [], cats: [], sizes: [] }); draw(which); changed(); } }, icon('close'), t('clearFilters')));
    } else if (which === 'sort') {
      const cur = getSettings().sort as DlSort;
      for (const [id, label, ic] of SORTS) panel.append(row(t(label as 'sort_added'), cur === id, () => { if (cur === id) setDl({ desc: !p.desc }); else { updateSettings({ sort: id as 'added' }); setDl({ desc: id !== 'name' && id !== 'eta' && id !== 'queue' }); } }, cur === id ? 'sort' : ic, cur === id ? (p.desc ? t('sortDescending') : t('sortAscending')) : undefined));
      panel.append(row(t('dlActiveFirst'), p.activeFirst, () => setDl({ activeFirst: !p.activeFirst })));
      panel.append(h('p', { class: 'hint' }, t('sortDirHint')));
    } else {
      panel.append(h('h4', null, t('displayMode')));
      for (const [id, label] of [['comfortable', t('lookComfortable')], ['compact', t('lookCompact')], ['minimal', t('dlLookMinimal')]] as [DlLook, string][]) panel.append(row(label, p.look === id, () => setDl({ look: id })));
      panel.append(h('h4', null, t('dlGroupBy')));
      for (const [id, label] of [['none', t('dlGroupNone')], ['state', t('dlState')], ['category', t('dlCategory')], ['day', t('dlGroupDay')]] as [DlGroup, string][]) panel.append(row(label, p.group === id, () => setDl({ group: id })));
      panel.append(h('h4', null, t('dlShow')));
      for (const [k, label] of [['speed', t('dlShowSpeed')], ['eta', t('dlShowEta')], ['size', t('dlShowSize')], ['peers', t('dlShowPeers')]] as [keyof DlPrefs['show'], string][]) panel.append(row(label, p.show[k], () => setDl({ show: { ...p.show, [k]: !p.show[k] } })));
    }
  };
  sh.body.append(tabs, panel); draw(tab);
}
