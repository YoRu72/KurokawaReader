// A clip cut in the background: ffmpeg runs on, the player closed or not, its progress in a small card that stays
// on whatever page you go to and, on a phone, in the notifications (a percentage); a pop-up when it is done, with
// the clip to open. Each way of encoding given (the phone's own encoder, then x264, then ffmpeg's MPEG-4) is
// tried in turn until one works; a failure says ffmpeg's own reason, not its last line.
import { h, icon, toast } from '../ui/dom';
import { t, localDigits, formatBytes } from '../i18n';
import { ktPlugin } from '../native';

type Progress = { id: string; time: number; size?: number; speed?: number };
type Desk = { ffmpeg(o: { id: string; args: string[] }): Promise<{ code: number; log: string }>; ffmpegCancel(id: string): Promise<void>; onFfmpegProgress(cb: (p: Progress) => void): () => void };
type Plug = { ffmpeg(o: { id: string; args: string[] }): Promise<{ code: number; log: string }>; ffmpegCancel(o: { id: string }): Promise<void>; addListener(ev: string, cb: (p: Progress) => void): Promise<{ remove(): void }>; progressNote?(o: { id: string; title: string; text: string; percent?: number; done?: boolean; failed?: boolean }): Promise<void>; mediaScan?(o: { path: string }): Promise<void>; openWith?(o: { path: string; mime: string; title: string }): Promise<void> };
const desk = (): Desk | null => { const d = window.kurokawaTools as unknown as Desk | undefined; return d?.ffmpeg ? d : null; };
const plug = (): Plug | null => { const p = ktPlugin() as unknown as Plug | null; return p?.ffmpeg ? p : null; };

export interface ClipRun { id: string; title: string; out: string; mime: string; total: number; attempts: string[][]; from?: number; srcName: string }

/** ffmpeg's reason in its log: the lines that say what went wrong, not the progress line nor «Conversion failed!». */
export function ffmpegReason(log: string): string {
  const lines = log.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).filter((x) => !/^(frame|size|time|bitrate|speed|progress|out_time|fps|stream_\d|dup_frames|drop_frames|total_size)=/i.test(x) && !/Conversion failed!?$/i.test(x));
  const bad = lines.filter((x) => /error|invalid|not supported|unsupported|unknown|failed|could not|cannot|can't|no such|does not|unable|incompatible/i.test(x));
  return (bad.length ? bad.slice(-2) : lines.slice(-2)).join(' — ').replace(/\[[a-z0-9_]+ @ 0x[0-9a-f]+\]\s*/gi, '').slice(0, 300);
}

let tray: HTMLElement | null = null;
const trayEl = () => { if (!tray || !tray.isConnected) { tray = h('div', { class: 'clip-tray', role: 'status' }); document.body.append(tray); } return tray; };
const fmt = (s: number) => { const m = Math.floor(s / 60), x = s - m * 60; return `${m}:${x.toFixed(1).padStart(4, '0')}`; };

export async function runClip(o: ClipRun): Promise<void> {
  const d = desk(); const p = plug(); if (!d && !p) return;
  const bar = h('div', { class: 'task-bar thin' }, h('i', { style: { width: '2%' } })); const line = h('small', { dir: 'auto' }, t('cutPreparing'));
  let cancelled = false; let runId = o.id;
  const stopBtn = h('button', { type: 'button', class: 'icon-btn', title: t('cancel'), 'aria-label': t('cancel'), onclick: () => { cancelled = true; void (d ? d.ffmpegCancel(runId) : p!.ffmpegCancel({ id: runId })).catch(() => undefined); } }, icon('close'));
  const card = h('div', { class: 'get-card clip-card' }, h('div', { class: 'get-head' }, h('span', { class: 'get-ic' }, icon('scissors')), h('div', { class: 'grow' }, h('b', { dir: 'auto' }, o.title), line), stopBtn), bar);
  trayEl().append(card);
  toast(t('clipBackground'));
  let lastNote = -1; let lastAt = 0;
  const note = (pct: number) => { const now = Date.now(); if (pct === lastNote || now - lastAt < 900) return; lastNote = pct; lastAt = now; void p?.progressNote?.({ id: o.id, title: t('clipCutting'), text: `${o.title} · ${localDigits(pct)}%`, percent: pct }).catch(() => undefined); };
  const onP = (pr: Progress) => { if (pr.id !== runId) return; const f = Math.max(0, Math.min(1, pr.time / Math.max(0.1, o.total))); const pct = Math.round(f * 100); (bar.firstChild as HTMLElement).style.width = `${Math.max(2, pct)}%`; line.textContent = `${localDigits(pct)}%${pr.speed ? ` · ${localDigits(pr.speed.toFixed(1))}×` : ''}${pr.size ? ` · ${formatBytes(pr.size)}` : ''}`; note(pct); };
  const off: (() => void) | { remove(): void } | null = d ? d.onFfmpegProgress(onP) : await p!.addListener('ffmpegProgress', onP);
  note(0);
  let reason = '';
  try {
    for (let i = 0; i < o.attempts.length && !cancelled; i++) {
      runId = i ? `${o.id}-${i}` : o.id;
      const r = await (d ? d.ffmpeg({ id: runId, args: o.attempts[i] }) : p!.ffmpeg({ id: runId, args: o.attempts[i] })).catch((e: unknown) => ({ code: -1, log: String((e as Error).message ?? e) }));
      if (r.code === 0) { reason = ''; break; }
      reason = ffmpegReason(r.log) || `ffmpeg ${r.code}`;
    }
  } finally { if (off) { if (typeof off === 'function') off(); else off.remove(); } }
  stopBtn.remove(); card.classList.add('done');
  const leave = () => { card.classList.add('leaving'); setTimeout(() => card.remove(), 200); };
  if (cancelled) { line.textContent = t('cancelled'); void p?.progressNote?.({ id: o.id, title: t('cancelled'), text: o.title, done: true }).catch(() => undefined); setTimeout(leave, 2500); return; }
  if (reason) {
    line.textContent = reason; card.classList.add('failed'); card.append(h('div', { class: 'get-acts' }, h('button', { type: 'button', class: 'btn small text', onclick: leave }, t('close'))));
    void p?.progressNote?.({ id: o.id, title: t('clipFailed'), text: reason, done: true, failed: true }).catch(() => undefined);
    toast(`${t('clipFailed')}: ${reason}`, 'error', 8000); return;
  }
  // Done: said in a pop-up and the notifications, with the clip to open.
  void p?.mediaScan?.({ path: o.out }).catch(() => undefined);
  const open = () => { if (p?.openWith) void p.openWith({ path: o.out, mime: o.mime, title: o.srcName }).catch((er) => toast(String((er as Error).message ?? er), 'error')); else void import('../native').then((n) => n.openFolder(o.out)); };
  (bar.firstChild as HTMLElement).style.width = '100%';
  line.textContent = o.from !== undefined ? t('clipDoneFrom', { at: fmt(o.from) }) : t('clipSaved');
  card.append(h('div', { class: 'get-acts' }, h('button', { type: 'button', class: 'btn small text', onclick: leave }, t('close')), h('button', { type: 'button', class: 'btn small primary', onclick: () => { open(); leave(); } }, icon('external'), p?.openWith ? t('open') : t('showInFolder'))));
  setTimeout(leave, 15000);
  void p?.progressNote?.({ id: o.id, title: t('clipSaved'), text: o.title, done: true }).catch(() => undefined);
  toast(t('clipSavedName', { name: o.title }), 'info', 7000, { label: p?.openWith ? t('open') : t('showInFolder'), run: open });
}
