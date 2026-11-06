// What runs in the background from the start: the clipboard monitor (a copied link offered for download when the app
// comes to the front) and the scheduler (downloads marked «later» run in the hours set, each download's own clock,
// the followed channels' looks). Apart from the grabber and the checksums (prism.ts), which load only when opened.
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
/** Downloads added «later» start when the window opens and pause when it closes. */
export function startScheduler(): void {
  window.clearInterval(schedTimer);
  const tick = async () => {
    // (Each download's own clock first — a start or a stop time of its own —, then the global window.)
    try { const { tickClocks } = await import('./rules'); await tickClocks(); } catch { /* none */ }
    try { if (getSettings().addons.includes('video')) { const { tick } = await import('../video/follow'); await tick(); } } catch { /* none */ }
    if (!getSettings().schedule.enabled) return; const eng = getEngine(); let tasks; try { tasks = await eng.list(); } catch { return; }
    const open = inWindow();
    for (const x of tasks) { const later = (x.meta as { later?: boolean } | undefined)?.later; if (!later || x.state === 'done') continue; try { if (open && x.state === 'paused') await eng.resume(x.id); else if (!open && (x.state === 'downloading' || x.state === 'queued' || x.state === 'metadata')) await eng.pause(x.id); } catch { /* the next */ } }
  };
  schedTimer = window.setInterval(() => void tick(), 60000); void tick();
}
