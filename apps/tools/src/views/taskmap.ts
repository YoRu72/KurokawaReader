// Prism's details visuals, drawn the way Prism draws them: the meter (the percentage large, what is done of the
// whole, speed, time left, connections), the file map (every connection's range in its own colour, filled as far
// as it got, a write-head where it is writing), the connection lanes (one per active connection, numbered, with its
// range and speed), the speed chart (a smoothed area over the last two minutes with its scale, a dot at the present,
// and Now · Average · Peak · Time left beneath), a sparkline for the list, an Info list whose values copy with a
// tap, and a log of what happened.
import { h, icon, toast } from '../ui/dom';
import { t, formatBytes, localDigits, formatDate } from '../i18n';
import type { Task } from '../engine/types';

const SPECTRUM = ['#5ac8fa', '#64d2a0', '#ffb340', '#bf8cff', '#ff6b6b', '#40c8c0', '#ffd60a', '#9aa7b8'];
const colourOf = (i: number) => (i < 0 ? 'var(--md-outline)' : SPECTRUM[i % SPECTRUM.length]); // (-1: done before a resume)
export interface TaskHistory { speeds: number[]; ups: number[]; at: number; log: { t: number; text: string }[]; lastState?: string; lastConn?: number; startedAt?: number }
const histories = new Map<string, TaskHistory>();
const CAP = 120;
/** The task's history, one speed sample a second (the last two minutes kept). */
export function historyOf(x: Task): TaskHistory {
  let hst = histories.get(x.id); if (!hst) { hst = { speeds: [], ups: [], at: 0, log: [{ t: x.addedAt, text: t('logAdded') }] }; histories.set(x.id, hst); }
  const now = Date.now();
  if ((x.state === 'downloading' || x.state === 'seeding' || x.state === 'metadata') && now - hst.at >= 900) {
    hst.at = now; hst.speeds.push(x.downSpeed || 0); hst.ups.push(x.upSpeed || 0);
    if (hst.speeds.length > CAP) { hst.speeds.shift(); hst.ups.shift(); }
    hst.startedAt ??= now;
  }
  if (hst.lastState !== x.state) { if (hst.lastState !== undefined) hst.log.push({ t: now, text: t('logState', { s: x.state === 'done' ? t('stateDone') : x.state === 'failed' ? t('stateFailed') + (x.error ? `: ${x.error}` : '') : x.state === 'paused' ? t('statePaused') : x.state === 'downloading' ? t('stateDownloading') : x.state }) }); hst.lastState = x.state; }
  if (x.connections !== undefined && x.connections !== hst.lastConn && x.state === 'downloading') { if (hst.lastConn !== undefined) hst.log.push({ t: now, text: t('logConnections', { n: x.connections }) }); hst.lastConn = x.connections; }
  if (hst.log.length > 60) hst.log.splice(0, hst.log.length - 60);
  return hst;
}
export const average = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const perSec = (n: number) => t('perSecond', { n: formatBytes(n) });

/** A smooth path (Catmull-Rom as cubic Béziers) through the samples, scaled into w×h. */
export function smoothPath(values: number[], w: number, h: number, max?: number, pad = 2): { line: string; area: string } {
  if (values.length < 2) return { line: '', area: '' };
  const top = (max ?? Math.max(...values, 1)) * 1.1 || 1; const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - pad - (Math.max(0, v) / top) * (h - pad * 2)] as const); const f = (n: number) => n.toFixed(1);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const c1y = Math.min(h, Math.max(0, p1[1] + (p2[1] - p0[1]) / 6)), c2y = Math.min(h, Math.max(0, p2[1] - (p3[1] - p1[1]) / 6));
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(c1y)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return { line: d, area: `${d}L${f(w)} ${h}L0 ${h}Z` };
}
/** A round top for the scale (256 KB/s, 1, 2, 4, 5, 10 … MB/s). */
export function niceMax(v: number): number {
  const mb = 1048576; const steps = [256 * 1024, 512 * 1024, mb, 2 * mb, 4 * mb, 5 * mb, 10 * mb, 20 * mb, 25 * mb, 40 * mb, 50 * mb, 80 * mb, 100 * mb, 200 * mb, 400 * mb, 1000 * mb];
  return steps.find((s) => s >= v * 1.05) ?? v * 1.2;
}
let gid = 0;
const svgEl = (markup: string, cls: string) => { const w = h('div', { class: cls }); w.innerHTML = markup; return w; };

