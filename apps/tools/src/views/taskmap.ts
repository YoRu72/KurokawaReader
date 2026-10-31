// Prism's details visuals: the file map (one bar, every connection's range in its own colour, filled as far as
// it got), the connection lanes (one per active connection with its range and speed), a speed chart of the
// last two minutes, and a log of what happened (started, connections learned, retries, done).
import { h } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import type { Task } from '../engine/types';

const COLOURS = ['#4fc3f7', '#81c784', '#ffb74d', '#ba68c8', '#e57373', '#4db6ac', '#fff176', '#90a4ae'];
export interface TaskHistory { speeds: { t: number; v: number }[]; log: { t: number; text: string }[]; lastState?: string; lastConn?: number }
const histories = new Map<string, TaskHistory>();
export function historyOf(x: Task): TaskHistory {
  let hst = histories.get(x.id); if (!hst) { hst = { speeds: [], log: [{ t: x.addedAt, text: t('logAdded') }] }; histories.set(x.id, hst); }
  const now = Date.now();
  if (x.state === 'downloading' || x.state === 'seeding') { const last = hst.speeds[hst.speeds.length - 1]; if (!last || now - last.t >= 900) { hst.speeds.push({ t: now, v: x.downSpeed }); if (hst.speeds.length > 130) hst.speeds.shift(); } }
  if (hst.lastState !== x.state) { if (hst.lastState !== undefined) hst.log.push({ t: now, text: t('logState', { s: x.state === 'done' ? t('stateDone') : x.state === 'failed' ? t('stateFailed') + (x.error ? `: ${x.error}` : '') : x.state === 'paused' ? t('statePaused') : x.state === 'downloading' ? t('stateDownloading') : x.state }) }); hst.lastState = x.state; }
  if (x.connections !== undefined && x.connections !== hst.lastConn && x.state === 'downloading') { if (hst.lastConn !== undefined) hst.log.push({ t: now, text: t('logConnections', { n: x.connections }) }); hst.lastConn = x.connections; }
  if (hst.log.length > 60) hst.log.splice(0, hst.log.length - 60);
  return hst;
}

export function fileMap(x: Task): HTMLElement | null {
  const total = x.total; if (!total) return null;
  const segs = x.segments ?? []; const bar = h('div', { class: 'filemap', title: t('fileMapHint') });
  if (!segs.length) { bar.append(h('i', { class: 'done', style: { insetInlineStart: '0', width: `${(x.done / total) * 100}%`, background: COLOURS[0] } })); return bar; }
  for (const s of segs) { const w = ((s.end - s.start) / total) * 100; const f = (s.pos - s.start) / Math.max(1, s.end - s.start); bar.append(h('i', { class: 'seg' + (s.active ? ' active' : ''), style: { insetInlineStart: `${(s.start / total) * 100}%`, width: `${w}%` } }, h('b', { style: { width: `${f * 100}%`, background: COLOURS[s.worker % COLOURS.length] } }))); }
  return bar;
}
export function lanes(x: Task): HTMLElement | null {
  const act = (x.segments ?? []).filter((s) => s.active); if (!act.length || !x.total) return null;
  const total = x.total;
  return h('div', { class: 'lanes' }, ...act.slice(0, 12).map((s) => h('div', { class: 'lane' },
    h('span', { class: 'lane-id', style: { background: COLOURS[s.worker % COLOURS.length] } }, localDigits(s.worker + 1)),
    h('span', { class: 'lane-track' }, h('i', { style: { insetInlineStart: `${(s.start / total) * 100}%`, width: `${((s.end - s.start) / total) * 100}%` } }, h('b', { style: { width: `${((s.pos - s.start) / Math.max(1, s.end - s.start)) * 100}%`, background: COLOURS[s.worker % COLOURS.length] } }))),
    h('small', { class: 'src', dir: 'ltr' }, `${formatBytes(s.start)}–${formatBytes(s.end)}${s.speed ? ` · ${formatBytes(s.speed)}/s` : ''}`))), act.length > 12 ? h('small', { class: 'src' }, t('andMore', { n: act.length - 12 })) : null);
}
export function speedChart(hst: TaskHistory): HTMLElement | null {
  const pts = hst.speeds; if (pts.length < 2) return null;
  const W = 600, H = 120; const max = Math.max(1, ...pts.map((p) => p.v)); const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const xy = pts.map((p) => [((p.t - t0) / Math.max(1, t1 - t0)) * W, H - (p.v / max) * (H - 10)] as const);
  const line = xy.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="speed-chart"><defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".45"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>${[0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${(H - 10) * (1 - f) + 10}" y2="${(H - 10) * (1 - f) + 10}" class="grid"/>`).join('')}<path d="${area}" fill="url(#sg)"/><path d="${line}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
  const wrap = h('div', { class: 'speed-wrap' }); wrap.innerHTML = svg;
  wrap.append(h('div', { class: 'speed-legend' }, h('small', null, `${formatBytes(max)}/s`), h('small', null, `${formatBytes(pts[pts.length - 1].v)}/s`)));
  return wrap;
}
export function logList(hst: TaskHistory): HTMLElement {
  return h('div', { class: 'task-log' }, ...hst.log.slice(-12).reverse().map((l) => h('div', { class: 'log-row' }, h('small', { class: 'src', dir: 'ltr' }, new Date(l.t).toLocaleTimeString()), h('span', null, l.text))));
}
