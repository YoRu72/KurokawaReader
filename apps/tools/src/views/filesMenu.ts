// The phone's Files menus, loaded on first use: the header's ⋮ as ONE sheet (View, Sort, Show, This folder, Tools),
// a folder's own sort (kept for the last 200 folders), and the search that goes down into the sub-folders.
import { h, icon, openSheet } from '../ui/dom';
import { t, countItems } from '../i18n';
import type { Entry, Prefs, SortSet } from './files';

const SORTS = 'kt.files.sorts'; const MAX_SORTS = 200;
type Act = { ic: string; label: string; run: () => void };
export type MenuCtx = {
  prefs: Prefs; savePrefs: () => void; at: string; setOver: (o: SortSet | null) => void;
  /** What changed: the list behind is drawn again (the view also restyles the other pane; hidden files read the folder again). */
  redraw: (what: 'view' | 'rows' | 'sort' | 'hidden' | 'show') => void;
  folder: Act[]; tools: Act[]; more: Act[];
};

const readSorts = (): Record<string, SortSet> => { try { return JSON.parse(localStorage.getItem(SORTS) ?? '{}') as Record<string, SortSet>; } catch { return {}; } };
/** A folder's own sort kept (or, with null, let go); the store holds the last 200 folders, the oldest going first. */
export function saveFolderSort(path: string, o: SortSet | null): void {
  const all = readSorts(); delete all[path]; if (o) all[path] = o;
  const keys = Object.keys(all); for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SORTS))) delete all[k];
  try { localStorage.setItem(SORTS, JSON.stringify(all)); } catch { /* none */ }
}

export function moreMenu(c: MenuCtx): void {
  const { prefs } = c; const sh = openSheet(t('navFiles'), t('close')); sh.el.classList.add('files-menu');
  const label = (text: string) => h('small', { class: 'src files-menu-label' }, text);
  const seg = <T extends string>(opts: [T, string, string][], cur: () => T, set: (v: T) => void, name: string): HTMLElement => {
    const row = h('div', { class: 'segmented', role: 'group', 'data-seg': name });
    const paint = () => row.replaceChildren(...opts.map(([v, text, ic]) => h('button', { type: 'button', 'aria-pressed': String(cur() === v), 'data-v': v, onclick: () => { set(v); paint(); } }, ...(ic ? [icon(ic)] : []), h('span', null, text))));
    paint(); return row;
  };
  const sw = (text: string, get: () => boolean, set: (v: boolean) => void, name: string): HTMLElement => { const i = h('input', { type: 'checkbox', checked: get(), 'data-sw': name, onchange: () => set(i.checked) }) as HTMLInputElement; return h('label', { class: 'switch-row files-menu-sw' }, h('span', { class: 'grow' }, text), i); };
  const rows = (acts: Act[], close: boolean) => h('div', { class: 'dest-list files-menu-rows' }, ...acts.map((a) => h('button', { type: 'button', class: 'dest-row', onclick: () => { if (close) sh.close(); a.run(); } }, icon(a.ic), h('span', { class: 'name' }, a.label))));

  // View: list / grid / gallery, and the rows of a list.
  const rowsSeg = seg<'compact' | 'comfortable'>([['compact', t('filesCompact'), ''], ['comfortable', t('filesComfortable'), '']], () => (prefs.density === 'comfortable' ? 'comfortable' : 'compact'), (v) => { prefs.density = v; c.savePrefs(); c.redraw('rows'); }, 'rows');
  const rowsBox = h('div', { class: 'files-menu-sub' }, h('small', { class: 'src' }, t('filesRowsDensity')), rowsSeg);
  const syncRows = () => { rowsBox.hidden = prefs.view !== 'list'; };
  const viewSeg = seg<Prefs['view']>([['list', t('fmList'), 'list'], ['grid', t('fmGrid'), 'grid'], ['gallery', t('fmGallery'), 'images']], () => prefs.view, (v) => { prefs.view = v; c.savePrefs(); syncRows(); c.redraw('view'); }, 'view'); syncRows();

  // Sort: the active chip flips the direction; «Remember for this folder» keeps it for this folder only.
  let per = !!readSorts()[c.at];
  const cur = (): SortSet => (per ? readSorts()[c.at] ?? { sort: prefs.sort, desc: prefs.desc, ff: prefs.foldersFirst !== false } : { sort: prefs.sort, desc: prefs.desc, ff: prefs.foldersFirst !== false });
  const put = (o: SortSet) => { if (per) { saveFolderSort(c.at, o); c.setOver(o); } else { prefs.sort = o.sort; prefs.desc = o.desc; prefs.foldersFirst = o.ff; c.savePrefs(); } c.redraw('sort'); };
  const sortRow = h('div', { class: 'segmented', role: 'group', 'data-seg': 'sort' });
  const paintSort = () => sortRow.replaceChildren(...([['name', t('fmName')], ['date', t('fmDate')], ['size', t('fmSize')], ['type', t('fmType')]] as [Prefs['sort'], string][]).map(([k, text]) => { const s = cur(); const on = s.sort === k; return h('button', { type: 'button', 'aria-pressed': String(on), 'data-v': k, onclick: () => { const x = cur(); put(on ? { ...x, desc: !x.desc } : { ...x, sort: k, desc: false }); paintSort(); } }, h('span', null, text), ...(on ? [icon(s.desc ? 'arrowDown' : 'arrowUp')] : [])); }));
  paintSort();
  const ffSw = sw(t('fmFoldersFirst'), () => cur().ff, (v) => { put({ ...cur(), ff: v }); }, 'ff');
  const perSw = sw(t('fmRemember'), () => per, (v) => { const x = cur(); per = v; if (v) { saveFolderSort(c.at, x); c.setOver(x); } else { saveFolderSort(c.at, null); c.setOver(null); } c.redraw('sort'); paintSort(); }, 'per');

  sh.body.append(
    label(t('fmView')), viewSeg, rowsBox,
    label(t('fmSort')), sortRow, ffSw, perSw,
    label(t('fmShow')),
    sw(t('fmHidden'), () => !!prefs.hidden, (v) => { prefs.hidden = v; c.savePrefs(); c.redraw('hidden'); }, 'hidden'),
    sw(t('fmCounts'), () => prefs.counts !== false, (v) => { prefs.counts = v; c.savePrefs(); c.redraw('show'); }, 'counts'),
    sw(t('filesShowThumbs'), () => prefs.thumbs !== false, (v) => { prefs.thumbs = v; c.savePrefs(); c.redraw('show'); }, 'thumbs'),
    label(t('fmFolder')), rows(c.folder, true),
    ...(c.tools.length ? [label(t('fmTools')), rows(c.tools, true)] : []),
    ...(c.more.length ? [label(t('fmMore')), rows(c.more, true)] : []));
}

