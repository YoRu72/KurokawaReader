// Long work (converting a book, building a PDF) that goes on when its sheet is closed or the app is put in the
// background. While it runs: a notification with its progress (Android, with a foreground service that keeps the
// app alive; the taskbar on the PC), a chip in the app to follow it; when it ends: a notification, and the result
// kept here to save, share or add to the library.
import { h, icon, openSheet, toast } from './ui/dom';
import { t, formatBytes, localDigits } from './i18n';
import { getSettings, updateSettings } from './settings';

export type JobOut = { blob: Blob; name: string };
type Job = { id: number; title: string; pct: number; state: 'running' | 'done' | 'failed'; out?: JobOut; error?: string; watched: () => boolean; seen?: boolean };

const jobs: Job[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const changed = () => { listeners.forEach((fn) => fn()); drawChip(); };

/* ---------- the platform's notifications ---------- */

type Plugin = { notifyPermission?(o: { ask: boolean }): Promise<{ granted: boolean }>; jobProgress?(o: { title: string; text: string; pct: number }): Promise<void>; jobDone?(o: { title: string; text: string; ok: boolean; stop: boolean }): Promise<void> };
const android = (): Plugin | null => {
  const cap = (window as unknown as { Capacitor?: { getPlatform?(): string; Plugins?: { Kurokawa?: Plugin } } }).Capacitor;
  return cap?.getPlatform?.() === 'android' ? cap.Plugins?.Kurokawa ?? null : null;
};
const desktop = () => window.kurokawaDesktop as (typeof window.kurokawaDesktop & { setProgress?(p: number): void }) | undefined;

/** Whether notifications may be shown; with `ask`, the system is asked (once) when it has not been. */
export async function notificationsAllowed(ask: boolean): Promise<boolean> {
  if (!getSettings().jobNotify) return false;
  const a = android();
  if (a?.notifyPermission) return (await a.notifyPermission({ ask }).catch(() => ({ granted: false }))).granted;
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'default' && ask) {
    try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
  }
  return Notification.permission === 'granted';
}

let lastNote = 0;
function noteProgress(j: Job): void {
  const now = performance.now();
  if (now - lastNote < 800 && j.pct < 100) return;
  lastNote = now;
  const text = t('jobProgress', { pct: localDigits(Math.round(j.pct)) });
  void android()?.jobProgress?.({ title: j.title, text, pct: Math.round(j.pct) }).catch(() => undefined);
  desktop()?.setProgress?.(j.pct / 100);
  document.title = `${Math.round(j.pct)}% · ${t('appName')}`;
}
function noteDone(j: Job): void {
  const others = jobs.some((x) => x.state === 'running');
  const text = j.state === 'done' ? t('jobDoneText', { name: j.out!.name, size: formatBytes(j.out!.blob.size) }) : `${t('convertFailed')} — ${j.error ?? ''}`;
  const a = android();
  // (Seen in the app as it ends: nothing to announce, the service only stops.)
  const quiet = j.watched() && document.visibilityState === 'visible';
  if (a?.jobDone) void a.jobDone({ title: j.title, text: quiet ? '' : text, ok: j.state === 'done', stop: !others }).catch(() => undefined);
  else if ('Notification' in window && Notification.permission === 'granted' && getSettings().jobNotify && document.visibilityState === 'hidden') {
    try { const n = new Notification(j.title, { body: text, icon: 'icons/icon-192.png', tag: `kr-job-${j.id}` }); n.onclick = () => { window.focus(); jobsSheet(); n.close(); }; } catch { /* not allowed here */ }
  }
  if (!others) { desktop()?.setProgress?.(-1); document.title = t('appName'); }
}

/* ---------- running ---------- */

/**
 * Run `work` as a job. `watched` says whether its own sheet is still showing it (then the result is shown there;
 * otherwise a toast and the jobs sheet offer it). Resolves with what the work returns.
 */
export async function runJob(title: string, work: (report: (pct: number) => void) => Promise<JobOut | null>, watched: () => boolean = () => false): Promise<JobOut | null> {
  const j: Job = { id: ++seq, title, pct: 0, state: 'running', watched };
  jobs.unshift(j);
  // (Finished files are held in memory to be saved or shared: only the last few are kept — a phone has little.)
  let kept = 0;
  for (let i = 0; i < jobs.length; i++) if (jobs[i].state !== 'running' && ++kept > 3) jobs.splice(i--, 1);
  void notificationsAllowed(true).then((ok) => { if (ok) noteProgress(j); });
  keepAwake(true);
  changed();
  try {
    const out = await work((pct) => { j.pct = Math.max(0, Math.min(100, pct)); noteProgress(j); changed(); });
    if (!out) { jobs.splice(jobs.indexOf(j), 1); return null; }
    j.state = 'done'; j.out = out; j.pct = 100; j.seen = j.watched();
    return out;
  } catch (err) {
    j.state = 'failed'; j.error = String((err as Error)?.message ?? err);
    // (A password to ask for, or a file this cannot read, is said in the sheet: no failed job to keep.)
    if (['password', 'unsupported', 'unsupported-encryption'].includes(j.error)) { jobs.splice(jobs.indexOf(j), 1); j.watched = () => true; }
    throw err;
  } finally {
    if (!jobs.some((x) => x.state === 'running')) keepAwake(false);
    if (jobs.includes(j) || j.state === 'done') noteDone(j); else { if (!jobs.some((x) => x.state === 'running')) void android()?.jobDone?.({ title: j.title, text: '', ok: false, stop: true }).catch(() => undefined); desktop()?.setProgress?.(-1); document.title = t('appName'); }
    changed();
    if (!j.watched() && j.state !== 'running') toast(j.state === 'done' ? t('jobDoneToast', { name: j.out?.name ?? '' }) : t('convertFailed'), j.state === 'done' ? 'info' : 'error', 6000);
  }
}

