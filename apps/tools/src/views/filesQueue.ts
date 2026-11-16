// The Files job queue (a lazy chunk, loaded when a copy, move, delete or extraction is asked for).
//
// Copy, move, delete and extract jobs run in the engines (the phone's KtFileJobs / KtFileExec, the Tauri shell's
// filejobs.rs). This is their orchestrator on the page's side: a job waiting here has simply not been started yet — its
// `start` is called only when its turn comes («One at a time», the default) or at once («Together»). Nothing in an
// engine is changed; none of them has a pause (the journal's «resume» is for a job cut short by a crash, not a pause),
// so a running job offers Cancel only. A waiting job can be moved up or down and removed.
//
// How a job's end is heard: the queue holds its own listener on the engine's «files» events while it has any job (let go
// when it has none), so a job finishes even when the Files page has moved on; the page also tells it of the ends it hears
// (`finish`), and of the jobs that are not engine events (a Full check, an archive taken out) when they end. `finish`
// is safe to call twice.
//
// What is kept: the waiting jobs that can be run again (copies, moves, extractions — a delete is never kept) are in
// localStorage while they wait. At the next start they are offered, not run: «Unfinished jobs: n» with Resume / Discard.
import { h, icon, iconButton, openSheet, toast } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { listen } from '../native';
import { readablePath } from './filesNames';

export type QKind = 'copy' | 'move' | 'delete' | 'extract' | 'remote';
/** What is needed to ask for a job again after a restart. */
export interface Saved { op: 'copy' | 'move' | 'extract' | 'extractHere'; paths: string[]; dest: string }
export interface QJob {
  id: string; kind: QKind; label: string; /** The names it is about (the first few). */ what?: string; from: string; to?: string;
  /** Starts it; true when it has (its end comes as an engine event, or by `finish`), false when it could not start. */
  start(): Promise<boolean>;
  /** Stops it while it runs; the job's own start sets it to the real thing. */
  cancel: () => void;
  /** Taken out of the queue before it started (the clipboard's «moving» mark is let go). */
  dropped?: () => void;
  save?: Saved;
}
export interface QHost { mode(): 'one' | 'together'; events(): { addListener(ev: string, fn: (d: never) => void): unknown } | null }
type Ev = { id: string; status: string; done?: number; total?: number; files?: number; ofFiles?: number; name?: string };
/** `started`: its start() has returned; `cancelAsked`: Cancel was pressed (also before start returned); `timer`: the one wait for the engine to confirm a stop. */
type Run = { job: QJob; pct: number; meta: string; started: boolean; cancelAsked: boolean; timer: ReturnType<typeof setTimeout> | null };
/** How long a cancelled job may stay running without the engine saying so before the queue lets it go. */
const CANCEL_GRACE_MS = 5000;

const KEY = 'kt.files.queue'; const LEFT = 'kt.files.queue.unfinished';
const waiting: QJob[] = []; const running = new Map<string, Run>(); const alias = new Map<string, string>();
let host: QHost | null = null; let sub: { remove(): void } | null = null; let subBusy = false;
const subs = new Set<(k: 'list' | 'progress', id?: string) => void>();
const notify = (k: 'list' | 'progress', id?: string) => { for (const f of [...subs]) f(k, id); };
const store = (k: string, v: unknown | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* none */ } };
/** A stored job is used only when every part of it is what it must be; anything else is dropped (never thrown on). */
export const validSaved = (x: unknown): x is Saved => {
  if (!x || typeof x !== 'object') return false; const v = x as Saved;
  if (!['copy', 'move', 'extract', 'extractHere'].includes(v.op) || !Array.isArray(v.paths) || !v.paths.length || v.paths.length > 5000) return false;
  if (!v.paths.every((p) => typeof p === 'string' && p.trim().length > 0 && p.length < 4096)) return false;
  return typeof v.dest === 'string' && v.dest.length < 4096 && (v.op === 'extractHere' || v.dest.trim().length > 0);
};
/** What is stored: the list, and which run wrote it and when it last showed it was alive (two windows, or a reload, must not take jobs a live run still holds). */
type Stored = { run: string; beat: number; list: Saved[] };
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; const ALIVE_MS = 20000;
const readStored = (k: string): Stored | null => {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? 'null') as unknown; if (v === null) return null;
    if (Array.isArray(v)) return { run: '', beat: 0, list: v.filter(validSaved) };
    if (typeof v !== 'object') return null; const o = v as Partial<Stored>;
    return { run: typeof o.run === 'string' ? o.run : '', beat: typeof o.beat === 'number' ? o.beat : 0, list: Array.isArray(o.list) ? o.list.filter(validSaved) : [] };
  } catch { return null; }
};
const readSaved = (k: string): Saved[] => readStored(k)?.list ?? [];
// (What an earlier run left: moved aside when this module first loads — before this run's own jobs could be written over it —, but
// only when the run that wrote it is gone: a window that is alive still holds its waiting jobs.)
{ const old = readStored(KEY); if (old && old.run !== RUN && Date.now() - old.beat > ALIVE_MS) { if (old.list.length) store(LEFT, [...readSaved(LEFT), ...old.list]); store(KEY, null); } }
// (A page being left says so: its jobs are then an unfinished run's at once, not after the time.)
try { addEventListener('pagehide', () => { const s0 = readStored(KEY); if (s0 && s0.run === RUN) store(KEY, { ...s0, beat: 0 }); }); } catch { /* none */ }
let lastBeat = 0;
/** Shows the run alive (while jobs wait): written with every change and, at most every few seconds, with the progress. */
const heartbeat = () => { const now = Date.now(); if (now - lastBeat < 5000) return; lastBeat = now; const s0 = readStored(KEY); if (s0 && s0.run === RUN) store(KEY, { ...s0, beat: now }); };

