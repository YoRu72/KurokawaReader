// Things a bar shows, each switched on or off, in an order, at one of three places along the bar (its start, its
// centre or its end — mirrored in a right-to-left interface). The reading bar's items use it (src/ui/readbar.ts); the
// model and its editor know nothing of what the items are, so another bar's can use them too.
import { h, icon } from './dom';
import { t } from '../i18n';

export type ItemPlace = 'start' | 'center' | 'end';
export interface PlacedItem { id: string; on: boolean; at: ItemPlace }

/** A saved list made whole: unknown ids left out, each id once, every known id present (one added since the list was
 *  saved comes in off, at its default place), the places valid. Nothing kept is lost. */
export function normalizePlaced(saved: unknown, defaults: readonly PlacedItem[]): PlacedItem[] {
  const known = new Map(defaults.map((d) => [d.id, d]));
  const out: PlacedItem[] = []; const seen = new Set<string>();
  if (Array.isArray(saved)) for (const x of saved as Partial<PlacedItem>[]) {
    if (!x || typeof x.id !== 'string' || !known.has(x.id) || seen.has(x.id)) continue;
    seen.add(x.id);
    const at: ItemPlace = x.at === 'start' || x.at === 'center' || x.at === 'end' ? x.at : known.get(x.id)!.at;
    out.push({ id: x.id, on: x.on !== false, at });
  }
  else return defaults.map((d) => ({ ...d }));
  for (const d of defaults) if (!seen.has(d.id)) out.push({ ...d, on: false });
  return out;
}

/** The items switched on, in order, by place. */
export function placedGroups(items: readonly PlacedItem[]): Record<ItemPlace, string[]> {
  const g: Record<ItemPlace, string[]> = { start: [], center: [], end: [] };
  for (const it of items) if (it.on) g[it.at].push(it.id);
  return g;
}

/** An editor for such a list: a row per item — a switch, its name, where it goes (start · centre · end), and
 *  up / down to move it. `onChange` gets the whole new list. */
export function placedItemsEditor(items: readonly PlacedItem[], label: (id: string) => string, onChange: (items: PlacedItem[]) => void, opts: { sample?: (id: string) => string } = {}): HTMLElement {
  let cur = items.map((x) => ({ ...x }));
  const list = h('div', { class: 'placed-list', role: 'list' });
  const commit = () => { onChange(cur.map((x) => ({ ...x }))); render(); };
  const move = (i: number, d: -1 | 1) => { const j = i + d; if (j < 0 || j >= cur.length) return; [cur[i], cur[j]] = [cur[j], cur[i]]; commit(); list.querySelectorAll<HTMLElement>('.placed-row')[j]?.querySelector<HTMLElement>(d < 0 ? '.mv-up' : '.mv-down')?.focus(); };
  const places: [ItemPlace, string][] = [['start', t('placeStart')], ['center', t('placeCenter')], ['end', t('placeEnd')]];
  const render = () => {
    list.replaceChildren(...cur.map((it, i) => {
      const name = label(it.id); const sample = opts.sample?.(it.id);
      return h('div', { class: 'placed-row' + (it.on ? ' on' : ''), role: 'listitem', dataset: { id: it.id } },
        h('label', { class: 'placed-name' },
          h('input', { type: 'checkbox', checked: it.on, onchange: (e: Event) => { it.on = (e.target as HTMLInputElement).checked; commit(); } }),
          h('span', null, name, sample ? h('small', { dir: 'auto' }, sample) : null)),
        h('div', { class: 'placed-at', role: 'group', 'aria-label': t('placeOnBar') }, ...places.map(([p, pl]) => h('button', { type: 'button', 'aria-pressed': String(it.at === p), title: pl, 'aria-label': `${name}: ${pl}`, disabled: !it.on, onclick: () => { it.at = p; commit(); } },
          // (A small line of three marks, the one at this place filled: start · centre · end, mirrored right to left.)
          h('span', { class: 'place-glyph', 'aria-hidden': 'true' }, ...places.map(([q]) => h('span', { class: q === p ? 'on' : '' })))))),
        h('span', { class: 'row-actions' },
          h('button', { type: 'button', class: 'icon-btn mv-up', 'aria-label': `${t('moveUp')}: ${name}`, title: t('moveUp'), disabled: i === 0, onclick: () => move(i, -1) }, icon('chevronUp')),
          h('button', { type: 'button', class: 'icon-btn mv-down', 'aria-label': `${t('moveDown')}: ${name}`, title: t('moveDown'), disabled: i === cur.length - 1, onclick: () => move(i, 1) }, icon('chevronDown'))));
    }));
  };
  render();
  return list;
}

/** A list whose items each sit at one of several places, shown by place: a group per place (its name, its items in
 *  order), each row with the item's icon and name, a choice of place (a small picture of each), and up / down to move
 *  it within its place. Moved to another place, an item goes to that place's end. Used by the reader's buttons
 *  (src/ui/buttonsheet.ts); like the editor above it knows nothing of what the items are. */
