// Pins changed (src/pins.ts holds what they are, their shape and the copy the library draws from): pinned, unpinned,
// moved, a place or an item gone, and carried by a backup. Loaded when first used — not at the start (the library's
// first render only reads them).
import { db, type Folder } from './db';
import { PIN_KEY, migratePins, keepPins, pinsNow, placeFolder, pinBook, pinFolder, type PinStore } from './pins';

async function change(fn: (s: PinStore) => void): Promise<PinStore> {
  const next = await db.updateMeta<PinStore>(PIN_KEY, (cur) => { const s = migratePins(cur); fn(s); for (const k of Object.keys(s.places)) if (!s.places[k].length) delete s.places[k]; return s; });
  const s = next ?? { v: 1, places: {} }; keepPins(s);
  return s;
}

/** Items pinned in a place (added at its end, in the order given) or unpinned from it. */
export function setPinned(place: string, items: string[], on: boolean): Promise<PinStore> {
  return change((s) => {
    const list = s.places[place] ?? [];
    if (on) { for (const x of items) if (!list.includes(x)) list.push(x); s.places[place] = list; }
    else s.places[place] = list.filter((x) => !items.includes(x));
  });
}
/** A place's pins set as given (an undo or a redo: the list as it was before or after a change). */
export function setPlaceList(place: string, items: string[]): Promise<PinStore> { return change((s) => { s.places[place] = [...new Set(items)]; }); }
/** A pinned item moved earlier (-1) or later (+1) among its place's pins. */
export function movePin(place: string, item: string, delta: number): Promise<PinStore> {
  return change((s) => {
    const list = s.places[place] ?? []; const i = list.indexOf(item); const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    list.splice(i, 1); list.splice(j, 0, item);
  });
}
/** Items gone from the library (a book or folder deleted): unpinned everywhere. */
export function forgetPinItems(items: string[]): Promise<PinStore> {
  if (!items.length) return Promise.resolve(pinsNow());
  const gone = new Set(items);
  return change((s) => { for (const k of Object.keys(s.places)) s.places[k] = s.places[k].filter((x) => !gone.has(x)); });
}
/** A place gone (a folder, a tag, a saved shelf deleted): its pins with it. */
export function forgetPlace(place: string): Promise<PinStore> { return change((s) => { delete s.places[place]; }); }
/** A place renamed (a tag): its pins go with it (put after the new name's, when that had some). */
export function renamePlace(from: string, to: string): Promise<PinStore> {
  return change((s) => { if (from === to || !s.places[from]) return; const into = s.places[to] ?? []; for (const x of s.places[from]) if (!into.includes(x)) into.push(x); s.places[to] = into; delete s.places[from]; });
}

/* ---------- in a backup: by names, not this library's ids (folder ids differ between devices; book ids are the
 * backup's own, mapped by the restore) ---------- */
export interface PortablePins { v: 1; places: Record<string, string[]> }
/** The pins for a backup: folders by name ('folder:<name>', 'f:<name>'); books by the backup's book ids. */
export function pinsForBackup(s: PinStore, folders: Folder[]): PortablePins | undefined {
  const name = (id: string) => folders.find((f) => f.id === id)?.name;
  const out: PortablePins = { v: 1, places: {} };
  for (const [k, list] of Object.entries(s.places)) {
    let place = k;
    if (k.startsWith('folder:')) { const n = name(k.slice(7)); if (!n) continue; place = `folder:${n}`; }
    const items = list.map((x) => (x.startsWith('f:') ? ((n) => (n ? `f:${n}` : ''))(name(x.slice(2))) : x)).filter(Boolean);
    if (items.length) out.places[place] = items;
  }
  return Object.keys(out.places).length ? out : undefined;
}
/** A backup's pins merged in: the device's own kept first, in their order; the backup's it lacks added after them.
 *  `idMap`: the backup's book id → this library's (books not restored are left out). */
export async function restorePins(p: unknown, folders: Folder[], idMap: Map<string, string>): Promise<void> {
  const inc = migratePins(p);
  if (!Object.keys(inc.places).length) return;
  const fid = (n: string) => folders.find((f) => f.name === n)?.id;
  await change((s) => {
    for (const [k, list] of Object.entries(inc.places)) {
      let place = k;
      if (k.startsWith('folder:')) { const id = fid(k.slice(7)); if (!id) continue; place = placeFolder(id); }
      const items = list.map((x) => (x.startsWith('b:') ? ((id) => (id ? pinBook(id) : ''))(idMap.get(x.slice(2))) : x.startsWith('f:') ? ((id) => (id ? pinFolder(id) : ''))(fid(x.slice(2))) : x)).filter(Boolean);
      const into = s.places[place] ?? [];
      for (const x of items) if (!into.includes(x)) into.push(x);
      s.places[place] = into;
    }
  });
}