const persist = () => { const l = waiting.filter((j) => j.save).map((j) => j.save as Saved); lastBeat = Date.now(); store(KEY, l.length ? { run: RUN, beat: lastBeat, list: l } : null); };
export const count = (): number => waiting.length + running.size;
export const subscribe = (fn: (k: 'list' | 'progress', id?: string) => void): (() => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
export const snapshot = () => ({ running: [...running.values()], waiting: [...waiting] });

const onEv = (ev: Ev) => {
  const id = alias.get(ev.id) ?? ev.id; const r = running.get(id); if (!r) return;
  if (ev.status === 'progress') { r.pct = ev.total ? Math.round(((ev.done ?? 0) / ev.total) * 100) : 0; r.meta = `${ev.name ?? ''} · ${formatBytes(ev.done ?? 0)}${ev.total ? ` / ${formatBytes(ev.total)}` : ''}${ev.ofFiles ? ` · ${localDigits(ev.files ?? 0)}/${localDigits(ev.ofFiles)}` : ''}`; heartbeat(); notify('progress', id); }
  else if (ev.status === 'done' || ev.status === 'cancelled' || ev.status === 'failed') finish(id);
};
/** The engine listener is held while there is a job, and let go when there is none. */
const sync = () => {
  if (count() > 0 && !sub && !subBusy && host) {
    const ev = host.events(); if (!ev) return; subBusy = true;
    void listen<Ev>(ev as never, 'files', onEv).then((s) => { subBusy = false; if (count() > 0) sub = s; else s.remove(); });
  } else if (count() === 0 && sub) { sub.remove(); sub = null; }
};
/** Starts what may start now. */
export const pump = () => {
  if (!host) return; let moved = false;
  while (waiting.length && (host.mode() === 'together' || running.size === 0)) {
    const job = waiting.shift() as QJob; const run: Run = { job, pct: 0, meta: '', started: false, cancelAsked: false, timer: null }; running.set(job.id, run); moved = true;
    // (A Cancel pressed before start() returned is applied when it does: the engine knows the job only then. A job let go meanwhile is stopped too.)
    void Promise.resolve().then(() => job.start()).then((ok) => { if (!ok) { finish(job.id); return; } run.started = true; if (run.cancelAsked || running.get(job.id) !== run) job.cancel(); }, () => finish(job.id));
  }
  if (moved) { persist(); notify('list'); }
  sync();
};
/** A job asked for: starts at once when it may, else waits. Resolves to where it stands. */
export const enqueue = (job: QJob, h0: QHost): 'running' | 'waiting' | 'duplicate' => {
  // (One id, one job: a second job of the same id would overwrite the first's place and free the wrong slot at its end.)
  if (running.has(job.id) || waiting.some((j) => j.id === job.id) || alias.has(job.id)) { job.dropped?.(); return 'duplicate'; }
  host = h0; waiting.push(job); persist(); sync(); notify('list'); pump();
  return running.has(job.id) ? 'running' : 'waiting';
};
/** `id` is a part of a running job (an extraction's move into place): its events and its end are the job's. */
export const link = (partId: string, jobId: string) => { alias.set(partId, jobId); };
export const progress = (id: string, pct: number, meta: string) => { const r = running.get(alias.get(id) ?? id); if (r) { r.pct = pct; r.meta = meta; notify('progress', r.job.id); } };
export const finish = (id0: string) => {
  const id = alias.get(id0) ?? id0; const r = running.get(id); if (!r) return; if (r.timer) { clearTimeout(r.timer); r.timer = null; } running.delete(id);
  for (const [k, v] of [...alias]) if (v === id) alias.delete(k);
  notify('list'); pump(); sync();
};
export const move = (id: string, by: -1 | 1) => {
  const i = waiting.findIndex((j) => j.id === id); const k = i + by; if (i < 0 || k < 0 || k >= waiting.length) return;
  [waiting[i], waiting[k]] = [waiting[k], waiting[i]]; persist(); notify('list');
};
export const remove = (id: string) => {
  const i = waiting.findIndex((j) => j.id === id); if (i < 0) return;
  const [j] = waiting.splice(i, 1); persist(); j.dropped?.(); notify('list'); sync();
};
export const cancelRunning = (id: string) => {
  const r = running.get(id); if (!r) return; r.cancelAsked = true; r.job.cancel();
  // (The engine says when a cancelled job has stopped. If it says nothing, the job would hold its place for ever: after a short wait the queue lets it go, and says so.)
  if (!r.timer) r.timer = setTimeout(() => { r.timer = null; if (running.get(id) !== r) return; toast(t('filesJobDropped'), 'error', 6000); finish(id); }, CANCEL_GRACE_MS);
};
/** The setting changed: «Together» starts everything that waits. */
export const modeChanged = () => pump();

/* ---------- what an earlier run left ---------- */
export const unfinished = (): Saved[] => readSaved(LEFT);
export const dropUnfinished = () => store(LEFT, null);
const opWord = (o: Saved['op']): string => (o === 'copy' ? t('filesCopy') : o === 'move' ? t('filesMove') : t('extractNow'));
const dirOf = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
const nameOf = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;
const fromOf = (j: Saved): string => (j.op === 'extract' ? (j.paths[0].split('!/')[0] ?? j.paths[0]) : dirOf(j.paths[0]));
const KIND_OF: Record<Saved['op'], QKind> = { copy: 'copy', move: 'move', extract: 'extract', extractHere: 'extract' };
/** What would run again, said plainly: the action, the names, from and to. Resume all, Discard all, or take single ones out. */
function unfinishedSheet(resumeAll: (s: Saved[]) => void, discardAll: () => void, changed: () => void, shown: (v: boolean) => void): void {
  const list = h('div', { class: 'files-qlist files-ulist' }); let open = true;
  const sh = openSheet(t('filesUnfinished', { n: localDigits(unfinished().length) }), t('close'), { onClose: () => { open = false; shown(true); } }); shown(false);
  const resume = h('button', { type: 'button', class: 'btn primary', onclick: () => { const l = unfinished(); open = false; sh.close(); dropUnfinished(); resumeAll(l); } }, icon('play'), t('filesResumeJobs'));
  const discard = h('button', { type: 'button', class: 'btn tonal', onclick: () => { open = false; sh.close(); dropUnfinished(); discardAll(); } }, icon('trash'), t('filesDiscard'));
  const draw = () => {
    const l = unfinished(); if (!l.length) { if (open) { open = false; sh.close(); } discardAll(); return; }
    list.replaceChildren(...l.map((j, i) => h('div', { class: 'files-qrow waiting', 'data-i': String(i) },
      h('div', { class: 'files-qmain' }, h('div', { class: 'files-qhead' }, icon(KIND_ICON[KIND_OF[j.op]]), h('b', { class: 'files-qlabel', dir: 'auto' }, opWord(j.op))),
        h('span', { class: 'files-qwhat', dir: 'auto' }, j.paths.slice(0, 2).map(nameOf).join(', ') + (j.paths.length > 2 ? ` +${localDigits(j.paths.length - 2)}` : '')),
        line(t('filesJobFrom'), fromOf(j)), line(t('filesJobTo'), j.op === 'extractHere' ? dirOf(j.paths[0]) : j.dest),
        h('div', { class: 'files-qacts' }, h('span', { class: 'grow' }), iconButton('close', t('filesJobRemove'), () => { const k = unfinished(); k.splice(i, 1); store(LEFT, k.length ? k : null); changed(); draw(); }))))));
  };
  draw(); sh.body.append(list, h('p', { class: 'hint files-qnote' }, icon('info'), h('span', null, t('filesUnfinishedHint')))); sh.actions.append(resume, discard);
}
/** «Unfinished jobs: n» with Review (what would run, and Resume all) and Discard; nothing is run until Resume. `answered` is told when
 *  the user has chosen (so a page left without an answer offers it again). Returns what removes the snackbar. */
export function offerUnfinished(resume: (s: Saved[]) => void, answered: () => void = () => undefined): () => void {
  if (!unfinished().length || document.querySelector('.files-unfinished')) return () => undefined;
  const text = h('span', { class: 'grow' }); const label = () => { text.textContent = t('filesUnfinished', { n: localDigits(unfinished().length) }); };
  const done = () => { el.remove(); answered(); };
  const el = h('div', { class: 'toast with-action undo-snack files-unfinished', role: 'status' }, text,
    h('button', { type: 'button', class: 'toast-act files-ureview', onclick: () => unfinishedSheet((l) => { done(); resume(l); }, done, label, (v) => { el.style.display = v ? '' : 'none'; }) }, t('filesReviewJobs')),
    h('button', { type: 'button', class: 'toast-act files-udiscard', onclick: () => { dropUnfinished(); done(); } }, t('filesDiscard')));
  label(); document.body.appendChild(el); return () => el.remove();
}

/* ---------- the Jobs sheet ---------- */
const KIND_ICON: Record<QKind, string> = { copy: 'copy', move: 'scissors', delete: 'trash', extract: 'archive', remote: 'cloud' };
const line = (k: string, p: string) => h('small', { class: 'src files-qline' }, h('span', { class: 'files-qk' }, k), h('bdi', { dir: 'ltr', title: p }, readablePath(p).replace(/\//g, '/\u200b')));
export function jobsSheet(mode: () => 'one' | 'together'): void {
  const list = h('div', { class: 'files-qlist' });
  const sh = openSheet(t('filesJobs'), t('close'), { onClose: () => off() });
  const bars = (id: string) => list.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
  const draw = () => {
    const { running: rs, waiting: ws } = snapshot(); const out: Node[] = [];
    if (!rs.length && !ws.length) out.push(h('p', { class: 'hint' }, t('filesJobsEmpty')));
    if (rs.length) out.push(h('p', { class: 'files-sec' }, t('filesJobsRunning')));
    for (const r of rs) {
      const j = r.job;
      out.push(h('div', { class: 'files-qrow running', 'data-id': j.id },
        h('div', { class: 'files-qmain' }, h('div', { class: 'files-qhead' }, icon(KIND_ICON[j.kind]), h('b', { class: 'files-qlabel', dir: 'auto' }, j.label.replace(/\s*(…|\.\.\.)$/, ''))), ...(j.what ? [h('span', { class: 'files-qwhat', dir: 'auto' }, j.what)] : []), line(t('filesJobFrom'), j.from), ...(j.to ? [line(t('filesJobTo'), j.to)] : []),
          h('div', { class: 'files-job-bar' }, h('i', { style: { width: `${r.pct}%` } })), h('small', { class: 'src files-job-meta', dir: 'auto' }, r.meta),
        h('div', { class: 'files-qacts' }, h('span', { class: 'grow' }), h('button', { type: 'button', class: 'btn tonal small files-qcancel', onclick: () => cancelRunning(j.id) }, icon('close'), t('cancel'))))));
    }
    if (rs.length) out.push(h('p', { class: 'hint files-qnote' }, icon('info'), h('span', null, t('filesJobsNoPause'))));
    if (ws.length) out.push(h('p', { class: 'files-sec' }, t('filesJobsWaiting')));
    ws.forEach((j, i) => {
      const up = iconButton('chevronUp', t('filesJobUp'), () => move(j.id, -1)); const down = iconButton('chevronDown', t('filesJobDown'), () => move(j.id, 1)); const del = iconButton('close', t('filesJobRemove'), () => remove(j.id));
      up.disabled = i === 0; down.disabled = i === ws.length - 1; up.classList.add('files-qup'); down.classList.add('files-qdown'); del.classList.add('files-qdel');
      out.push(h('div', { class: 'files-qrow waiting', 'data-id': j.id },
        h('div', { class: 'files-qmain' }, h('div', { class: 'files-qhead' }, icon(KIND_ICON[j.kind]), h('b', { class: 'files-qlabel', dir: 'auto' }, j.label.replace(/\s*(…|\.\.\.)$/, ''))), ...(j.what ? [h('span', { class: 'files-qwhat', dir: 'auto' }, j.what)] : []), line(t('filesJobFrom'), j.from), ...(j.to ? [line(t('filesJobTo'), j.to)] : []),
        h('div', { class: 'files-qacts' }, h('small', { class: 'src files-qpos grow' }, t('filesJobPosition', { n: localDigits(i + 1) })), up, down, del))));
    });
    out.push(h('p', { class: 'hint files-qnote' }, icon('info'), h('span', null, t(mode() === 'one' ? 'filesJobsModeOne' : 'filesJobsModeTogether'))));
    if (ws.some((j) => j.save)) out.push(h('p', { class: 'hint files-qnote' }, icon('info'), h('span', null, t('filesJobsKept'))));
    list.replaceChildren(...out);
  };
  const off = subscribe((k, id) => {
    if (k === 'list') { draw(); return; }
    const r = running.get(id ?? ''); const el = id ? bars(id) : null; if (!r || !el) return;
    (el.querySelector('.files-job-bar i') as HTMLElement).style.width = `${r.pct}%`; (el.querySelector('.files-job-meta') as HTMLElement).textContent = r.meta;
  });
  draw(); sh.body.append(list);
}
