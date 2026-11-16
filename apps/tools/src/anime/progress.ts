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
async function onDone(x: Task): Promise<void> {
  const m = x.meta as { anilistId?: number; episode?: number; title?: string } | undefined;
  if (!m?.anilistId || !m.episode || !getSettings().anilistAutoProgress || !al.linked()) return;
  await markWatched(m.anilistId, m.episode, m.title);
}
const SENT = 'kt.anime.tracked';
const sentList = (): string[] => { try { return JSON.parse(localStorage.getItem(SENT) ?? '[]') as string[]; } catch { return []; } };
const noteSent = (k: string) => { const l = sentList().filter((x) => x !== k); l.push(k); try { localStorage.setItem(SENT, JSON.stringify(l.slice(-300))); } catch { /* full */ } };
/** Progress set to `episode` when the entry is behind it (never backwards) — on AniList when linked, and on
 *  MyAnimeList when signed in there; each episode once (a second watch of it sends nothing). */
export async function markWatched(anilistId: number, episode: number, title?: string): Promise<void> {
  const k = `${anilistId}:${episode}`; if (sentList().includes(k)) return;
  let idMal: number | undefined; let total: number | null | undefined;
  try {
    if (!al.linked()) { const m = await import('./mal'); if (m.malLinked()) { const a = await al.media(anilistId); await m.malProgress(a.idMal, episode, a.episodes); noteSent(k); } return; }
    const a = await al.media(anilistId); const e = a.entry; idMal = a.idMal; total = a.episodes;
    void import('./mal').then((m) => (m.malLinked() ? m.malProgress(idMal, episode, total) : undefined)).catch(() => undefined);
    if (e && e.progress >= episode) { noteSent(k); return; }
    const entry: al.AlEntry = { ...(e ?? { status: 'CURRENT', progress: 0, score: 0, startedAt: al.today() }), progress: episode, ...(a.episodes && episode >= a.episodes ? { status: 'COMPLETED' as const, completedAt: al.today() } : e?.status === 'PLANNING' ? { status: 'CURRENT' as const, startedAt: al.today() } : {}) };
    const r = await al.saveOrQueue(anilistId, entry);
    noteSent(k);
    toast(t('animeProgressMarked', { title: title ?? a.title, n: episode }) + (r.sent ? '' : ` (${t('animeQueued')})`));
  } catch (err) {
    // (AniList out of reach: the episode kept and tried again — the progress read anew then, so never lowered.)
    if (al.isLater(err)) { const w = waiting(); w[k] = { id: anilistId, ep: episode, title }; keepWaiting(w); }
    /* else AniList refused; the user can set it by hand */
  }
}
const WAIT = 'kt.anime.watchPending';
type Waiting = Record<string, { id: number; ep: number; title?: string }>;
const waiting = (): Waiting => { try { return JSON.parse(localStorage.getItem(WAIT) ?? '{}') as Waiting; } catch { return {}; } };
const keepWaiting = (w: Waiting) => { try { localStorage.setItem(WAIT, JSON.stringify(w)); } catch { /* full */ } };
/** The episodes watched while AniList could not be reached, sent now (each read anew: never lowered). */
export async function flushWatched(): Promise<void> {
  const w = waiting(); if (!Object.keys(w).length || !al.linked()) return; keepWaiting({});
  for (const x of Object.values(w)) await markWatched(x.id, x.ep, x.title);
}
window.addEventListener('online', () => void flushWatched());

// (Tests only — the loopback stand-in set —: this module's work reachable from the page.)
if (al.testApi('anilist')) (window as unknown as { __ktProgress?: unknown }).__ktProgress = { markWatched, flushWatched, dl: () => import('../ui/dlFloat') };
