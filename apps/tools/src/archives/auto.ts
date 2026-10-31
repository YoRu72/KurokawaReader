// Archives unpacked as they arrive: a subtitle archive (from the Subtitles add-on) always when the setting says
// so, any other downloaded archive when the user asked for that — into a folder of the archive's name, the
// archive deleted afterwards; the task keeps a note of where the files went.
import { getEngine, onEngineChange, displayName } from '../engine';
import type { Task } from '../engine/types';
import { getSettings } from '../settings';
import { canArchive, extractArchive, isArchiveName, stem } from '../archives';
import { toast } from '../ui/dom';
import { t, countFiles } from '../i18n';

const seen = new Map<string, string>(); let started = false; const busy = new Set<string>();
export function watchArchives(): void {
  if (started || !canArchive()) return; started = true;
  const hook = (eng: ReturnType<typeof getEngine>) => eng.onChange((tasks: Task[]) => { for (const x of tasks) { const was = seen.get(x.id); seen.set(x.id, x.state); if (was && was !== 'done' && x.state === 'done') void onDone(x); } });
  let off = hook(getEngine()); onEngineChange((e) => { off(); off = hook(e); });
}
async function onDone(x: Task): Promise<void> {
  const s = getSettings(); const name = displayName(x); const sub = x.meta?.kind === 'subtitle';
  if (x.kind === 'torrent' || !isArchiveName(name) || !x.dir || x.dir.startsWith('content:') || busy.has(x.id)) return;
  if (!(sub ? s.autoUnpackSubs : s.autoUnpackAll)) return;
  busy.add(x.id);
  try {
    const path = `${x.dir.replace(/[\\/]$/, '')}/${x.name}`;
    // Subtitles land beside the archive (the player looks for them there); other archives in a folder of their name.
    const dest = sub ? x.dir : `${x.dir.replace(/[\\/]$/, '')}/${stem(x.name)}`;
    const r = await extractArchive({ path, dest, deleteAfter: true, replace: sub ? 'both' : 'skip' });
    toast(t('autoUnpacked', { name, n: countFiles(r.files) }));
  } catch (e) { toast(t('autoUnpackFailed', { name, error: String((e as Error).message ?? e) }), 'error', 5000); }
  finally { busy.delete(x.id); }
}
