// Animated backgrounds (a computer only): «Frost drift» — soft fields of cool light drifting and breathing behind the
// glass — and «Expressive flow» — a few large tonal shapes of Material 3 Expressive that glide, turn and change form,
// re-arranging now and then with a slow spring. Both are drawn here, from the theme's own colours, on ONE small 2D
// canvas (a sixteenth or a quarter of the window's size) that the compositor scales up: a handful of gradients or paths a
// frame, 12–24 frames a second, nothing of the page laid out or restyled. Measured against compositor-animated CSS
// layers and a WebGL surface (the report of the change that brought this file): the cheapest of the three that looks
// right, and it has no context to lose. A static grain over it keeps the gradients from banding.
//
// Every motion is a sum of whole harmonics of one loop (minutes long), so the loop closes with no seam, and every
// shape, place and phase comes from a seed: the same seed and time draw the same frame (screenshots, tests).
// It never runs on a phone, is fetched only when chosen (settings.animBg), and stops — no timer, no frame — whenever
// it cannot be seen or should not move (see `Gate`). Text stays readable: the colours are drawn nearer the ground until
// every text role passes WCAG AA over the brightest and darkest colour any frame can show (`clampPalette`).
import { getSettings } from '../settings';
import { contrast, over, type RGBA } from './themes';

export type AnimKind = 'drift' | 'flow';
export type AnimPref = 'off' | 'match' | AnimKind;
export type AnimLevel = 'full' | 'reduced' | 'still';
/** The loop of each design (seconds of motion at Full; Reduced moves at half the speed, so twice as long). */
export const LOOP: Record<AnimKind, number> = { drift: 300, flow: 240 };
/** Frames a second (measured: each new frame makes the compositor blur the glass over it again — the real cost —, so
 *  as few as the motion needs): drift moves a few pixels a second, 15 are smooth; flow 12 while its shapes rest and
 *  glide, 24 during the spring of a re-arrangement. Reduced: half. */
function fpsOf(kind: AnimKind, level: AnimLevel, t: number): number {
  const k = level === 'reduced' ? 0.5 : 1;
  if (kind === 'drift') return 15 * k;
  const seg = LOOP.flow / ARR; const into = (((t % LOOP.flow) + LOOP.flow) % LOOP.flow) % seg;
  return (into > seg - TRANS - 0.5 ? 24 : 12) * k;
}
/** A frame chosen for Still (and for the first frame): a moment of rest in each design. */
const STILL_AT: Record<AnimKind, number> = { drift: 41, flow: 20 };
/** The window unfocused this long: paused. */
export const UNFOCUSED_MS = 4000;
/** After a scroll, a wheel or a drag: this long before moving again. */
const BUSY_MS = 450;
const GRAIN_A = 0.028;

/** «Match the theme»: Frost drifts, Expressive 3 flows, a theme of the reader's its own choice; the others none. */
export function kindFor(pref: AnimPref | undefined, theme: string | undefined, themeAnim: string | undefined): AnimKind | null {
  if (!pref || pref === 'off') return null;
  if (pref === 'drift' || pref === 'flow') return pref;
  if (themeAnim === 'drift' || themeAnim === 'flow') return themeAnim;
  if (theme === 'frost') return 'drift';
  if (theme === 'classic' || !theme) return 'flow';
  return null;
}

