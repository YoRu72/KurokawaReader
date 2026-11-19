// SPDX-License-Identifier: GPL-3.0-or-later
// Device battery, W2: a device's battery history (after the original's v1.1.0 «Battery history…» window — BatteryHub,
// GPL-3.0-or-later; NOTICE.md). Loaded on first use from battery.ts. A sheet: the last 24 hours, 7 days or 30 days; a
// sentence saying what the period holds (it is also the chart's text for a screen reader); the time-left estimate or
// why there is none; the level over time drawn by us in SVG — the app's accent for the line, red only below the low
// mark, blue where it was charging (a band behind and the line itself), gaps where the device was away or nobody looked;
// a reading's time and value under the pointer, a tap or the arrow keys; «Clear this device's history» after a question.
// Right to left: time runs from the right (oldest) to the left (now), the level's labels on the right. No timers, no
// listeners outside the sheet's own elements.
import { h, openSheet, toast } from '../ui/dom';
import { getLang, localDigits } from '../i18n';
import { osT as t } from './batplat';

type Lvl = { kind: 'exact'; value: number } | { kind: 'coarse'; value: string; bars: number } | { kind: 'steps'; value: number; max: number } | { kind: 'unknown' };
export type HistPoint = { t: number; level: Lvl | null; charging: 'yes' | 'no' | 'unknown' };
export type HistEstimate = { state: 'empty' | 'full' | 'none'; minutes?: number; perHour?: number; samples?: number; why?: string };
export type HistReply = { key: string; on: boolean; days: number; now: number; since: number; gap: number; points: HistPoint[];
  stats: { count: number; lowest: number | null; highest: number | null; first: number | null; last: number | null }; estimate: HistEstimate };
export type Range = 'day' | 'week' | 'month';
export type HistDesk = { batteryHistory(o: { key: string; range: Range }): Promise<HistReply>; batteryHistoryClear(o: { key: string }): Promise<boolean> };
/** What battery.ts lends: its words for a level and a duration, the device's low mark. */
export type HistCtx = { name: string; low: number; levelText: (l: Lvl) => string; durText: (min: number) => string; cleared?: () => void };

const CSS = `
.bat-hist { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.bat-hist-range { display: flex; gap: 8px; flex-wrap: wrap; }
.bat-hist-range > button { flex: 1 1 0; min-width: 96px; height: 40px; padding: 0 12px; border-radius: 20px; border: 1px solid var(--md-outline-variant); background: transparent; color: var(--md-on-surface); font: inherit; font-size: 13.5px; cursor: pointer; }
.bat-hist-range > button[aria-pressed="true"] { background: var(--md-secondary-container); color: var(--md-on-secondary-container); border-color: transparent; font-weight: 600; }
.bat-hist-range > button:focus-visible, .bat-hist-chart svg:focus-visible { outline: 2px solid var(--md-primary); outline-offset: 2px; }
.bat-hist-sum, .bat-hist-est, .bat-hist-note { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--md-on-surface-variant); }
.bat-hist-sum { color: var(--md-on-surface); }
.bat-hist-chart { position: relative; min-height: 240px; border-radius: 18px; background: var(--md-surface-container); padding: 8px 4px 4px; }
.bat-hist-chart svg { display: block; width: 100%; height: 240px; border-radius: 12px; touch-action: pan-y; }
.bat-hist-chart .grid { stroke: var(--md-outline-variant); stroke-width: 1; }
.bat-hist-chart .lowline { stroke: var(--md-error); stroke-width: 1; stroke-dasharray: 3 4; opacity: .55; }
.bat-hist-chart text { fill: var(--md-on-surface-variant); font-size: 11px; font-family: inherit; }
.bat-hist-chart .ln { fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.bat-hist-chart .ln.acc { stroke: var(--md-primary); }
.bat-hist-chart .ln.low { stroke: var(--md-error); }
.bat-hist-chart .ln.chg { stroke: var(--bat-blue); }
.bat-hist-chart .band { fill: var(--bat-blue); opacity: .16; }
.bat-hist-chart .dot { stroke: none; }
.bat-hist-chart .dot.acc { fill: var(--md-primary); } .bat-hist-chart .dot.low { fill: var(--md-error); } .bat-hist-chart .dot.chg { fill: var(--bat-blue); }
.bat-hist-chart .guide { stroke: var(--md-on-surface-variant); stroke-width: 1; opacity: .6; }
.bat-hist-chart .mark { fill: var(--md-surface); stroke-width: 2.4; }
.bat-hist-tip { position: absolute; top: 10px; transform: translateX(-50%); max-width: 70%; padding: 6px 10px; border-radius: 10px; background: var(--md-inverse-surface, #2f3036); color: var(--md-inverse-on-surface, #f1f0f7); font-size: 12.5px; line-height: 1.35; pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bat-hist-empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; font-size: 13.5px; line-height: 1.5; color: var(--md-on-surface-variant); }
.bat-hist-legend { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 12.5px; color: var(--md-on-surface-variant); }
.bat-hist-legend > span { display: inline-flex; align-items: center; gap: 6px; }
.bat-hist-legend i { display: inline-block; width: 18px; height: 4px; border-radius: 2px; }
.bat-hist-legend i.acc { background: var(--md-primary); } .bat-hist-legend i.low { background: var(--md-error); } .bat-hist-legend i.chg { background: var(--bat-blue); }
.sheet .bat-hist-ask { margin: 0 4px 6px; line-height: 1.55; }
.sheet .bat-hist-clear { color: var(--md-error); }
html { --bat-blue: #1f88d6; }
html:not([data-ui='light']) { --bat-blue: #7cc4f8; }
`;
function style(): void {
  if (document.getElementById('kt-bathist-css')) return;
  const s = document.createElement('style'); s.id = 'kt-bathist-css'; s.textContent = CSS; document.head.append(s);
}

