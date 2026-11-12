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
