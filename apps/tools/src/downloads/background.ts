// What runs in the background from the start: the clipboard monitor (a copied link offered for download when the app
// comes to the front) and the scheduler (downloads marked «later» run in the hours set, each download's own clock,
// the followed channels' looks).
import { clipboardText } from '../native';
import { getEngine, parseSources } from '../engine';
import { getSettings, onSettingsChange } from '../settings';
import type { Task } from '../engine/types';
import { metaOf } from './rules';

/* ---------- the clipboard monitor ---------- */
let lastClip = ''; let clipWired = false;
export function startClipboardWatch(open: (text: string) => void): void {
  if (clipWired) return; clipWired = true;
  const check = async () => {
    if (!getSettings().clipboardWatch || document.visibilityState !== 'visible') return;
    const text = (await clipboardText(true)).trim();
    if (!text || text === lastClip) return; const first = lastClip === ''; lastClip = text; if (first && !sessionStorage.getItem('kt.clip.armed')) { sessionStorage.setItem('kt.clip.armed', '1'); }
    if (!parseSources(text).length) return;
    let seen: string[] = []; try { seen = JSON.parse(localStorage.getItem('kt.clip.seen') ?? '[]') as string[]; } catch { /* none */ }
    if (seen.includes(text)) return; seen = [text, ...seen].slice(0, 50); try { localStorage.setItem('kt.clip.seen', JSON.stringify(seen)); } catch { /* full */ }
    if (document.querySelector('.add-sheet')) return; open(text);
  };
  // (No poll: a link is copied in another app or window, and coming back to this one — its focus, or its page shown
  // again — is when it is looked at. Nothing wakes while the app is idle, in front or not.)
  document.addEventListener('visibilitychange', () => void check()); window.addEventListener('focus', () => void check()); void check();
}

/* ---------- the scheduler ---------- */
/** Inside the hours and days set (a window may cross midnight). */
export function inWindow(now = new Date()): boolean {
  const s = getSettings().schedule; if (!s.enabled) return true;
  const [sh, sm] = s.start.split(':').map(Number), [eh, em] = s.stop.split(':').map(Number); const m = now.getHours() * 60 + now.getMinutes(), a = sh * 60 + sm, b = eh * 60 + em;
  const dayOk = !s.days.length || s.days.includes(now.getDay()); return dayOk && (a <= b ? m >= a && m < b : m >= a || m < b);
}
let schedTimer = 0; let schedWired = false;
/** Downloads added «later» start when the window opens and pause when it closes — only those the scheduler paused
 *  itself (marked `schedPaused`; the add sheet marks those it adds paused to wait for the window): one the reader
 *  paused stays paused, one held (Wi‑Fi only, the battery) is left to its hold. One the reader starts by hand
 *  while the window is shut (still marked) is left running until the window has opened and shut again. */
export function startScheduler(): void {
  void import('./fallback').then((m) => m.startDirectFallback());
  window.clearTimeout(schedTimer);
  const tick = async () => {
    // (Each download's own clock first — a start or a stop time of its own —, then the global window.)
    try { const { tickClocks } = await import('./rules'); await tickClocks(); } catch { /* none */ }
    try { if (getSettings().addons.includes('video')) { const { tick } = await import('../video/follow'); await tick(); } } catch { /* none */ }
    if (!getSettings().schedule.enabled) return; const eng = getEngine(); let tasks; try { tasks = await eng.list(); } catch { return; }
    const open = inWindow(); const { setTaskMeta, metaOf } = await import('./rules');
    for (const x of tasks) {
      const m = metaOf(x) as { later?: boolean; schedPaused?: boolean; schedSkip?: boolean }; if (!m.later || x.state === 'done' || x.state === 'seeding') continue;
      const active = x.state === 'downloading' || x.state === 'queued' || x.state === 'metadata' || x.state === 'checking';
      try {
        if (open) { if (m.schedSkip) await setTaskMeta(x.id, { schedSkip: undefined }); if (x.state === 'paused' && m.schedPaused && !x.heldBy) { await eng.resume(x.id); await setTaskMeta(x.id, { schedPaused: undefined }); } }
        else if (active && !m.schedSkip) {
          // (Running though the scheduler paused it: the reader started it by hand — left alone this time.)
          if (m.schedPaused) await setTaskMeta(x.id, { schedPaused: undefined, schedSkip: true });
          else { await eng.pause(x.id); await setTaskMeta(x.id, { schedPaused: true }); }
        }
      } catch { /* the next */ }
    }
  };
  // (No minute tick: one timer for the next moment something is due — the window opening or closing, a download's own
  // clock, a followed channel's next look —, and none at all when nothing is scheduled. Planned again when the
  // settings, the downloads or the follows change.)
  const plan = async (given?: Task[]) => {
    window.clearTimeout(schedTimer); schedTimer = 0;
    const tasks = given ?? await getEngine().list().catch(() => [] as Task[]); const now = Date.now();
    const at = [nextBoundary(now), ...clocksOf(tasks), ...(await nextFollow())].filter((t): t is number => typeof t === 'number' && t > 0);
    if (!at.length) return;
    const due = Math.min(...at); const wait = Math.max(1000, Math.min(due - now + 500, 6 * 3600e3));
    schedTimer = window.setTimeout(() => void tick().finally(() => void plan()), wait);
  };
  if (!schedWired) {
    schedWired = true; let soon = 0; const again = () => { window.clearTimeout(soon); soon = window.setTimeout(() => void plan(), 1500); };
    // (A progress push changes no clock: planned again only when the downloads' clocks are not what they were.)
    let clocks = ''; getEngine().onChange((ts: Task[]) => { const sig = clocksOf(ts).join(','); if (sig !== clocks) { clocks = sig; void plan(ts); } });
    onSettingsChange(again); window.addEventListener('kt:clocks', again);
    void import('../video/follow').then((f) => f.onFollowsChange(again)).catch(() => undefined);
  }
  void tick().finally(() => void plan());
}
/** The downloads' own start and stop times. */
const clocksOf = (tasks: Task[]): number[] => (Array.isArray(tasks) ? tasks : []).flatMap((x) => { if (x.state === 'done') return []; const m = metaOf(x) as { startAt?: number; stopAt?: number }; return [m.startAt, m.stopAt].filter((t): t is number => typeof t === 'number'); }).sort((a, b) => a - b);
/** The next time the «later» window opens or closes (null when the window is off). */
function nextBoundary(now: number): number | null {
  const s = getSettings().schedule; if (!s.enabled) return null;
  const out: number[] = [];
  for (const hm of [s.start, s.stop]) { const [h, m] = hm.split(':').map(Number); const d = new Date(now); d.setHours(h, m, 0, 0); if (d.getTime() <= now) d.setDate(d.getDate() + 1); out.push(d.getTime()); }
  return Math.min(...out);
}
/** The next followed channel's look (the Video add-on), none when nothing is followed. */
async function nextFollow(): Promise<number[]> {
  if (!getSettings().addons.includes('video')) return [];
  try { const f = await import('../video/follow'); return f.follows().map((x) => (x.lastAt ? x.lastAt + x.every * 3600e3 : Date.now() + 60000)); } catch { return []; }
}