const NS = 'http://www.w3.org/2000/svg';
function sv(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}
/** A reading's height on the chart: a percentage as it is; steps and words by their share (said as words in the tip). */
export function share(l: Lvl | null): number | null {
  if (!l) return null;
  if (l.kind === 'exact') return l.value;
  if (l.kind === 'steps') return Math.round(100 * l.value / Math.max(1, l.max));
  if (l.kind === 'coarse') return Math.round(100 * l.bars / 5);
  return null;
}
const kindOf = (l: Lvl): string => (l.kind === 'steps' ? `s${l.max}` : l.kind);
/** The chart's runs (as kt-battery history.rs runs): split at «away», at a change of kind, and over `gap` ms. */
export function runs(points: HistPoint[], gap: number): [number, number][] {
  const out: [number, number][] = []; let from = -1;
  points.forEach((p, i) => {
    if (!p.level || p.level.kind === 'unknown') { if (from >= 0) out.push([from, i - 1]); from = -1; return; }
    if (from < 0) { from = i; return; }
    const q = points[i - 1];
    if (p.t - q.t > gap || !q.level || kindOf(q.level) !== kindOf(p.level)) { out.push([from, i - 1]); from = i; }
  });
  if (from >= 0) out.push([from, points.length - 1]);
  return out;
}

let lastRange: Range = 'week';
const loc = (): string => { const l = getLang(); return l === 'ar' ? 'ar-u-nu-latn' : l; };
const fmt = (ms: number, o: Intl.DateTimeFormatOptions): string => localDigits(new Intl.DateTimeFormat(loc(), o).format(new Date(ms)));

