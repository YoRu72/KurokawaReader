// The video downloads' own queue: at most «Simultaneous video downloads» run at once (each is a yt-dlp — on a phone,
// Python too —), the rest wait «queued», oldest first, in the shell (desktop/ytdlp.cjs, vtjobs.rs, KtEngine.java). The
// page tells the shells the limit, shows each waiting one's place, and gives each job its share of the pieces fetched
// at once (-N) so the jobs together stay near one download's worth.
import { getSettings } from '../settings';
import { nativePlatform, ktPlugin } from '../native';
import type { Task } from '../engine/types';

/** The limit: the setting, else 2 on a phone (a 4 GB phone runs two Pythons comfortably), 3 on a computer. */
export const maxVideoOf = (): number => { const n = getSettings().maxVideo; return n && n > 0 ? Math.min(10, Math.floor(n)) : nativePlatform() === 'android' ? 2 : 3; };
/** The pieces of one stream fetched at once when the setting says «Auto»: a share of a budget (8 on a phone, 16 on a
 *  computer) over the jobs that may run together, 2 to 4 on a phone, 2 to 8 on a computer. */
export const autoFragments = (): number => { const phone = nativePlatform() === 'android'; const share = Math.floor((phone ? 8 : 16) / maxVideoOf()); return Math.max(2, Math.min(phone ? 4 : 8, share)); };
/** The limit sent to the shell (at start, and when the setting changes). */
export async function applyVideoQueue(): Promise<void> {
  const n = maxVideoOf();
  try { const d = window.kurokawaTools as unknown as { configure?(o: Record<string, unknown>): Promise<void> } | undefined; if (d?.configure) { await d.configure({ maxVideo: n }); return; } await (ktPlugin() as unknown as { configure?(o: Record<string, unknown>): Promise<void> } | null)?.configure?.({ maxVideo: n }); } catch { /* an older shell: no limit there */ }
}
/** Each waiting video job's place in the queue (1: next), by the order they were added. */
export function queuePlaces(tasks: readonly Task[]): Map<string, number> {
  const out = new Map<string, number>(); let n = 0;
  for (const x of [...tasks].filter((x) => x.kind === 'video' && x.state === 'queued').sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0))) out.set(x.id, ++n);
  return out;
}