/** The speed chart (the last two minutes) with its scale, and Now · Average · Peak · Time left. */
export function speedChart(hst: TaskHistory, x: Task): HTMLElement {
  const samples = hst.speeds.length > 1 ? hst.speeds : [0, 0]; const W = 300, H = 100; const max = niceMax(Math.max(...samples, 1)); const id = `kt-sg${++gid}`;
  const { line, area } = smoothPath(samples, W, H, max / 1.1, 3);
  const ticks = [0.25, 0.5, 0.75, 1]; const last = samples[samples.length - 1] ?? 0; const lastY = H - 3 - (last / max) * (H - 6);
  const chart = svgEl(`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".38"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>${ticks.map((k) => `<path d="M0 ${H - k * H}H${W}" class="grid" vector-effect="non-scaling-stroke"/>`).join('')}<path d="${area}" fill="url(#${id})"/><path d="${line}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`, 'kt-chart');
  for (const k of ticks) chart.append(h('span', { class: 'kt-chart-y', style: { top: `${(1 - k) * 100}%` } }, `${formatBytes(max * k)}/s`));
  if (hst.speeds.length > 1) chart.append(h('span', { class: 'kt-chart-dot', style: { top: `${(lastY / H) * 100}%` } }));
  const live = x.state === 'downloading' || x.state === 'metadata';
  return h('div', { class: 'kt-speed' }, h('div', { class: 'kt-ph' }, t('speedTitle'), h('small', null, t('speedWindow'))), chart,
    h('div', { class: 'kt-stats' }, stat(t('statNow'), live ? perSec(x.downSpeed) : '—'), stat(t('statAverage'), perSec(average(hst.speeds))), stat(t('statPeak'), perSec(Math.max(0, ...hst.speeds))), stat(t('statLeft'), live && x.eta ? fmtSecs(x.eta) : '—')));
}
const stat = (k: string, v: string) => h('div', { class: 'kt-stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v', dir: 'ltr' }, v));
export function fmtSecs(s: number): string { s = Math.max(0, Math.round(s)); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return localDigits(hh ? `${hh}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`); }

/** A small speed line for a task's card in the list. */
export function sparkline(hst: TaskHistory): HTMLElement | null {
  if (hst.speeds.length < 3) return null; const W = 120, H = 22; const id = `kt-sp${++gid}`;
  const { line, area } = smoothPath(hst.speeds.slice(-60), W, H, undefined, 2);
  return svgEl(`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".32"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#${id})"/><path d="${line}" fill="none" stroke="currentColor" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`, 'kt-spark');
}

/** The meter: the percentage large, done of the whole, speed, time left, connections. */
export function meter(x: Task): HTMLElement {
  const pct = x.total ? (x.done / x.total) * 100 : x.state === 'done' ? 100 : null; const live = x.state === 'downloading' || x.state === 'metadata';
  const act = (x.segments ?? []).filter((s) => s.active && s.pos < s.end).length;
  return h('div', { class: 'kt-meter' },
    h('div', { class: 'kt-meter-row' },
      h('div', { class: 'kt-pct', dir: 'ltr' }, pct == null ? '—' : localDigits(pct >= 99.95 || pct === 0 ? Math.round(pct) : pct.toFixed(1)), h('small', null, '%')),
      h('div', { class: 'kt-of' }, t('bytesOf', { done: formatBytes(x.done), total: x.total ? formatBytes(x.total) : '?' })),
      h('div', { class: 'kt-kpis' },
        kpi(t('statSpeed'), live ? perSec(x.downSpeed) : '—'), kpi(t('statLeft'), live && x.eta ? fmtSecs(x.eta) : '—'),
        ...(x.kind === 'torrent' ? [kpi(t('statPeers'), `${localDigits(x.peers ?? 0)} · ${localDigits(x.seeds ?? 0)}`)] : x.connections || act ? [kpi(t('connectionsTitle'), `${localDigits(act || x.connections || 0)}${x.connections ? ` / ${localDigits(x.connections)}` : ''}`)] : []))),
    h('div', { class: 'task-bar big' + (x.total || x.state === 'done' ? '' : ' busy-any') + ` state-${x.state}` }, h('i', { style: { width: `${pct ?? 0}%` } })));
}
const kpi = (k: string, v: string) => h('div', { class: 'kt-kpi' }, h('div', { class: 'k' }, k), h('div', { class: 'v', dir: 'ltr' }, v));