export interface PlaceChoice<P extends string> { id: P; label: string; glyph: () => Node }
export function groupedPlacesEditor<P extends string>(items: readonly { id: string; at: P }[], o: {
  places: PlaceChoice<P>[];
  label: (id: string) => string;
  icon?: (id: string) => string;
  /** The places an item may take (all by default). */
  allowed?: (id: string, at: P) => boolean;
  /** Items taken out rather than hidden (a separator): a remove button in place of the choice. */
  removable?: (id: string) => boolean;
  /** Rows that cannot be moved, shown in a group (the back arrow, «More»…). */
  fixed?: (at: P) => { icon: string; label: string; note: string }[];
  /** Something more at a group's foot (add a separator). */
  extra?: (at: P, add: (id: string) => void) => HTMLElement | null;
  onChange: (items: { id: string; at: P }[]) => void;
}): HTMLElement {
  let cur = items.map((x) => ({ ...x }));
  const box = h('div', { class: 'places-editor' });
  let focusAfter: { id: string; cls: string } | null = null;
  const commit = (focus?: { id: string; cls: string }) => { o.onChange(cur.map((x) => ({ ...x }))); focusAfter = focus ?? null; render(); };
  const move = (id: string, d: -1 | 1) => {
    const i = cur.findIndex((x) => x.id === id); const at = cur[i].at;
    let j = i + d; while (j >= 0 && j < cur.length && cur[j].at !== at) j += d;
    if (j < 0 || j >= cur.length) return;
    [cur[i], cur[j]] = [cur[j], cur[i]]; commit({ id, cls: d < 0 ? '.mv-up' : '.mv-down' });
  };
  const place = (id: string, at: P) => { const i = cur.findIndex((x) => x.id === id); const [it] = cur.splice(i, 1); it.at = at; cur.push(it); commit({ id, cls: `[data-place="${at}"]` }); };
  const render = () => {
    box.replaceChildren(...o.places.map((pl) => {
      const rows = cur.filter((x) => x.at === pl.id);
      const fixed = o.fixed?.(pl.id) ?? [];
      return h('section', { class: 'places-group', dataset: { group: pl.id } },
        h('h5', { class: 'places-head' }, h('span', { class: 'place-glyph2', 'aria-hidden': 'true' }, pl.glyph()), pl.label, h('small', null, String(rows.length || ''))),
        h('div', { class: 'placed-list', role: 'list', 'aria-label': pl.label },
          ...fixed.map((f) => h('div', { class: 'placed-row fixed', role: 'listitem' }, h('span', { class: 'placed-name' }, icon(f.icon), h('span', null, f.label, h('small', null, f.note))), h('span', { class: 'fixed-mark', title: f.note }, icon('lock')))),
          ...rows.map((it, k) => {
            const name = o.label(it.id);
            return h('div', { class: 'placed-row on', role: 'listitem', dataset: { id: it.id } },
              h('span', { class: 'placed-name' }, o.icon ? icon(o.icon(it.id)) : null, h('span', null, name)),
              o.removable?.(it.id)
                ? h('button', { type: 'button', class: 'icon-btn rm', 'aria-label': `${t('remove')}: ${name}`, title: t('remove'), onclick: () => { cur = cur.filter((x) => x.id !== it.id); commit(); } }, icon('close'))
                : h('div', { class: 'placed-at places', role: 'radiogroup', 'aria-label': `${t('buttonPlace')}: ${name}` }, ...o.places.map((q) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(q.id === it.at), 'aria-pressed': String(q.id === it.at), dataset: { place: q.id }, title: q.label, 'aria-label': `${name}: ${q.label}`, disabled: o.allowed && !o.allowed(it.id, q.id), onclick: () => { if (q.id !== it.at) place(it.id, q.id); } }, h('span', { class: 'place-glyph2', 'aria-hidden': 'true' }, q.glyph())))),
              h('span', { class: 'row-actions' },
                h('button', { type: 'button', class: 'icon-btn mv-up', 'aria-label': `${t('moveUp')}: ${name}`, title: t('moveUp'), disabled: k === 0, onclick: () => move(it.id, -1) }, icon('chevronUp')),
                h('button', { type: 'button', class: 'icon-btn mv-down', 'aria-label': `${t('moveDown')}: ${name}`, title: t('moveDown'), disabled: k === rows.length - 1, onclick: () => move(it.id, 1) }, icon('chevronDown'))));
          })),
        o.extra?.(pl.id, (id) => { cur.push({ id, at: pl.id }); commit(); }) ?? null);
    }));
    if (focusAfter) { const f = focusAfter; box.querySelector<HTMLElement>(`.placed-row[data-id="${CSS.escape(f.id)}"] ${f.cls}`)?.focus(); focusAfter = null; }
  };
  render();
  return box;
}