/** Opens the history sheet of one device. */
export function openHistory(d: HistDesk, key: string, ctx: HistCtx): void {
  style();
  const sh = openSheet(t('batHistoryFor', { name: '⁨' + ctx.name + '⁩' }), t('close'));
  sh.el.classList.add('bat-hist-sheet');
  const rtl = document.documentElement.dir === 'rtl';
  const rangeBox = h('div', { class: 'bat-hist-range', role: 'group', 'aria-label': t('batHistRange') });
  const sum = h('p', { class: 'bat-hist-sum', id: 'bat-hist-sum', dir: 'auto' });
  const est = h('p', { class: 'bat-hist-est', dir: 'auto', title: t('batEstHint') });
  const note = h('p', { class: 'bat-hist-note' }); note.hidden = true;
  const chart = h('div', { class: 'bat-hist-chart' });
  const legend = h('div', { class: 'bat-hist-legend', 'aria-hidden': 'true' },
    h('span', null, h('i', { class: 'acc' }), t('batHistLegendLevel')), h('span', null, h('i', { class: 'chg' }), t('batHistLegendCharging')), h('span', null, h('i', { class: 'low' }), t('batHistLegendLow')));
  const wrap = h('div', { class: 'bat-hist' }, rangeBox, sum, est, chart, legend, note);
  sh.body.append(wrap);
  const clearBtn = h('button', { type: 'button', class: 'btn text bat-hist-clear', 'data-act': 'historyClear', onclick: () => ask() }, t('batHistClear'));
  sh.actions.append(clearBtn);
  let seq = 0;
  const buttons = (['day', 'week', 'month'] as const).map((r) => h('button', { type: 'button', 'data-range': r, 'aria-pressed': String(r === lastRange), onclick: () => { lastRange = r; for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.range === r)); void load(); } }, t(`batRange_${r}`)));
  rangeBox.append(...buttons);

  const pct = (n: number | null) => (n === null ? '—' : t('batPct', { n: localDigits(n) }));
  const estText = (e: HistEstimate): string => {
    if ((e.state === 'empty' || e.state === 'full') && typeof e.minutes === 'number') {
      const main = t(e.state === 'empty' ? 'batEstLeft' : 'batEstFull', { d: ctx.durText(e.minutes) });
      const rate = typeof e.perHour === 'number' ? ' ' + t('batEstRate', { rate: t('batPct', { n: localDigits(e.perHour < 10 ? e.perHour.toFixed(1) : Math.round(e.perHour)) }), n: localDigits(e.samples ?? 0) }) : '';
      return main + '.' + rate;
    }
    return t(`batEstNone_${e.why ?? 'collecting'}` as 'batEstNone_collecting');
  };

  async function load(): Promise<void> {
    const my = ++seq; const range = lastRange;
    let r: HistReply;
    try { r = await d.batteryHistory({ key, range }); } catch (e) { if (my === seq) { sum.textContent = String((e as Error)?.message ?? e); chart.replaceChildren(); } return; }
    if (my !== seq || !wrap.isConnected) return;
    const words = r.points.some((p) => p.level && p.level.kind !== 'exact' && p.level.kind !== 'unknown') && r.stats.lowest === null;
    const rangeWord = t(`batRange_${range}`);
    sum.textContent = r.stats.count === 0 ? t('batHistNone') : words ? t('batHistSummaryWords', { range: rangeWord, n: localDigits(r.stats.count) })
      : t('batHistSummary', { range: rangeWord, n: localDigits(r.stats.count), low: pct(r.stats.lowest), high: pct(r.stats.highest), last: pct(r.stats.last) });
    est.textContent = estText(r.estimate); est.dataset.state = r.estimate.state;
    note.hidden = r.on; note.textContent = r.on ? '' : t('batHistOffNote');
    clearBtn.disabled = r.stats.count === 0 && !r.points.length;
    draw(r, range);
  }

  function draw(r: HistReply, range: Range): void {
    chart.replaceChildren();
    const W = Math.max(280, Math.round(chart.clientWidth - 8 || 560)); const H = 240;
    const padS = 44, padE = 14, top = 14, bottom = 28;
    const L = rtl ? padE : padS, R = rtl ? W - padS : W - padE, plotW = R - L, plotH = H - top - bottom;
    const span = Math.max(1, r.now - r.since);
    const X = (ms: number) => { const f = Math.min(1, Math.max(0, (ms - r.since) / span)); return rtl ? R - f * plotW : L + f * plotW; };
    const Y = (v: number) => top + (1 - v / 100) * plotH;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', tabindex: 0, style: 'direction:ltr', 'aria-describedby': 'bat-hist-sum', 'aria-roledescription': t('batHistChart') }) as SVGSVGElement;
    svg.setAttribute('aria-label', `${t('batHistChart')}. ${sum.textContent ?? ''} ${est.textContent ?? ''} ${t('batHistKeyHint')}`);
    // (The level's grid and labels, at the start side.)
    for (const v of [0, 25, 50, 75, 100]) {
      svg.append(sv('line', { class: 'grid', x1: L, x2: R, y1: Y(v), y2: Y(v), opacity: v === 0 ? 1 : 0.5 }));
      svg.append(sv('text', { x: rtl ? R + 6 : L - 6, y: Y(v) + 4, 'text-anchor': rtl ? 'start' : 'end', direction: 'ltr' }, t('batPct', { n: localDigits(v) })));
    }
    const low = ctx.low;
    if (low > 0 && low < 100) svg.append(sv('line', { class: 'lowline', x1: L, x2: R, y1: Y(low), y2: Y(low) }));
    // (The time's ticks: hours of the day, days of the week, weeks of the month; «now» at its end.)
    const ticks: number[] = [];
    const d0 = new Date(r.since);
    if (range === 'day') { d0.setMinutes(0, 0, 0); d0.setHours(Math.ceil(d0.getHours() / 6) * 6); for (let x = d0.getTime(); x < r.now; x += 6 * 3600_000) ticks.push(x); }
    else { d0.setHours(24, 0, 0, 0); const step = range === 'week' ? 1 : 7; for (const x = new Date(d0); x.getTime() < r.now; x.setDate(x.getDate() + step)) ticks.push(x.getTime()); }
    const label = (ms: number) => (range === 'day' ? fmt(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : range === 'week' ? fmt(ms, { weekday: 'short' }) : fmt(ms, { day: 'numeric', month: 'short' }));
    const nowX = X(r.now);
    svg.append(sv('text', { x: nowX, y: H - 8, 'text-anchor': rtl ? 'start' : 'end', class: 'now' }, t('batHistNow')));
    for (const ms of ticks) {
      const x = X(ms); if (Math.abs(x - nowX) < 48) continue;
      svg.append(sv('line', { class: 'grid', x1: x, x2: x, y1: top, y2: top + plotH, opacity: 0.35 }));
      svg.append(sv('text', { x, y: H - 8, 'text-anchor': 'middle' }, label(ms)));
    }
    const pts = r.points;
    const shown = pts.map((p) => share(p.level));
    // (Charging: a band behind, from each charging reading to the next one in its run.)
    const rs = runs(pts, r.gap);
    for (const [a, b] of rs) {
      for (let i = a; i <= b; i++) {
        if (pts[i].charging !== 'yes') continue;
        const x1 = X(pts[i].t), x2 = i < b ? X(pts[i + 1].t) : x1 + (rtl ? -2 : 2);
        svg.append(sv('rect', { class: 'band', x: Math.min(x1, x2), y: top, width: Math.max(2, Math.abs(x2 - x1)), height: plotH }));
      }
    }
    // (The line: per segment, blue while charging; else the accent, red for the part below the low mark.)
    let run = 0;
    const seg = (cls: string, x1: number, y1: number, x2: number, y2: number) => svg.append(sv('line', { class: 'ln ' + cls, x1, y1, x2, y2, 'data-run': run }));
    for (const [a, b] of rs) {
      run++;
      if (a === b) { const v = shown[a]!; svg.append(sv('circle', { class: 'dot ' + (pts[a].charging === 'yes' ? 'chg' : v < low ? 'low' : 'acc'), cx: X(pts[a].t), cy: Y(v), r: 2.6 })); continue; }
      for (let i = a; i < b; i++) {
        const v1 = shown[i]!, v2 = shown[i + 1]!; const x1 = X(pts[i].t), x2 = X(pts[i + 1].t);
        if (pts[i].charging === 'yes' && pts[i + 1].charging === 'yes') { seg('chg', x1, Y(v1), x2, Y(v2)); continue; }
        if ((v1 < low) === (v2 < low)) { seg(v1 < low ? 'low' : 'acc', x1, Y(v1), x2, Y(v2)); continue; }
        // (Crossing the low mark: split where it crosses.)
        const f = (low - v1) / (v2 - v1); const xc = x1 + f * (x2 - x1);
        seg(v1 < low ? 'low' : 'acc', x1, Y(v1), xc, Y(low)); seg(v2 < low ? 'low' : 'acc', xc, Y(low), x2, Y(v2));
      }
    }
    chart.append(svg);
    const idx = pts.map((p, i) => (shown[i] === null ? -1 : i)).filter((i) => i >= 0);
    if (!idx.length) { chart.append(h('div', { class: 'bat-hist-empty' }, t('batHistNone'))); return; }
    // (A reading under the pointer, a tap, or the arrow keys: a guide, a ring and a tip with its time and value.)
    const guide = sv('line', { class: 'guide', y1: top, y2: top + plotH }); const mark = sv('circle', { class: 'mark', r: 4.5 });
    const tip = h('div', { class: 'bat-hist-tip', role: 'status', 'aria-live': 'polite' });
    guide.style.display = mark.style.display = 'none'; tip.hidden = true; svg.append(guide, mark); chart.append(tip);
    let cur = -1;
    const tipTime = (ms: number) => (range === 'day' ? fmt(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : fmt(ms, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
    const show = (k: number) => {
      cur = Math.max(0, Math.min(idx.length - 1, k)); const i = idx[cur]; const p = pts[i]; const v = shown[i]!;
      const x = X(p.t), y = Y(v);
      for (const [k2, v2] of Object.entries({ x1: x, x2: x })) guide.setAttribute(k2, String(v2));
      mark.setAttribute('cx', String(x)); mark.setAttribute('cy', String(y)); mark.setAttribute('stroke', p.charging === 'yes' ? 'var(--bat-blue)' : v < low ? 'var(--md-error)' : 'var(--md-primary)');
      guide.style.display = mark.style.display = ''; tip.hidden = false;
      tip.textContent = t('batHistPoint', { time: tipTime(p.t), level: ctx.levelText(p.level as Lvl) }) + (p.charging === 'yes' ? ' · ' + t('batCharging') : '');
      const sx = (x / W) * svg.getBoundingClientRect().width + 4; tip.style.left = `${Math.max(60, Math.min(chart.clientWidth - 60, sx))}px`;
    };
    const hide = () => { guide.style.display = mark.style.display = 'none'; tip.hidden = true; };
    const nearest = (clientX: number) => {
      const b = svg.getBoundingClientRect(); const x = ((clientX - b.left) / Math.max(1, b.width)) * W;
      let best = 0, bd = Infinity; idx.forEach((i, k) => { const dd = Math.abs(X(pts[i].t) - x); if (dd < bd) { bd = dd; best = k; } }); return best;
    };
    svg.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
    svg.addEventListener('pointerdown', (e) => show(nearest(e.clientX)));
    svg.addEventListener('pointerleave', (e) => { if ((e as PointerEvent).pointerType === 'mouse' && document.activeElement !== svg) hide(); });
    svg.addEventListener('focus', () => show(cur < 0 ? idx.length - 1 : cur));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key; const later = rtl ? 'ArrowLeft' : 'ArrowRight', earlier = rtl ? 'ArrowRight' : 'ArrowLeft';
      if (k === later) show(cur + 1); else if (k === earlier) show(cur - 1); else if (k === 'Home') show(0); else if (k === 'End') show(idx.length - 1); else return;
      e.preventDefault();
    });
  }

  const ask = () => {
    const q = openSheet(t('batHistClear'), t('close'), { stack: true });
    q.body.append(h('p', { class: 'bat-hist-ask', dir: 'auto' }, t('batHistClearAsk', { name: '⁨' + ctx.name + '⁩' })));
    q.actions.append(h('button', { type: 'button', class: 'btn tonal', 'data-act': 'historyCancel', onclick: () => q.close() }, t('batHistCancel')),
      h('button', { type: 'button', class: 'btn danger', 'data-act': 'historyClearYes', onclick: async () => {
        q.close();
        try { await d.batteryHistoryClear({ key }); toast(t('batHistCleared')); ctx.cleared?.(); void load(); } catch (e) { toast(String((e as Error)?.message ?? e), 'error'); }
      } }, t('batHistClearYes')));
  };
  void load();
}
