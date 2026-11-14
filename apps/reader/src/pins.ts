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
import { db } from './db';

export interface PinStore { v: 1; places: Record<string, string[]> }
export const PIN_KEY = 'pins';
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
  if (!loaded) { cache = migratePins(await db.getMeta(PIN_KEY).catch(() => undefined)); loaded = true; }
  return cache;
}
/** The pins as last read (empty before loadPins). */
export function pinsNow(): PinStore { return cache; }
/** For tests and a restore: read again at the next loadPins. */
export function forgetPinCache(): void { loaded = false; }
export function pinnedIn(place: string): string[] { return cache.places[place] ?? []; }
/** (src/pinedit.ts: the copy kept current after each change written.) */
export function keepPins(s: PinStore): void { cache = s; loaded = true; }

/** What a place lists, the pinned first in their order, then the rest as they were: `keyOf` gives a cell's pin item
 *  ('' for one that cannot be pinned). Pure: drawn from the first render (the editing — src/pinedit.ts, the menus —
 *  src/ui/pinmenu.ts — load when first used). */
export function pinsFirst<T>(cells: T[], pins: string[], keyOf: (c: T) => string): T[] {
  if (!pins.length) return cells;
  const byKey = new Map(cells.map((c) => [keyOf(c), c]));
  const head = pins.map((x) => byKey.get(x)).filter((c): c is T => !!c); const inHead = new Set(head);
  return [...head, ...cells.filter((c) => !inHead.has(c))];
}
