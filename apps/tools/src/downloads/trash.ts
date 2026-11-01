// Prism's trash: downloads taken off the list are kept here (the last two hundred, a month at most) to be put
// back — the same link, folder and name; a finished file still on the disk is not downloaded again where the
// engine can tell. Emptied by hand or as entries age.
import type { Task, TaskSource } from '../engine/types';
import { getEngine, onEngineChange, displayName } from '../engine';
import type { Engine } from '../engine/types';

export interface Trashed { id: string; name: string; source: TaskSource; dir?: string; total: number; state: string; kind: string; removedAt: number; filesDeleted: boolean; meta?: Task['meta'] }
const KEY = 'kt.trash'; const MAX = 200; const AGE = 30 * 864e5;
export function trashList(): Trashed[] {
  try { const l = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Trashed[]; const now = Date.now(); return l.filter((x) => now - x.removedAt < AGE); } catch { return []; }
}
const save = (l: Trashed[]) => { try { localStorage.setItem(KEY, JSON.stringify(l.slice(0, MAX))); } catch { /* full */ } };
export const emptyTrash = (): void => save([]);
export const dropFromTrash = (id: string): void => save(trashList().filter((x) => x.id !== id));

let last = new Map<string, Task>();
function hook(e: Engine): void {
  const tagged = e as Engine & { __trash?: boolean }; if (tagged.__trash) return; tagged.__trash = true;
  const orig = e.remove.bind(e);
  e.remove = async (id: string, deleteFiles: boolean) => {
    const x = last.get(id);
    await orig(id, deleteFiles);
    // (A torrent's .torrent bytes are not kept: its magnet, or nothing to put back.)
    if (x && (x.source.url || x.source.magnet) && x.kind !== 'video') {
      const src: TaskSource = { ...x.source }; delete (src as { torrent?: string }).torrent;
      save([{ id: x.id, name: displayName(x), source: src, dir: x.dir, total: x.total, state: x.state, kind: x.kind, removedAt: Date.now(), filesDeleted: deleteFiles, meta: x.meta }, ...trashList().filter((t) => t.id !== x.id)]);
    }
  };
}
let started = false;
export function startTrash(): void {
  if (started) return; started = true;
  const watch = (e: Engine) => { hook(e); return e.onChange((ts) => { last = new Map(ts.map((x) => [x.id, x])); }); };
  let off = watch(getEngine());
  onEngineChange((e) => { off(); off = watch(e); });
}
/** Put back: added again as it was. */
export async function restore(x: Trashed): Promise<Task> {
  const t = await getEngine().add({ source: x.source, dir: x.dir, name: x.source.url ? x.name : undefined, meta: x.meta, paused: false });
  dropFromTrash(x.id); return t;
}