/* ---------- numbers ---------- */
function rng(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const TAU = Math.PI * 2;
const mix = (a: RGBA, b: RGBA, k: number): RGBA => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, 1];
const rgba = (c: RGBA, a = 1): string => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${+a.toFixed(4)})`;
/** Hue (degrees) and chroma (0–1) of a colour. */
export function hueChroma(c: RGBA): [number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const d = mx - mn;
  if (d === 0) return [0, 0];
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360;
  return [h, d];
}
/** No yellow, amber or gold: a colour of those hues is drawn all but grey (a gold accent gives a quiet neutral). */
export function noYellow(c: RGBA): RGBA {
  const [h, ch] = hueChroma(c); if (h < 26 || h > 82 || ch < 0.03) return c;
  const l = (Math.max(c[0], c[1], c[2]) + Math.min(c[0], c[1], c[2])) / 2; const k = 0.025 / ch;
  return [l + (c[0] - l) * k, l + (c[1] - l) * k, l + (c[2] - l) * k, 1];
}
/** The colours drawn nearer the ground (all together, a step at a time) until every text role keeps 4.5:1 over the
 *  brightest and the darkest colour a frame can hold — each channel's highest and lowest among the ground and the
 *  colours (what overlapping fields can reach), the grain's swing included. */
export function clampPalette(ground: RGBA, cols: RGBA[], texts: RGBA[], grain = GRAIN_A): { cols: RGBA[]; worst: number; steps: number } {
  let cur = cols.map((c) => [...c] as RGBA); let steps = 0;
  const worstOf = (cs: RGBA[]): number => {
    const all = [ground, ...cs]; const hi: RGBA = [0, 0, 0, 1], lo: RGBA = [255, 255, 255, 1];
    for (const c of all) for (let i = 0; i < 3; i++) { hi[i] = Math.max(hi[i], c[i]); lo[i] = Math.min(lo[i], c[i]); }
    for (let i = 0; i < 3; i++) { hi[i] = hi[i] + grain * (255 - hi[i]); lo[i] = lo[i] * (1 - grain); }
    let w = 99; for (const back of [hi, lo]) for (const tx of texts) w = Math.min(w, contrast(over(tx, back), back));
    return w;
  };
  let w = worstOf(cur);
  // (Only the colours that fail on their own are drawn nearer; when each passes alone but not together, all of them.)
  while (w < 4.5 && steps < 60) { const bad = cur.map((c) => worstOf([c]) < 4.6); const any = bad.some(Boolean); cur = cur.map((c, i) => (!any || bad[i] ? mix(c, ground, 0.06) : c)); steps++; w = worstOf(cur); }
  return { cols: cur, worst: w, steps };
}

/* ---------- reading the theme's colours ---------- */
let probeCtx: CanvasRenderingContext2D | null = null;
/** Any CSS colour (var(), color-mix(), hsl()…) as the page resolves it, read back as RGBA. */
function cssColour(host: Element, value: string, fallback: RGBA): RGBA {
  const probe = document.createElement('span'); probe.style.cssText = `display:none;color:${value}`; host.appendChild(probe);
  const resolved = getComputedStyle(probe).color; probe.remove();
  if (!probeCtx) { const c = document.createElement('canvas'); c.width = c.height = 1; probeCtx = c.getContext('2d', { willReadFrequently: true }); }
  const g = probeCtx; if (!g || !resolved) return fallback;
  g.clearRect(0, 0, 1, 1); g.fillStyle = '#010203'; g.fillStyle = resolved;
  if (g.fillStyle === '#010203' && !/^rgba?\(1, 2, 3/.test(resolved)) return fallback;
  g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data;
  return d[3] === 0 ? fallback : [d[0], d[1], d[2], d[3] / 255];
}
export interface Palette { light: boolean; ground: RGBA; cols: RGBA[]; texts: RGBA[]; worst: number }
/** The design's colours from the theme on <html> now: its ground, its tonal containers (or a theme's own three). */
export function readPalette(kind: AnimKind, host: Element = document.documentElement): Palette {
  const html = document.documentElement; const light = html.dataset.ui === 'light';
  const ground = cssColour(host, 'var(--th-ground, var(--md-surface))', light ? [238, 240, 246, 1] : [18, 19, 20, 1]);
  const texts = ['var(--md-on-surface)', 'var(--md-on-surface-variant)', 'var(--md-on-surface-dim, var(--md-on-surface-variant))'].map((v) => cssColour(host, v, light ? [24, 27, 35, 1] : [228, 228, 230, 1]));
  const own = html.dataset.anim && getComputedStyle(html).getPropertyValue('--th-anim-a').trim();
  const role = (v: string, f: RGBA) => noYellow(cssColour(host, v, f));
  const pc = role(own ? 'var(--th-anim-a)' : 'var(--md-primary-container)', light ? [220, 225, 250, 1] : [58, 62, 69, 1]);
  const tc = role(own ? 'var(--th-anim-b)' : 'var(--md-tertiary-container)', light ? [210, 233, 236, 1] : [43, 53, 64, 1]);
  const sc = role(own ? 'var(--th-anim-c)' : 'var(--md-secondary-container)', light ? [211, 218, 246, 1] : [46, 50, 55, 1]);
  const p = role('var(--md-primary)', light ? [61, 78, 153, 1] : [201, 204, 210, 1]);
  // (How far each colour reaches from the ground: drift's light is thin and cool, flow's shapes are solid tones.)
  // (Drift's light is lifted a little in colour — at the lightness text allows, a cool tint shows where grey would not —
  //  and two of its fields go the other way in dark, deeper than the ground: depth that only adds contrast; in light,
  //  where text is dark, they are a deeper cool tone instead.)
  const lift = (c: RGBA, k: number): RGBA => { const l = (c[0] + c[1] + c[2]) / 3; return [l + (c[0] - l) * k, l + (c[1] - l) * k, l + (c[2] - l) * k, 1].map((v, i) => (i < 3 ? Math.max(0, Math.min(255, v)) : v)) as RGBA; };
  const deep: RGBA = light ? lift(mix(tc, p, 0.3), 2.2) : mix(ground, [0, 0, 0, 1], 0.55);
  const cols = kind === 'drift'
    ? (light ? [lift(mix(pc, p, 0.22), 2.2), lift(mix(tc, p, 0.14), 2.6), lift(mix(sc, p, 0.18), 2), mix(ground, [255, 255, 255, 1], 0.85), lift(mix(ground, p, 0.3), 1.6), deep]
      : [lift(mix(ground, tc, 1), 2.3), lift(mix(ground, pc, 1), 2), lift(mix(ground, sc, 1), 2), lift(mix(ground, p, 0.24), 1.6), lift(mix(ground, tc, 0.85), 2.4), deep])
    : (light ? [mix(ground, pc, 0.8), mix(ground, tc, 0.8), mix(ground, sc, 0.7), mix(ground, p, 0.12)]
      : [mix(ground, pc, 0.72), mix(ground, tc, 0.78), mix(ground, sc, 0.66), mix(ground, p, 0.12)]);
  const pal = clampPalette(ground, cols.map(noYellow), texts);
  return { light, ground, cols: pal.cols, texts, worst: pal.worst };
}

/* ---------- the two designs ---------- */
interface Field { x: number; y: number; ax: number[]; ay: number[]; kx: number[]; px: number[]; py: number[]; r: number; sx: number; rot: number; kr: number; pr: number; a: number; col: number; spin: number }
/** A whole harmonic of the loop: seamless at u = 0 and 1. */
const harm = (u: number, k: number, ph: number) => Math.sin(TAU * k * u + ph);
const cache = new Map<string, Field[] | Shape[]>();
const cached = <T extends Field[] | Shape[]>(key: string, make: () => T): T => { let v = cache.get(key) as T | undefined; if (!v) { if (cache.size > 8) cache.clear(); v = make(); cache.set(key, v); } return v; };
function driftFields(seed: number): Field[] { return cached(`d${seed}`, () => makeDrift(seed)); }
function makeDrift(seed: number): Field[] {
  const r = rng(seed * 7919 + 1); const out: Field[] = [];
  // (Five broad fields and two long, thin bands of light; their places spread so no corner is empty for long.)
  const spots = [[0.12, 0.08], [0.88, 0.32], [0.3, 0.92], [0.7, 0.72], [0.5, 0.3]];
  for (let i = 0; i < 7; i++) {
    const band = i >= 5; const s = spots[i % 5];
    out.push({ x: band ? 0.2 + r() * 0.6 : s[0] + (r() - 0.5) * 0.12, y: band ? 0.15 + r() * 0.7 : s[1] + (r() - 0.5) * 0.12,
      ax: [0.07 + r() * 0.08, 0.03 + r() * 0.04], ay: [0.06 + r() * 0.07, 0.025 + r() * 0.035], kx: [1 + (i % 2), 2 + (i % 3)], px: [r() * TAU, r() * TAU], py: [r() * TAU, r() * TAU],
      r: band ? 0.28 + r() * 0.1 : 0.34 + r() * 0.16, sx: band ? 3.2 + r() * 0.8 : 1.15 + r() * 0.5, rot: band ? -0.5 + r() * 0.25 : r() * Math.PI, kr: 1 + (i % 3), pr: r() * TAU,
      a: band ? 0.55 : 0.88 + r() * 0.1, col: band ? 3 : i === 2 || i === 4 ? 5 : i % 5 === 3 ? 4 : i % 3, spin: band ? 0 : (i % 2 ? 1 : -1) });
  }
  return out;
}
type Form = { a: number; b: number; n: number; lobes: number; depth: number };
const FORMS: Form[] = [
  { a: 1, b: 1, n: 4, lobes: 0, depth: 0 }, // squircle
  { a: 1, b: 1, n: 2, lobes: 7, depth: 0.055 }, // cookie
  { a: 1.45, b: 0.72, n: 2.8, lobes: 0, depth: 0 }, // pill
  { a: 1, b: 1, n: 2, lobes: 3, depth: 0.075 }, // soft clover
  { a: 1.12, b: 0.9, n: 3.2, lobes: 4, depth: 0.03 }, // rounded square, breathing
];
const formR = (f: Form, th: number) => { const c = Math.abs(Math.cos(th)) / f.a, s = Math.abs(Math.sin(th)) / f.b; return Math.pow(Math.pow(c, f.n) + Math.pow(s, f.n), -1 / f.n) * (1 + f.depth * Math.cos(f.lobes * th)); };
interface Shape { col: number; size: number[]; pos: [number, number][]; form: number[]; rot0: number; spin: number; wob: number[]; wph: number[] }
const ARR = 5;
/** Seconds of each re-arrangement's spring. */
const TRANS = 9;
function flowShapes(seed: number): Shape[] { return cached(`f${seed}`, () => makeFlow(seed)); }
function makeFlow(seed: number): Shape[] {
  const r = rng(seed * 104729 + 3); const out: Shape[] = [];
  // (Places near the edges and corners: the middle, where the list is, kept quieter.)
  const edge = () => { const t = r(); return t < 0.5 ? r() * 0.22 - 0.06 : 0.84 + r() * 0.22; };
  for (let i = 0; i < 4; i++) {
    const pos: [number, number][] = []; const size: number[] = []; const form: number[] = [];
    for (let k = 0; k < ARR; k++) { const side = (i + k) % 2; pos.push(side ? [edge(), 0.1 + r() * 0.8] : [0.1 + r() * 0.8, edge()]); size.push((i === 3 ? 0.11 : 0.16) + r() * 0.08); form.push(Math.floor(r() * FORMS.length)); }
    out.push({ col: i, size, pos, form, rot0: r() * TAU, spin: i % 2 ? 1 : -1, wob: [0.025 + r() * 0.02, 0.02 + r() * 0.015], wph: [r() * TAU, r() * TAU] });
  }
  return out;
}
/** A slow spring (damping 0.72): leaves at rest, overshoots a little, settles exactly at 1. */
function spring(u: number): number {
  if (u <= 0) return 0; if (u >= 1) return 1;
  const z = 0.72, w = 10.5, wd = w * Math.sqrt(1 - z * z), t = u;
  const x = 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
  const end = 1 - Math.exp(-z * w) * (Math.cos(wd) + (z * w / wd) * Math.sin(wd));
  return x + (1 - end) * t * t * t;
}

/** Draws one frame of a design at loop time `t` (seconds) onto a canvas `w`×`h`. Exported for the tests. */
export function drawFrame(g: CanvasRenderingContext2D, w: number, h: number, kind: AnimKind, pal: Palette, seed: number, t: number, amp = 1): void {
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.fillStyle = rgba(pal.ground); g.fillRect(0, 0, w, h);
  const L = LOOP[kind]; const u = (((t % L) + L) % L) / L; const big = Math.max(w, h);
  if (kind === 'drift') {
    for (const f of driftFields(seed)) {
      const x = (f.x + amp * (f.ax[0] * harm(u, f.kx[0], f.px[0]) + f.ax[1] * harm(u, f.kx[1], f.px[1]))) * w;
      const y = (f.y + amp * (f.ay[0] * harm(u, f.kx[0], f.py[0]) + f.ay[1] * harm(u, f.kx[1] + 1, f.py[1]))) * h;
      const breathe = 1 + 0.1 * amp * harm(u, f.kr, f.pr); const R = f.r * big * breathe;
      const a = f.a * (0.82 + 0.18 * harm(u, f.kr + 1, f.pr + 1)); const c = pal.cols[f.col % pal.cols.length];
      g.setTransform(1, 0, 0, 1, x, y); g.rotate(f.rot + f.spin * 0.35 * amp * harm(u, 1, f.pr)); g.scale(f.sx, 1);
      const grd = g.createRadialGradient(0, 0, 0, 0, 0, R);
      for (let i = 0; i <= 8; i++) { const s = i / 8; const q = s * s; const k = (1 - q * q) * (1 - q); grd.addColorStop(s, rgba(c, a * k)); }
      g.fillStyle = grd; g.beginPath(); g.arc(0, 0, R, 0, TAU); g.fill();
    }
    g.setTransform(1, 0, 0, 1, 0, 0); return;
  }
  const seg = L / ARR; const ti = ((t % L) + L) % L; const k = Math.floor(ti / seg); const into = ti - k * seg;
  // (Each arrangement held for most of its time, then a slow spring to the next: TRANS seconds.)
  const p = into < seg - TRANS ? 0 : (into - (seg - TRANS)) / TRANS; const sp = spring(p); const sm = p * p * (3 - 2 * p);
  for (const s of flowShapes(seed)) {
    const a = k % ARR, b = (k + 1) % ARR;
    const glide = 0.03 * amp;
    const x = (s.pos[a][0] + (s.pos[b][0] - s.pos[a][0]) * sp + glide * harm(u, 2, s.wph[0])) * w;
    const y = (s.pos[a][1] + (s.pos[b][1] - s.pos[a][1]) * sp + glide * harm(u, 3, s.wph[1])) * h;
    const R = (s.size[a] + (s.size[b] - s.size[a]) * sp) * big;
    const fa = FORMS[s.form[a]], fb = FORMS[s.form[b]]; const rot = s.rot0 + s.spin * TAU * u;
    g.fillStyle = rgba(pal.cols[s.col % pal.cols.length]); g.beginPath();
    const N = 72;
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * TAU; const local = th - rot;
      const base = formR(fa, local) * (1 - sm) + formR(fb, local) * sm;
      const wob = 1 + amp * (s.wob[0] * Math.sin(2 * th + TAU * 2 * u + s.wph[0]) + s.wob[1] * Math.sin(3 * th - TAU * 3 * u + s.wph[1]));
      const rr = R * base * wob; const px = x + Math.cos(th) * rr, py = y + Math.sin(th) * rr;
      if (i) g.lineTo(px, py); else g.moveTo(px, py);
    }
    g.closePath(); g.fill();
  }
}

/* ---------- when it may move: one gate for every instance ---------- */
export type PauseWhy = 'hidden' | 'focus' | 'video' | 'fullscreen';
export type StillWhy = 'motion' | 'battery' | 'slow';
interface GateState { paused: PauseWhy | null; still: StillWhy | null; busyUntil: number }
const insts = new Set<Inst>();
const watchers = new Set<() => void>();
const gate = {
  st: { paused: null, still: null, busyUntil: 0 } as GateState,
  unfocused: false, video: false, lowBattery: false, focusTimer: 0, off: [] as (() => void)[],
  on(): void {
    if (this.off.length) return;
    const add = (tg: EventTarget, ev: string, fn: EventListener, o: AddEventListenerOptions | boolean = false) => { tg.addEventListener(ev, fn, o); this.off.push(() => tg.removeEventListener(ev, fn, o)); };
    const upd = () => this.update();
    add(document, 'visibilitychange', upd);
    add(window, 'blur', () => { clearTimeout(this.focusTimer); this.focusTimer = window.setTimeout(() => { this.focusTimer = 0; this.unfocused = true; this.update(); }, UNFOCUSED_MS); });
    add(window, 'focus', () => { clearTimeout(this.focusTimer); this.focusTimer = 0; if (this.unfocused) { this.unfocused = false; this.update(); } });
    add(document, 'fullscreenchange', upd);
    const vid = () => { const v = Array.from(document.querySelectorAll('video')).some((x) => !x.paused && !x.ended && x.readyState > 1); if (v !== this.video) { this.video = v; this.update(); } };
    for (const ev of ['playing', 'play', 'pause', 'ended', 'emptied']) add(document, ev, () => queueMicrotask(vid), true);
    const busy = () => { this.st.busyUntil = performance.now() + BUSY_MS; };
    add(document, 'scroll', busy, { capture: true, passive: true });
    add(window, 'wheel', busy, { passive: true });
    add(window, 'pointermove', ((e: PointerEvent) => { if (e.buttons) busy(); for (const i of insts) i.pointer(e); }) as EventListener, { passive: true });
    add(document, 'dragover', busy, { capture: true, passive: true });
    add(window, 'resize', () => { for (const i of insts) i.resize(); }, { passive: true });
    add(window, 'hashchange', () => prune());
    add(window, 'kt:animbg', ((e: CustomEvent<{ seek?: number | null }>) => { for (const i of insts) i.seek(e.detail?.seek ?? null); }) as EventListener);
    const mq = matchMedia('(prefers-reduced-motion: reduce)'); add(mq, 'change', upd);
    const nb = navigator as Navigator & { getBattery?(): Promise<EventTarget & { level: number; charging: boolean }> };
    void nb.getBattery?.().then((b) => {
      if (!this.off.length) return;
      const read = () => { const low = !b.charging && b.level <= 0.2; if (low !== this.lowBattery) { this.lowBattery = low; this.update(); } };
      read(); add(b, 'levelchange', read); add(b, 'chargingchange', read);
    }).catch(() => undefined);
    this.unfocused = false; this.video = false;
    this.update();
  },
  stop(): void { for (const f of this.off.splice(0)) f(); clearTimeout(this.focusTimer); this.focusTimer = 0; },
  update(): void {
    const paused: PauseWhy | null = document.visibilityState === 'hidden' ? 'hidden' : document.fullscreenElement ? 'fullscreen' : this.video ? 'video' : this.unfocused ? 'focus' : null;
    const still: StillWhy | null = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'motion' : this.lowBattery ? 'battery' : null;
    this.st = { ...this.st, paused, still };
    for (const i of insts) i.sync();
    for (const w of watchers) w();
  },
};
/** What the background is doing now, and why (the Appearance page says it in one line). */
export function animState(): { kind: AnimKind | null; level: AnimLevel; paused: PauseWhy | null; still: StillWhy | null } {
  const g = globalInst; return { kind: g?.kind ?? null, level: g ? g.level : levelPref(), paused: gate.st.paused, still: g?.level === 'still' ? null : gate.st.still ?? (g?.tooSlow ? 'slow' : null) };
}
/** Told when the state changes; returns its removal. */
export function watchAnim(fn: () => void): () => void { watchers.add(fn); return () => watchers.delete(fn); }

/* ---------- an instance: a canvas, its grain, its clock ---------- */
let grainUrl = '';
function grain(seed: number): string {
  if (grainUrl) return grainUrl;
  const c = document.createElement('canvas'); c.width = c.height = 96; const g = c.getContext('2d'); if (!g) return '';
  const im = g.createImageData(96, 96); const r = rng(seed + 11);
  for (let i = 0; i < im.data.length; i += 4) { const v = r() < 0.5 ? 0 : 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = Math.round(255 * GRAIN_A * (0.35 + r() * 0.65)); }
  g.putImageData(im, 0, 0); grainUrl = c.toDataURL('image/png'); return grainUrl;
}
const CSS_ID = 'kt-animbg-css';
const CSS = `html.abg body{background:transparent}html.abg{background:var(--th-ground,var(--md-surface))}
#kt-animbg{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;contain:strict}
.abg-canvas{position:absolute;inset:-16px;width:calc(100% + 32px);height:calc(100% + 32px);display:block;will-change:transform}
.abg-grain{position:absolute;inset:0;background-size:96px 96px;pointer-events:none}
html.pc.abg:not([data-glass]) .downloads-view .body>.chips{background:transparent}
html.pc.abg:not([data-glass]) .downloads-view>.topbar{background:transparent;-webkit-backdrop-filter:none;backdrop-filter:none}
.settings-view .card>.row.abg-row:not([hidden]){flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:6px}.settings-view .card>.row.abg-row>*{margin-inline:0;align-self:flex-start;text-align:start}.settings-view .card>.row.abg-row>.abg-now{text-align:start;align-self:stretch;margin-inline:0}
.abg-preview{position:relative;overflow:hidden;isolation:isolate;width:100%;max-width:420px;aspect-ratio:16/9;border-radius:var(--sh-lg,20px);background:var(--th-ground,var(--md-surface));box-shadow:inset 0 0 0 1px var(--md-outline-variant)}
.abg-preview .abg-canvas{z-index:-1}.abg-preview .abg-grain{z-index:-1}
.abg-sample{position:absolute;inset-inline-start:14px;bottom:12px;display:flex;flex-direction:column;gap:2px;font-size:14px;color:var(--md-on-surface)}.abg-sample small{color:var(--md-on-surface-dim);font-size:12.5px}`;
const levelPref = (): AnimLevel => { const l = getSettings().animBgLevel; return l === 'reduced' || l === 'still' ? l : 'full'; };
const seedPref = (): number => { const s = getSettings().animBgSeed; return typeof s === 'number' && Number.isFinite(s) ? s : 1; };

class Inst {
  canvas: HTMLCanvasElement; g: CanvasRenderingContext2D | null; grainEl: HTMLElement; pal: Palette | null = null;
  vt: number; last = 0; timer = 0; raf = 0; drawn = false; held: number | null = null; dead = false;
  px = 0; py = 0; tx = 0; ty = 0; w = 0; h = 0;
  /** Self-throttle: how late the asked frames come (a running average, ms) and the slow-down it led to (1, 2 or 4). */
  raf2 = 0; late = 0; slow = 1; tooSlow = false; stepAt = 0;
  constructor(public host: HTMLElement, public kind: AnimKind, public level: AnimLevel, public seed: number, public global: boolean) {
    this.canvas = document.createElement('canvas'); this.canvas.className = 'abg-canvas'; this.canvas.setAttribute('aria-hidden', 'true');
    this.g = this.canvas.getContext('2d', { alpha: false });
    this.canvas.addEventListener('contextrestored', () => { this.drawn = false; this.paint(); });
    this.grainEl = document.createElement('div'); this.grainEl.className = 'abg-grain'; this.grainEl.style.backgroundImage = `url(${grain(7)})`;
    host.append(this.canvas, this.grainEl);
    this.vt = STILL_AT[kind];
    this.resize(); this.refresh();
  }
  /** The canvas: a sixteenth (drift) or a quarter (flow) of the window, at most so many pixels. */
  resize(): void {
    const W = (this.global ? innerWidth : this.host.clientWidth || 320) + 32, H = (this.global ? innerHeight : this.host.clientHeight || 180) + 32;
    const f = this.kind === 'drift' ? 1 / 16 : 1 / 4; const cap = this.kind === 'drift' ? 24_000 : 260_000;
    let w = Math.max(16, Math.ceil(W * f)), h = Math.max(16, Math.ceil(H * f)); const k = Math.min(1, Math.sqrt(cap / (w * h))); w = Math.ceil(w * k); h = Math.ceil(h * k);
    if (w === this.w && h === this.h) return; this.w = this.canvas.width = w; this.h = this.canvas.height = h; this.drawn = false; this.paint();
  }
  /** The theme's colours read again (a theme, a mode or an accent changed). */
  refresh(): void { this.pal = readPalette(this.kind, this.host); this.host.dataset.worst = this.pal.worst.toFixed(2); this.drawn = false; this.paint(); }
  pointer(e: PointerEvent): void {
    if (!this.global || this.kind !== 'drift' || this.level !== 'full') return;
    this.tx = ((e.clientX / innerWidth) - 0.5) * -10; this.ty = ((e.clientY / innerHeight) - 0.5) * -8;
  }
  seek(t: number | null): void { this.held = t; this.drawn = false; this.cancel(); if (t !== null) { this.draw(t); this.host.dataset.state = 'held'; } else this.sync(); }
  draw(t: number): void {
    if (!this.g || !this.pal) return;
    drawFrame(this.g, this.w, this.h, this.kind, this.pal, this.seed, t, this.level === 'reduced' ? 0.6 : 1); this.drawn = true;
    if (this.tx || this.ty || this.px || this.py) { this.px += (this.tx - this.px) * 0.08; this.py += (this.ty - this.py) * 0.08; this.canvas.style.transform = `translate3d(${this.px.toFixed(2)}px,${this.py.toFixed(2)}px,0)`; }
  }
  paint(): void { if (this.held !== null) { this.draw(this.held); return; } if (!this.drawn) this.draw(this.vt); this.sync(); }
  cancel(): void { if (this.timer) clearTimeout(this.timer); if (this.raf) cancelAnimationFrame(this.raf); if (this.raf2) cancelAnimationFrame(this.raf2); this.timer = this.raf = this.raf2 = 0; }
  /** Moving, paused or still, as the gate and the level say. */
  sync(): void {
    if (this.dead) return;
    if (!this.host.isConnected) { this.destroy(); return; }
    const st = gate.st; const still = this.level === 'still' || !!st.still || this.tooSlow;
    if (this.held !== null) return;
    if (still) { this.cancel(); if (!this.drawn || this.vt !== STILL_AT[this.kind]) { this.vt = STILL_AT[this.kind]; this.draw(this.vt); } this.host.dataset.state = 'still'; return; }
    if (st.paused) { this.cancel(); this.host.dataset.state = 'paused'; return; }
    this.host.dataset.state = 'running';
    if (!this.timer && !this.raf) { this.last = 0; this.late = 0; this.stepAt = performance.now() + 1000; this.schedule(0); }
  }
  schedule(wait: number): void { this.timer = window.setTimeout(() => { this.timer = 0; this.raf = requestAnimationFrame(this.tick); }, Math.max(0, wait)); }
  tick = (now: number): void => {
    this.raf = 0; if (this.dead) return;
    const st = gate.st; if (st.paused || st.still || this.tooSlow || this.level === 'still' || this.held !== null) { this.sync(); return; }
    const p = performance.now();
    if (st.busyUntil > p) { this.last = 0; this.host.dataset.state = 'busy'; this.schedule(st.busyUntil - p + 16); return; }
    this.host.dataset.state = 'running';
    if (this.last) this.vt += Math.min(0.25, (now - this.last) / 1000) * (this.level === 'reduced' ? 0.5 : 1);
    this.last = now; this.vt %= LOOP[this.kind] * 2;
    // (The frame after a drawing is the one that pays for it — the compositor blurring the glass over the new
    //  background. When those frames come late, a weak GPU is behind: fewer frames then, a half and a quarter; still
    //  late at a quarter, the still frame. Back up again once they come on time.)
    if (this.tooSlow) return;
    if (p - this.stepAt > 2000) {
      if (this.late > 14 && this.slow < 4) { this.slow *= 2; this.late = 0; this.stepAt = p; }
      else if (this.late > 14) { this.tooSlow = true; this.sync(); for (const w of watchers) w(); return; }
      else if (this.late < 2 && this.slow > 1) { this.slow /= 2; this.stepAt = p + 8000; }
    }
    this.host.dataset.slow = String(this.slow);
    this.draw(this.vt);
    this.raf2 = requestAnimationFrame((t2) => { this.raf2 = 0; this.late = this.late * 0.8 + Math.max(0, t2 - now - 20) * 0.2; });
    this.schedule(1000 / fpsOf(this.kind, this.level, this.vt) * this.slow - Math.max(0, performance.now() - p) - 6);
  };
  destroy(): void {
    if (this.dead) return; this.dead = true; this.cancel(); this.canvas.width = this.canvas.height = 0; this.canvas.remove(); this.grainEl.remove(); insts.delete(this);
    if (globalInst === this) globalInst = null;
    if (!insts.size) { gate.stop(); document.getElementById(CSS_ID)?.remove(); }
  }
}
function prune(): void { for (const i of [...insts]) if (!i.host.isConnected) i.destroy(); }
function mountInst(host: HTMLElement, kind: AnimKind, level: AnimLevel, global: boolean): Inst {
  if (!document.getElementById(CSS_ID)) { const s = document.createElement('style'); s.id = CSS_ID; s.textContent = CSS; document.head.append(s); }
  const i = new Inst(host, kind, level, seedPref(), global); insts.add(i); host.dataset.kind = kind; host.dataset.level = level;
  if (insts.size === 1) gate.on(); else i.sync();
  return i;
}

/* ---------- the page's background, kept as the settings and the theme say ---------- */
let globalInst: Inst | null = null; let globalHost: HTMLElement | null = null; let htmlObs: MutationObserver | null = null; let pending = false;
const isPc = () => document.documentElement.classList.contains('pc');
/** The background as it should be now: mounted, changed or taken down (with everything it listened to). */
export function syncAnimBg(): void {
  prune(); for (const w of watchers) w();
  const s = getSettings(); const html = document.documentElement; const pc = isPc();
  const want = pc ? kindFor(s.animBg, html.dataset.theme, html.dataset.anim) : null; const level = levelPref();
  // (While chosen on a computer, the theme on <html> is watched: Match the theme follows it, the colours too.)
  if (pc && s.animBg && s.animBg !== 'off') {
    if (!htmlObs) { htmlObs = new MutationObserver(() => { if (pending) return; pending = true; queueMicrotask(() => { pending = false; syncAnimBg(); }); }); htmlObs.observe(html, { attributes: true, attributeFilter: ['data-theme', 'data-ui', 'data-accent', 'data-anim', 'data-dark', 'style', 'class'] }); }
  } else if (htmlObs) { htmlObs.disconnect(); htmlObs = null; }
  if (globalInst && (!want || globalInst.kind !== want || globalInst.level !== level)) { globalInst.destroy(); globalInst = null; }
  // (A class set or taken only when it changes: writing it anyway is a mutation the watcher above would see again.)
  if (!want) { globalHost?.remove(); globalHost = null; if (html.classList.contains('abg')) html.classList.remove('abg'); return; }
  if (!globalInst) {
    if (!globalHost) { globalHost = document.createElement('div'); globalHost.id = 'kt-animbg'; globalHost.setAttribute('aria-hidden', 'true'); }
    document.body.prepend(globalHost);
    globalInst = mountInst(globalHost, want, level, true); if (!html.classList.contains('abg')) html.classList.add('abg');
  } else globalInst.refresh();
  for (const i of insts) if (i !== globalInst && i.host.isConnected) i.refresh();
}
/** A small live preview inside `host` (the Appearance page); taken down when `host` leaves the page. */
export function previewAnimBg(host: HTMLElement, kind: AnimKind): () => void {
  const i = mountInst(host, kind, levelPref(), false); return () => i.destroy();
}
