// Pins in the library: a book, a folder or a series kept at the head of a PLACE — the library's main page, one
// folder, one tag, one saved shelf — in the order the reader gives them, whatever the sort. A book may be pinned in a
// folder and not on the main page; each place has its own list.
//
// Kept in the library database (the `meta` store, key 'pins'), so a backup, the hand-over to the Rust build and a
// restore carry them (src/backup.ts, src/handover.ts). Shape (version 1):
//   { v: 1, places: { '<place>': ['<item>', …] } }
//   place: 'main' | 'folder:<folder id>' | 'tag:<tag name>' | 'shelf:<saved shelf id>'
//   item:  'b:<book id>' | 'f:<folder id>' | 's:<series key>'  (first = first shown)
// A library from before pins has no 'pins' key: read as no pins (the migration, `migratePins`, also tidies a value
// written by hand or by a newer app — unknown places and items kept, malformed ones and repeats dropped).
// Not synced between devices (like the sort order: where things sit on a screen is the device's own).
import { db, type Folder } from './db';

export interface PinStore { v: 1; places: Record<string, string[]> }
const KEY = 'pins';
export const PIN_VERSION = 1;

export const placeMain = 'main';
export const placeFolder = (id: string): string => `folder:${id}`;
export const placeTag = (name: string): string => `tag:${name}`;
export const placeShelf = (id: string): string => `shelf:${id}`;
export const pinBook = (id: string): string => `b:${id}`;
export const pinFolder = (id: string): string => `f:${id}`;
export const pinSeries = (key: string): string => `s:${key}`;

/** Any stored value (none: a library from before pins) as the current shape. */
export function migratePins(raw: unknown): PinStore {
  const out: PinStore = { v: 1, places: {} };
  if (!raw || typeof raw !== 'object') return out;
  const places = (raw as { places?: unknown }).places;
  if (!places || typeof places !== 'object') return out;
  for (const [k, list] of Object.entries(places as Record<string, unknown>)) {
    if (!k || !Array.isArray(list)) continue;
    const seen = new Set<string>(); const items: string[] = [];
    for (const x of list) if (typeof x === 'string' && /^[bfs]:./.test(x) && !seen.has(x)) { seen.add(x); items.push(x); }
    if (items.length) out.places[k] = items;
  }
  return out;
}

let cache: PinStore = { v: 1, places: {} };
let loaded = false;
/** The pins read from the database (once; afterwards the copy every change keeps current). */
export async function loadPins(): Promise<PinStore> {
  if (!loaded) { cache = migratePins(await db.getMeta(KEY).catch(() => undefined)); loaded = true; }
  return cache;
}
/** The pins as last read (empty before loadPins). */
export function pinsNow(): PinStore { return cache; }
/** For tests and a restore: read again at the next loadPins. */
export function forgetPinCache(): void { loaded = false; }
export function pinnedIn(place: string): string[] { return cache.places[place] ?? []; }

async function change(fn: (s: PinStore) => void): Promise<PinStore> {
  const next = await db.updateMeta<PinStore>(KEY, (cur) => { const s = migratePins(cur); fn(s); for (const k of Object.keys(s.places)) if (!s.places[k].length) delete s.places[k]; return s; });
  cache = next ?? { v: 1, places: {} }; loaded = true;
  return cache;
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
  if (!items.length) return Promise.resolve(cache);
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