/** Keep converting at full speed while the app is in the background (timers there are slowed to a crawl). */
let awake = false;
function keepAwake(on: boolean): void { awake = on; }
/** Give the page a moment (to paint, to take a tap) — without the background slowdown of timers. */
export function yieldNow(): Promise<void> {
  if (awake && document.visibilityState === 'hidden') return new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
  return new Promise((r) => setTimeout(r, 0));
}

export function onJobs(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

/* ---------- in the app ---------- */

let chip: HTMLElement | null = null;
function drawChip(): void {
  const running = jobs.filter((j) => j.state === 'running' && !j.watched());
  // (A result finished away from its sheet stays offered here until it is looked at.)
  const ready = jobs.filter((j) => j.state === 'done' && !j.seen && !j.watched());
  if (!running.length && !ready.length) { chip?.remove(); chip = null; return; }
  if (!chip) { chip = h('button', { type: 'button', class: 'job-chip', onclick: () => jobsSheet() }); document.body.appendChild(chip); }
  if (!running.length) { chip.replaceChildren(icon('check'), h('span', { dir: 'auto' }, t('jobReady', { name: ready[0].out!.name }))); chip.classList.add('ready'); return; }
  chip.classList.remove('ready');
  const pct = Math.round(running.reduce((a, j) => a + j.pct, 0) / running.length);
  const ring = h('span', { class: 'job-ring' }); ring.style.setProperty('--p', `${pct}%`);
  chip.replaceChildren(ring, h('span', null, running.length > 1 ? t('jobsRunning', { n: localDigits(running.length) }) : running[0].title), h('b', null, `${localDigits(pct)}%`));
}

/** The jobs of this session: those still running, and the results of those done. */
export function jobsSheet(): void {
  jobs.forEach((j) => { if (j.state !== 'running') j.seen = true; });
  drawChip();
  const s = openSheet(t('jobsTitle'), t('close'));
  s.body.style.fontFamily = 'var(--font-ui)';
  const list = h('div', { class: 'job-list' });
  const draw = () => {
    if (!s.el.isConnected) { off(); return; }
    list.replaceChildren(...(jobs.length ? jobs.map((j) => h('div', { class: 'job-row' },
      h('div', { class: 'job-head' }, h('b', { dir: 'auto' }, j.title), h('span', { class: 'src' }, j.state === 'running' ? `${localDigits(Math.round(j.pct))}%` : j.state === 'done' ? h('span', null, h('bdi', null, j.out!.name), ' · ', h('bdi', null, formatBytes(j.out!.blob.size))) : t('convertFailed'))),
      j.state === 'running' ? h('div', { class: 'progress-bar' }, h('span', { style: { width: `${j.pct}%` } })) : null,
      j.state === 'done' ? h('div', { class: 'sheet-actions', style: { padding: '6px 0 0' } },
        h('button', { class: 'btn small primary', type: 'button', onclick: () => void import('./ui/share').then((m) => m.shareFile(j.out!.blob, j.out!.name, j.out!.name)) }, icon('external'), t('shareFile')),
        h('button', { class: 'btn small', type: 'button', onclick: () => void import('./ui/share').then((m) => m.downloadBlob(j.out!.blob, j.out!.name)) }, icon('download'), t('saveFile')),
        h('button', { class: 'btn small tonal', type: 'button', onclick: async (e: Event) => { (e.currentTarget as HTMLButtonElement).disabled = true; const { importFiles } = await import('./library'); await importFiles([new File([j.out!.blob], j.out!.name, { type: j.out!.blob.type })]); toast(t('addedToLibrary')); } }, icon('import'), t('addToLibrary'))) : null,
      j.state === 'failed' && j.error ? h('p', { class: 'hint' }, j.error) : null)) : [h('p', { class: 'src' }, t('jobsNone'))]));
  };
  const off = onJobs(draw);
  draw();
  const toggle = h('input', { type: 'checkbox', onchange: async () => { updateSettings({ jobNotify: toggle.checked }); if (toggle.checked && !(await notificationsAllowed(true))) toast(t('notifyDenied'), 'info', 5000); } }) as HTMLInputElement;
  toggle.checked = getSettings().jobNotify;
  s.body.append(list, h('label', { class: 'row', style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '14px' } }, h('span', { class: 'switch' }, toggle, h('i')), h('span', null, t('notifyJobs'))), h('p', { class: 'hint' }, t('notifyJobsHint')));
}
