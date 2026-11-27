// The one rule behind every drag on the phone (a sheet pulled down, the drawer pushed back, a page swiped to the next
// place, a pill flicked away, the drawer pulled open): the direction is read after a few pixels (8, and one axis must
// lead the other); the speed is the finger's over its last ~100 ms, not the whole gesture's; the thing is let go by
// DISTANCE or by SPEED (a short flick is enough); a cancel (the browser took the finger, a second finger landed)
// puts everything back and never commits; what moves follows the finger 1:1 and, when a new touch lands while it is
// still settling, is taken up where it visually is (interruptible, not restarted). The settling itself is a spring-like
// curve (a little overshoot), and instant with reduced motion. Each gesture keeps its own DOM and its own thresholds.

export const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The spring-like settle of Material 3 Expressive: a quick start and a small overshoot. */
export const SPRING = 'cubic-bezier(.2, .9, .3, 1.15)';

/** One finger's path: where it began, where it is, and how fast it moved just now. */
export class Track {
  dx = 0; dy = 0; axis: '' | 'x' | 'y' = '';
  private s: [number, number, number][] = [];
  constructor(readonly x0: number, readonly y0: number, t = performance.now()) { this.s.push([t, x0, y0]); }
  add(x: number, y: number, t = performance.now()): void {
    this.dx = x - this.x0; this.dy = y - this.y0; this.s.push([t, x, y]);
    while (this.s.length > 2 && t - this.s[1][0] > 120) this.s.shift();
  }
  /** After `slop` px of travel, 'x' or 'y' once that axis leads the other by `ratio`; '' while still undecided. */
  read(slop = 8, ratio = 1.2): '' | 'x' | 'y' {
    if (this.axis) return this.axis;
    const ax = Math.abs(this.dx), ay = Math.abs(this.dy); if (Math.max(ax, ay) < slop) return '';
    if (ax > ay * ratio) this.axis = 'x'; else if (ay > ax * ratio) this.axis = 'y';
    return this.axis;
  }
  /** Signed px per ms along `axis` over the last ~100 ms before `now` (the lifting event's own time; 0 when the finger paused, or with too few samples). */
  velocity(axis: 'x' | 'y', now = performance.now()): number {
    const a = this.s[0], b = this.s[this.s.length - 1]; const dt = b[0] - a[0]; if (this.s.length < 2 || dt <= 0) return 0;
    if (now - b[0] > 120) return 0;   // (the finger paused before letting go: no flick)
    return (axis === 'x' ? b[1] - a[1] : b[2] - a[2]) / dt;
  }
}

/** Let go: by distance (`dist` reached `need`) or by speed (a flick of at least `minDist` at `vMin` px/ms toward it). */
export function commits(dist: number, need: number, v: number, vMin = 0.5, minDist = 36): boolean {
  return dist >= need || (v >= vMin && dist >= minDist);
}

const timers = new WeakMap<HTMLElement, number>();
/** Where `el` is now along x or y, as it visually stands (mid-transition included). */
export function offsetNow(el: HTMLElement, axis: 'x' | 'y'): number {
  const m = new DOMMatrix(getComputedStyle(el).transform); return axis === 'x' ? m.m41 : m.m42;
}
/** Takes up an element that is still settling: stops its transition where it visually is and forgets the pending end. */
export function grab(el: HTMLElement, axis: 'x' | 'y'): number {
  const t = timers.get(el); if (t) { clearTimeout(t); timers.delete(el); }
  const at = offsetNow(el, axis); el.style.transition = 'none'; return at;
}
/** Sets `el` settling toward `to` (`''` is home) over `ms` with the spring-like curve; `done` runs once it has landed, unless grabbed. */
export function settle(el: HTMLElement, props: Record<string, string>, ms = 260, done?: () => void): void {
  const t0 = timers.get(el); if (t0) clearTimeout(t0);
  const still = reducedMotion(); el.style.transition = still ? 'none' : Object.keys(props).map((k) => `${k === 'transform' ? 'transform' : k} ${ms}ms ${SPRING}`).join(', ');
  for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v);
  const end = () => { timers.delete(el); el.style.transition = ''; done?.(); };
  if (still) end(); else timers.set(el, window.setTimeout(end, ms + 20));
}
