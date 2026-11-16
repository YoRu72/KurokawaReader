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
  void al.flushPending(); void flushWatched();
}
/** The one switch for every automatic list update — after watching, after a download finishes, and the queues of
 *  both: «Update my list after watching» (the older «mark watched as downloads finish» carried over when it was off). */
export function autoOn(): boolean { const s = getSettings(); return s.animeTrackAfterWatch ?? s.anilistAutoProgress !== false; }
async function onDone(x: Task): Promise<void> {
  const m = x.meta as { anilistId?: number; episode?: number; title?: string } | undefined;
  if (!m?.anilistId || !m.episode || !autoOn()) return;
  // (A finished download is not a watched episode: it does not use up the episode's «sent once» mark.)
  await markWatched(m.anilistId, m.episode, m.title, true);
}
const SENT = 'kt.anime.tracked';
const sentList = (): string[] => { try { return JSON.parse(localStorage.getItem(SENT) ?? '[]') as string[]; } catch { return []; } };
const noteSent = (k: string) => { const l = sentList().filter((x) => x !== k); l.push(k); try { localStorage.setItem(SENT, JSON.stringify(l.slice(-300))); } catch { /* full */ } };
const malNow = () => import('./mal').then((m) => (m.malLinked() ? m : null)).catch(() => null);
/** Progress set to `episode` when the entry is behind it (never backwards) — on AniList when linked, and on
 *  MyAnimeList when signed in there; each watched episode once (a second watch of it sends nothing). Unreachable:
 *  kept and tried again later, the entry read anew then. `fromDownload`: a finished download (no «once» mark). */
export async function markWatched(anilistId: number, episode: number, title?: string, fromDownload = false): Promise<void> {
  if (!autoOn()) return;
  const k = `${anilistId}:${episode}`; if (!fromDownload && sentList().includes(k)) return;
  const mal = await malNow(); if (!al.linked() && !mal) return;
  try {
    const a = await al.media(anilistId);
    if (mal) await mal.malProgress(a.idMal, episode, a.episodes).catch(() => undefined);
    if (al.linked()) {
      const e = a.entry;
      if (!e || e.progress < episode) {
        const entry: al.AlEntry = { ...(e ?? { status: 'CURRENT', progress: 0, score: 0, startedAt: al.today() }), progress: episode, ...(a.episodes && episode >= a.episodes ? { status: 'COMPLETED' as const, completedAt: al.today() } : e?.status === 'PLANNING' ? { status: 'CURRENT' as const, startedAt: al.today() } : {}) };
        await al.save(anilistId, entry);
        toast(t('animeProgressMarked', { title: title ?? a.title, n: episode }));
      }
    }
    if (!fromDownload) noteSent(k);
  } catch (err) {
    // (Out of reach: the episode kept and tried again — the entry read anew then, so never lowered.)
    if (al.isLater(err)) { const w = waiting(); w[k] = { id: anilistId, ep: episode, title, dl: fromDownload || undefined }; keepWaiting(w); }
    /* else refused; the user can set it by hand */
  }
}
const WAIT = 'kt.tmp.animeWatchPending';   // (kt.tmp: not in the settings backup)
type Waiting = Record<string, { id: number; ep: number; title?: string; dl?: boolean }>;
const waiting = (): Waiting => { try { return JSON.parse(localStorage.getItem(WAIT) ?? '{}') as Waiting; } catch { return {}; } };
const keepWaiting = (w: Waiting) => { try { localStorage.setItem(WAIT, JSON.stringify(w)); } catch { /* full */ } };
/** The episodes watched while the lists could not be reached, sent now (each read anew: never lowered). */
export async function flushWatched(): Promise<void> {
  if (!autoOn()) return;
  const w = waiting(); if (!Object.keys(w).length) return; keepWaiting({});
  for (const x of Object.values(w)) await markWatched(x.id, x.ep, x.title, !!x.dl);
}
/** The switch turned off: what was waiting to be sent by itself is dropped (AniList's and MyAnimeList's). */
export function clearAutoQueues(): void { try { localStorage.removeItem(WAIT); localStorage.removeItem('kt.tmp.malPending'); } catch { /* none */ } }
window.addEventListener('online', () => void flushWatched());
