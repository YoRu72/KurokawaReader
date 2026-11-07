// One file of a torrent deleted by itself — an episode of a batch, a film of a pack — the rest kept: the file left
// out of the download first (so it is not fetched again), then moved to the trash (the phone's app trash, the
// computer's recycle bin). A torrent with no other file wanted is removed whole, files and all, as before.
import { getEngine } from '../engine';
import type { Task } from '../engine/types';
import { ktPlugin } from '../native';
import { localPathOf } from '../engine/localPath';
export { localPathOf };

/** True when only this file is left out and deleted; false when the whole task went (its last file wanted). */
export async function deleteTaskFile(x: Task, index: number): Promise<'file' | 'task'> {
  const eng = getEngine(); const others = x.files.filter((f) => f.index !== index && f.priority > 0);
  if (x.files.length < 2 || !others.length || !eng.setFiles) { await eng.remove(x.id, true); return 'task'; }
  await eng.setFiles(x.id, x.files.map((f) => (f.index === index ? 0 : f.priority) as 0 | 1 | 2));
  const path = localPathOf(x, index);
  if (path) {
    const p = ktPlugin() as unknown as { filesTrash?(o: { paths: string[] }): Promise<unknown> } | null;
    const d = window.kurokawaTools as unknown as { deletePath?(p: string): Promise<{ ok: boolean }> } | undefined;
    if (p?.filesTrash) await p.filesTrash({ paths: [path] });
    else if (d?.deletePath) { const r = await d.deletePath(path); if (!r.ok) throw new Error(path); }
  }
  return 'file';
}
/** The file of this episode in a download of several, by its name only (no guess: a delete must hit the right one). */
export async function fileOfEpisode(x: Task, ep: number, season?: number): Promise<number | undefined> {
  if (x.files.length < 2) return undefined;
  const { parseFilename } = await import('../anime/anitomy'); const { isVideo } = await import('../engine');
  const hits = x.files.filter((f) => { if (!isVideo(f.path)) return false; const p = parseFilename(f.path.split('/').pop() ?? f.path); return p.episode === ep && (season === undefined || p.season === undefined || p.season === season); });
  return hits.length === 1 ? hits[0].index : undefined;
}
