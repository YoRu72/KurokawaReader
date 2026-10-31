// Tracking as the reader does it: when a download that belongs to an episode finishes (or when it is opened
// to play), the AniList entry's progress moves to that episode — if the setting allows and the entry is behind.
import { getEngine, onEngineChange } from '../engine';
import type { Task } from '../engine/types';
import { getSettings } from '../settings';
import * as al from '../anilist';
import { toast } from '../ui/dom';
import { t } from '../i18n';

const seen = new Map<string, string>();
let started = false;
export function watchProgress(): void {
  if (started) return; started = true;
  const hook = (eng: ReturnType<typeof getEngine>) => eng.onChange((tasks: Task[]) => {
    for (const x of tasks) { const was = seen.get(x.id); seen.set(x.id, x.state); if (was && was !== 'done' && x.state === 'done') void onDone(x); }
  });
  let off = hook(getEngine()); onEngineChange((e) => { off(); off = hook(e); });
  void al.flushPending();
}
async function onDone(x: Task): Promise<void> {
  const m = x.meta as { anilistId?: number; episode?: number; title?: string } | undefined;
  if (!m?.anilistId || !m.episode || !getSettings().anilistAutoProgress || !al.linked()) return;
  await markWatched(m.anilistId, m.episode, m.title);
}
/** Progress set to `episode` when the entry is behind it (never backwards). */
export async function markWatched(anilistId: number, episode: number, title?: string): Promise<void> {
  try {
    const a = await al.media(anilistId); const e = a.entry;
    if (e && e.progress >= episode) return;
    const entry: al.AlEntry = { ...(e ?? { status: 'CURRENT', progress: 0, score: 0, startedAt: al.today() }), progress: episode, ...(a.episodes && episode >= a.episodes ? { status: 'COMPLETED' as const, completedAt: al.today() } : e?.status === 'PLANNING' ? { status: 'CURRENT' as const, startedAt: al.today() } : {}) };
    const r = await al.saveOrQueue(anilistId, entry);
    toast(t('animeProgressMarked', { title: title ?? a.title, n: episode }) + (r.sent ? '' : ` (${t('animeQueued')})`));
  } catch { /* AniList refused; the user can set it by hand */ }
}
