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
import { h, icon, iconButton, openSheet } from '../ui/dom';
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
type Run = { job: QJob; pct: number; meta: string };

const KEY = 'kt.files.queue'; const LEFT = 'kt.files.queue.unfinished';
const waiting: QJob[] = []; const running = new Map<string, Run>(); const alias = new Map<string, string>();
let host: QHost | null = null; let sub: { remove(): void } | null = null; let subBusy = false;
const subs = new Set<(k: 'list' | 'progress', id?: string) => void>();
const notify = (k: 'list' | 'progress', id?: string) => { for (const f of [...subs]) f(k, id); };
const store = (k: string, v: unknown | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* none */ } };
const readSaved = (k: string): Saved[] => { try { const v = JSON.parse(localStorage.getItem(k) ?? '[]') as unknown; return Array.isArray(v) ? v.filter((x): x is Saved => !!x && typeof x === 'object' && Array.isArray((x as Saved).paths) && typeof (x as Saved).dest === 'string' && ['copy', 'move', 'extract', 'extractHere'].includes((x as Saved).op)) : []; } catch { return []; } };
// (What an earlier run left: moved aside when this module first loads — before this run's own jobs could be written over it.)
{ const old = readSaved(KEY); if (old.length) { const left = readSaved(LEFT); store(LEFT, [...left, ...old]); } store(KEY, null); }

const persist = () => { const l = waiting.filter((j) => j.save).map((j) => j.save as Saved); store(KEY, l.length ? l : null); };
export const count = (): number => waiting.length + running.size;
export const subscribe = (fn: (k: 'list' | 'progress', id?: string) => void): (() => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
export const snapshot = () => ({ running: [...running.values()], waiting: [...waiting] });

const onEv = (ev: Ev) => {
  const id = alias.get(ev.id) ?? ev.id; const r = running.get(id); if (!r) return;
  if (ev.status === 'progress') { r.pct = ev.total ? Math.round(((ev.done ?? 0) / ev.total) * 100) : 0; r.meta = `${ev.name ?? ''} · ${formatBytes(ev.done ?? 0)}${ev.total ? ` / ${formatBytes(ev.total)}` : ''}${ev.ofFiles ? ` · ${localDigits(ev.files ?? 0)}/${localDigits(ev.ofFiles)}` : ''}`; notify('progress', id); }
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
    const job = waiting.shift() as QJob; running.set(job.id, { job, pct: 0, meta: '' }); moved = true;
    void Promise.resolve().then(() => job.start()).then((ok) => { if (!ok) finish(job.id); }, () => finish(job.id));
  }
  if (moved) { persist(); notify('list'); }
  sync();
};
/** A job asked for: starts at once when it may, else waits. Resolves to where it stands. */
export const enqueue = (job: QJob, h0: QHost): 'running' | 'waiting' => {
  host = h0; waiting.push(job); persist(); sync(); notify('list'); pump();
  return running.has(job.id) ? 'running' : 'waiting';
};
/** `id` is a part of a running job (an extraction's move into place): its events and its end are the job's. */
export const link = (partId: string, jobId: string) => { alias.set(partId, jobId); };
export const progress = (id: string, pct: number, meta: string) => { const r = running.get(alias.get(id) ?? id); if (r) { r.pct = pct; r.meta = meta; notify('progress', r.job.id); } };
export const finish = (id0: string) => {
  const id = alias.get(id0) ?? id0; if (!running.delete(id)) return;
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
export const cancelRunning = (id: string) => { running.get(id)?.job.cancel(); };
/** The setting changed: «Together» starts everything that waits. */
export const modeChanged = () => pump();

/* ---------- what an earlier run left ---------- */
export const unfinished = (): Saved[] => readSaved(LEFT);
export const dropUnfinished = () => store(LEFT, null);
/** «Unfinished jobs: n» with Resume / Discard; nothing is run until Resume. Returns what removes the snackbar. */
export function offerUnfinished(resume: (s: Saved[]) => void): () => void {
  const list = unfinished(); if (!list.length) return () => undefined;
  const el = h('div', { class: 'toast with-action undo-snack files-unfinished', role: 'status' }, h('span', { class: 'grow' }, t('filesUnfinished', { n: localDigits(list.length) })),
    h('button', { type: 'button', class: 'toast-act', onclick: () => { el.remove(); dropUnfinished(); resume(list); } }, t('filesResumeJobs')),
    h('button', { type: 'button', class: 'toast-act', onclick: () => { el.remove(); dropUnfinished(); } }, t('filesDiscard')));
  document.body.appendChild(el); return () => el.remove();
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