/** The search of a folder taken down into its sub-folders: the phone's own search, results streamed in a few at a time, each
 *  with the folder it lies in under its name. Returns what stops it. */
export function subSearch(host: HTMLElement, o: { at: string; q: string; hidden: boolean; find: (o: { path: string; q: string; hidden: boolean }) => Promise<{ entries: Entry[] }>; open: (e: Entry) => void; goTo: (dir: string) => void }): () => void {
  let stopped = false; let raf = 0; const status = h('p', { class: 'hint' }, t('loading')); host.replaceChildren(status);
  void o.find({ path: o.at, q: o.q, hidden: o.hidden }).then((r) => {
    if (stopped) return; const got = (r.entries ?? []).slice(0, 400); status.textContent = got.length ? `${countItems(got.length)}${(r.entries ?? []).length >= 400 ? ' · ' + t('filesSearchCapped') : ''}` : t('filesNothingMatches');
    const list = h('div', { class: 'files-list list files-results' }); host.append(list); let i = 0;
    const step = () => { raf = 0; if (stopped) return; for (const e of got.slice(i, i + 40)) { const dir = e.path.slice(0, e.path.length - e.name.length - 1); const rel = dir.startsWith(o.at) ? dir.slice(o.at.length).replace(/^\/+/, '') || '.' : dir; list.append(h('div', { class: 'files-row files-subrow', role: 'button', tabindex: '0', onclick: () => o.open(e) }, h('span', { class: 'files-ic' }, icon(e.dir ? 'folder' : 'file')), h('span', { class: 'grow files-main' }, h('span', { class: 'files-name', dir: 'auto' }, e.name), h('small', { class: 'src', dir: 'ltr' }, rel)), h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('filesShowInFolder'), onclick: (ev: Event) => { ev.stopPropagation(); o.goTo(dir); } }, icon('folder')))); } i += 40; if (i < got.length) raf = requestAnimationFrame(step); };
    step();
  }).catch((err) => { if (!stopped) status.textContent = String((err as Error).message ?? err); });
  return () => { stopped = true; if (raf) cancelAnimationFrame(raf); };
}