/** The whole file: every connection's range in its colour, filled as far as it got; the live ones with a head. */
export function fileMap(x: Task): HTMLElement | null {
  const total = x.total; if (!total) return null;
  const segs = x.segments ?? [];
  const bar = h('div', { class: 'kt-segbar', role: 'img', 'aria-label': t('segmentsN', { n: localDigits(segs.length || 1) }) });
  if (!segs.length) bar.append(h('span', { class: 'kt-seg', style: { insetInlineStart: '0', width: '100%' } }, h('b', { style: { width: `${(x.done / total) * 100}%`, background: colourOf(0) } })));
  segs.forEach((s, i) => { const span = Math.max(1, s.end - s.start); const f = Math.min(1, (s.pos - s.start) / span);
    bar.append(h('span', { class: 'kt-seg' + (s.active && s.pos < s.end ? ' active' : ''), style: { left: `${(s.start / total) * 100}%`, width: `${(span / total) * 100}%` } }, h('b', { style: { width: `${f * 100}%`, background: colourOf(s.worker ?? i) } }))); });
  return h('div', { class: 'kt-map' }, h('span', null, t('fileMapTitle')), bar, h('span', { class: 'kt-num' }, t('segmentsN', { n: localDigits(segs.length || 1) })));
}
/** One lane for each connection at work: its number, how far into its range, the range, its speed. */
export function lanes(x: Task, max = 12): HTMLElement {
  const act = (x.segments ?? []).filter((s) => s.active);
  if (x.state === 'done') return h('p', { class: 'kt-empty' }, t('lanesDone'));
  if (!act.length) return h('p', { class: 'kt-empty' }, t('lanesNone'));
  return h('div', { class: 'kt-lanes' }, ...act.slice(0, max).map((s, i) => { const f = Math.min(1, (s.pos - s.start) / Math.max(1, s.end - s.start));
    return h('div', { class: 'kt-lane', style: { '--c': colourOf(s.worker ?? i) } }, h('span', { class: 'kt-lane-id', dir: 'ltr' }, String((s.worker ?? i) + 1).padStart(2, '0')),
      h('span', { class: 'kt-lane-track' }, h('span', { class: 'kt-lane-fill', style: { transform: `scaleX(${f})` } }), h('span', { class: 'kt-lane-head', style: { left: `calc(${f * 100}% - 1px)` } })),
      h('span', { class: 'kt-lane-range', dir: 'ltr' }, `${formatBytes(s.start)}–${formatBytes(s.end)}`), h('span', { class: 'kt-lane-speed', dir: 'ltr' }, s.speed ? perSec(s.speed) : '')); }),
    act.length > max ? h('p', { class: 'kt-empty' }, t('lanesMore', { n: localDigits(act.length - max) })) : null);
}

/** What there is to know, each value copied with a tap. */
export function infoList(x: Task, extra: [string, string][] = []): HTMLElement {
  const where = x.dir ? `${x.dir.replace(/[\\/]$/, '')}/${x.files.length === 1 && x.kind !== 'torrent' ? x.files[0].path : x.name}` : '';
  const rows: ([string, string, boolean?] | null)[] = [
    x.source.url ? [t('infoAddress'), x.source.url, true] : null,
    x.source.magnet ? [t('infoMagnet'), x.source.magnet, true] : null,
    x.infoHash ? [t('infoHash'), x.infoHash, true] : null,
    where ? [t('infoSavedTo'), where, true] : null,
    [t('infoSize'), x.total ? `${formatBytes(x.total)} (${localDigits(x.total.toLocaleString('en'))} B)` : '—'],
    x.connections ? [t('connectionsTitle'), localDigits(x.connections)] : null,
    [t('infoAdded'), formatDate(x.addedAt)],
    x.doneAt ? [t('infoFinished'), formatDate(x.doneAt)] : null,
    x.doneAt && x.addedAt ? [t('infoTook'), fmtSecs((x.doneAt - x.addedAt) / 1000)] : null,
    ...extra.map(([k, v]) => [k, v] as [string, string]),
  ];
  return h('dl', { class: 'kt-kv' }, ...rows.filter((r): r is [string, string, boolean?] => !!r).map(([k, v, copy]) => h('div', { class: 'kt-kv-row' }, h('dt', null, k),
    h('dd', { dir: copy ? 'ltr' : 'auto', class: copy ? 'mono' : '' }, h('span', { class: 'sel', onclick: (e: Event) => (e.currentTarget as HTMLElement).classList.toggle('open') }, v), copy ? h('button', { type: 'button', class: 'kt-copy', 'aria-label': t('copyField', { f: k }), onclick: () => void navigator.clipboard?.writeText(v).then(() => toast(t('copied'))) }, icon('copy')) : null))));
}
export function logList(hst: TaskHistory): HTMLElement {
  return h('div', { class: 'task-log' }, ...hst.log.slice(-12).reverse().map((l) => h('div', { class: 'log-row' }, h('small', { class: 'src', dir: 'ltr' }, new Date(l.t).toLocaleTimeString()), h('span', null, l.text))));
}
