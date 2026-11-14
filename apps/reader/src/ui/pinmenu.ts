// The library's pin actions (src/views/library.ts draws the cards and the selection bar; src/pins.ts reads the pins):
// pin, unpin and move a pin earlier or later in a place — each with «Undo» through src/ui/undo.ts offerUndo (the
// snackbar; Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y on a computer, in the library) —, and the pin rows of a folder's or a
// series' menu. Loaded when first used, not at the start (the library's first render only reads the pins).
import { h, icon } from './dom';
import { t, localDigits } from '../i18n';
import { pinnedIn } from '../pins';
import { setPinned, setPlaceList, movePin } from '../pinedit';
import { offerUndo } from './undo';

/** A change of one place's pins, made undoable: its list before and after kept. `drawn`: the library open drawn again. */
async function pinChange(place: string, fn: () => Promise<unknown>, msg: string, drawn: () => void): Promise<void> {
  const before = [...pinnedIn(place)]; await fn(); const after = [...pinnedIn(place)];
  drawn();
  offerUndo(msg, async () => { await setPlaceList(place, before); drawn(); }, async () => { await setPlaceList(place, after); drawn(); });
}
/** Pinned (or, when every one already is, unpinned) in the place. */
export async function togglePins(items: string[], place: string | null, drawn: () => void): Promise<void> {
  if (!place || !items.length) return;
  const on = !items.every((x) => pinnedIn(place).includes(x));
  await pinChange(place, () => setPinned(place, items, on), on ? t('pinnedToast', { n: localDigits(items.length, 'prose') }) : t('unpinnedToast', { n: localDigits(items.length, 'prose') }), drawn);
}
/** A pinned item moved earlier (-1) or later (+1) among its place's pins. */
export async function moveOnePin(item: string, delta: number, place: string | null, drawn: () => void): Promise<void> {
  if (!place) return;
  await pinChange(place, () => movePin(place, item, delta), t('pinMoved'), drawn);
}
/** A menu's rows for one item (a folder's or a series' menu): Pin / Unpin, then move earlier / later. */
export function pinRows(item: string, place: string | null, close: () => void, drawn: () => void, cls = 'dest-row'): HTMLElement[] {
  if (!place) return [];
  const list = pinnedIn(place); const on = list.includes(item); const i = list.indexOf(item);
  const row = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: cls + ' pin-row', onclick: () => { close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
  return [
    row(on ? 'pinOff' : 'pin', on ? t('unpin') : t('pin'), () => void togglePins([item], place, drawn)),
    ...(on && i > 0 ? [row('chevronUp', t('pinEarlier'), () => void moveOnePin(item, -1, place, drawn))] : []),
    ...(on && i >= 0 && i < list.length - 1 ? [row('chevronDown', t('pinLater'), () => void moveOnePin(item, 1, place, drawn))] : []),
  ];
}
