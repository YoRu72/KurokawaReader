// What runs in the background from the start: the clipboard monitor (a copied link offered for download when the app
// comes to the front) and the scheduler (downloads marked «later» run in the hours set, each download's own clock,
// the followed channels' looks).
import { clipboardText } from '../native';
import { getEngine, parseSources } from '../engine';
import { getSettings } from '../settings';

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
  document.addEventListener('visibilitychange', () => void check()); window.addEventListener('focus', () => void check());
  setInterval(() => void check(), 2500); void check();
}

/* ---------- the scheduler ---------- */
/** Inside the hours and days set (a window may cross midnight). */
export function inWindow(now = new Date()): boolean {
  const s = getSettings().schedule; if (!s.enabled) return true;
  const [sh, sm] = s.start.split(':').map(Number), [eh, em] = s.stop.split(':').map(Number); const m = now.getHours() * 60 + now.getMinutes(), a = sh * 60 + sm, b = eh * 60 + em;
  const dayOk = !s.days.length || s.days.includes(now.getDay()); return dayOk && (a <= b ? m >= a && m < b : m >= a || m < b);
}
let schedTimer = 0;
/** Downloads added «later» start when the window opens and pause when it closes — only those the scheduler paused
 *  itself (marked `schedPaused`; the add sheet marks those it adds paused to wait for the window): one the reader
 *  paused stays paused, one held (Wi‑Fi only, the battery) is left to its hold. One the reader starts by hand
 *  while the window is shut (still marked) is left running until the window has opened and shut again. */
export function startScheduler(): void {
  window.clearInterval(schedTimer);
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
  schedTimer = window.setInterval(() => void tick(), 60000); void tick();
}
