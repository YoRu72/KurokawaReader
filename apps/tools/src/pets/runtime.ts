// The pet's life, without any drawing: a state machine (what it does and for how long, chosen by weight among what
// its pack offers and what the conditions allow) and simple physics (gravity, landing on surfaces, bouncing, walking
// to an edge and turning, being dragged and thrown). Deterministic: a seed and the time steps given decide everything,
// so the tests drive it with a fake clock and fake rectangles. Coordinates: screen (or window) pixels, y downward; the
// pet's position is its feet.
import { compile, evaluate, truthy, type Expr, type Val } from './expr';
import { COND_NAMES, own, type PetAnim, type PetChoice, type PetPack, type PetState } from './model';

/** A walkable top edge: from x to x+w at height y (a panel, a window's top, …); `id` keeps it known between frames. */
export interface Surface { id: string; x: number; y: number; w: number }
export interface World {
  width: number; height: number;
  /** The floor (the window's or the screen's bottom edge), y. */
  floor: number;
  surfaces: Surface[];
  pointer?: { x: number; y: number } | null;
  /** The active window (desktop), for conditions. */
  win?: { x: number; y: number; w: number; h: number } | null;
}
export type Activity = 'calm' | 'normal' | 'lively';
export interface SimOpts { scale: number; activity: Activity; chase: boolean; seed: number; speech?: boolean }
export interface PetView { x: number; y: number; w: number; h: number; frame: number; flip: boolean; state: PetState; say: string | null }

export const GRAVITY = 2000;
export const MAX_SPEED = 2600;
const BOUNCE_MIN = 520;
const STEP_OFF = 0.3;
const CHASE_EVERY = 6;
/** At the screen's edge, how often a pack that climbs starts up the wall. */
const CLIMB = 0.5;

export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ACT: Record<Activity, { walk: number; idle: number; speed: number }> = { calm: { walk: 0.5, idle: 1.5, speed: 0.75 }, normal: { walk: 1, idle: 1, speed: 1 }, lively: { walk: 1.8, idle: 0.6, speed: 1.3 } };

export class PetSim {
  x = 0; y = 0; vx = 0; vy = 0; dir: 1 | -1 = 1;
  state: PetState = 'fall';
  /** Where it stands: a surface's id, 'floor', or null (in the air, or dragged). */
  on: string | null = null;
  private onX = 0;
  private steps: { anim: string; left: number; alts?: { when: string; anim: string }[] }[] = [];
  private cur: PetChoice | null = null;
  private anim = ''; private animT = 0;
  private chaseUntil = 0; private lastChase = -99; private fleeLeft = 0;
  private drag: { ox: number; oy: number; samples: [number, number, number][] } | null = null;
  private bounces = 0; private t = 0; private sayLeft = 0; private say: string | null = null; private nextSay = 40;
  private readonly r: () => number;
  private readonly conds = new Map<string, Expr | null>();
  readonly k: number;
  private world: World;

  constructor(readonly pack: PetPack, readonly sizes: [number, number][], public opts: SimOpts, world: World, start?: { x: number; y: number }) {
    this.r = rng(opts.seed); this.world = world; this.k = opts.scale;
    this.x = start?.x ?? world.width * (0.2 + 0.6 * this.r()); this.y = start?.y ?? 0;
    this.enter('fall');
  }
  /* ---------- what it does ---------- */
  private choices(s: PetState): PetChoice[] { const l = own(this.pack.states as Record<string, PetChoice[]>, s); return Array.isArray(l) ? l : []; }
  private has(s: PetState): boolean { return this.choices(s).length > 0; }
  private env(): Record<string, Val> {
    const w = this.world; const p = w.pointer; const win = w.win;
    const hw = this.halfW();
    return { onFloor: this.on === 'floor', onWindowTop: !!this.on && this.on !== 'floor' && this.on !== 'wall', onWall: this.on === 'wall', onAreaLeft: this.on === 'floor' && this.x <= hw + 2, onAreaRight: this.on === 'floor' && this.x >= w.width - hw - 2, onCeiling: false, onWindowBottom: false, onWindowSide: false, windowVisible: !!win, x: this.x, y: this.y, lookRight: this.dir > 0, count: 1,
      'area.left': 0, 'area.top': 0, 'area.right': w.width, 'area.bottom': w.floor, 'area.width': w.width, 'area.height': w.floor,
      'screen.left': 0, 'screen.top': 0, 'screen.right': w.width, 'screen.bottom': w.height, 'screen.width': w.width, 'screen.height': w.height,
      'win.left': win?.x ?? 0, 'win.top': win?.y ?? 0, 'win.right': win ? win.x + win.w : 0, 'win.bottom': win ? win.y + win.h : 0, 'win.width': win?.w ?? 0, 'win.height': win?.h ?? 0,
      'cursor.x': p?.x ?? 0, 'cursor.y': p?.y ?? 0 };
  }
  private allowed(c: PetChoice, env: Record<string, Val>): boolean {
    if (!c.when) return true;
    let e = this.conds.get(c.when); if (e === undefined) { try { e = compile(c.when, COND_NAMES); } catch { e = null; } this.conds.set(c.when, e); }
    return !!e && truthy(evaluate(e, env, this.r));
  }
  private pick(s: PetState): PetChoice | null {
    const env = this.env(); const a = ACT[this.opts.activity] ?? ACT.normal;
    const list = this.choices(s).filter((c) => c.weight > 0 && this.allowed(c, env)); if (!list.length) return null;
    let sum = 0; for (const c of list) sum += c.weight; let v = this.r() * sum;
    for (const c of list) { v -= c.weight; if (v <= 0) return c; } void a; return list[list.length - 1];
  }
  private enter(s: PetState, c?: PetChoice | null): void {
    this.state = s; const mine = c ?? this.pick(s) ?? (s === 'thrown' ? this.pick('fall') : null);
    // (Nothing of its own for this state: on a surface, what it may do there; in the air or held, only the pictures of
    // its first idle — borrowed, so nothing «follows» it.)
    const air = s === 'fall' || s === 'thrown' || s === 'dragged';
    const ch = mine ?? (air ? (this.choices('idle')[0] ?? this.choices('walk')[0] ?? null) : (s !== 'idle' ? this.pick('idle') : null) ?? this.pick('walk'));
    const a = ACT[this.opts.activity] ?? ACT.normal; const mult = s === 'walk' ? 1 : s === 'idle' || s === 'sit' || s === 'sleep' ? a.idle : 1;
    this.cur = mine ?? (air ? null : ch ?? null);
    this.steps = (ch?.steps ?? []).map((st) => ({ anim: st.anim, left: (st.min + (st.max - st.min) * this.r()) * mult, alts: st.alts }));
    this.stepAnim();
  }
  /** The current step's animation: the first of its conditional ones whose condition holds, else its own. */
  private stepAnim(): void {
    const st = this.steps[0]; if (!st) return;
    let a = st.anim;
    if (st.alts?.length) { const env = this.env(); for (const x of st.alts) if (this.allowed({ steps: [], weight: 1, when: x.when }, env)) { a = x.anim; break; } }
    this.setAnim(own(this.pack.animations, a) ? a : st.anim);
  }
  /** After a choice with a «what follows» list: one of those named (by weight, where allowed); false when none. */
  private follow(): boolean {
    const c = this.cur; if (!c?.next?.length) return false;
    if (c.nextAdd && this.r() < 0.5) return false;
    const env = this.env(); const cands: { s: PetState; c: PetChoice; w: number }[] = [];
    for (const n of c.next) for (const s of ['idle', 'walk', 'sit', 'sleep', 'climb'] as PetState[]) for (const ch of this.choices(s)) if (ch.name === n.name && this.allowed(ch, env)) cands.push({ s, c: ch, w: n.weight * Math.max(ch.weight, 1e-6) });
    if (!cands.length) return false;
    let v = this.r() * cands.reduce((x, y) => x + y.w, 0); for (const x of cands) { v -= x.w; if (v <= 0) { this.enter(x.s, x.c); return true; } }
    const last = cands[cands.length - 1]; this.enter(last.s, last.c); return true;
  }
  private setAnim(n: string): void { if (n && n !== this.anim) { this.anim = n; this.animT = 0; } }
  private animOf(): PetAnim | undefined { return own(this.pack.animations, this.anim); }
  /** On a surface, the next thing to do: weighted among idle, walk, sit, sleep (by activity), maybe towards the pointer. */
  private next(): void {
    // (On a wall: climb on where the pack says so, else let go.)
    if (this.on === 'wall') { const c = this.r() < 0.7 ? this.pick('climb') : null; if (c) this.enter('climb', c); else this.letGo(); return; }
    const a = ACT[this.opts.activity] ?? ACT.normal; const env = this.env();
    const w = (s: PetState) => this.choices(s).filter((c) => this.allowed(c, env)).reduce((x, c) => x + c.weight, 0) * (s === 'walk' ? a.walk : 1);
    const p = this.world.pointer;
    if (this.opts.chase && p && this.has('walk') && this.t - this.lastChase > CHASE_EVERY && Math.abs(p.x - this.x) > 80 && this.r() < 0.5) {
      this.lastChase = this.t; this.chaseUntil = this.t + 4; this.dir = p.x > this.x ? 1 : -1; this.enter('walk'); return;
    }
    const opts: PetState[] = ['idle', 'walk', 'sit', 'sleep']; const ws = opts.map(w); const sum = ws.reduce((x, y) => x + y, 0);
    if (!sum) { this.enter('idle'); return; }
    let v = this.r() * sum; let s: PetState = 'idle'; for (let i = 0; i < opts.length; i++) { v -= ws[i]; if (v <= 0) { s = opts[i]; break; } }
    if (s === 'walk' && this.r() < 0.5) this.dir = this.dir > 0 ? -1 : 1;
    this.enter(s);
  }
  /* ---------- the user ---------- */
  grab(px: number, py: number, tMs: number): void { this.drag = { ox: this.x - px, oy: this.y - py, samples: [[tMs, px, py]] }; this.on = null; this.vx = this.vy = 0; this.enter('dragged'); }
  dragTo(px: number, py: number, tMs: number): void {
    if (!this.drag) return; const d = this.drag; this.x = px + d.ox; this.y = py + d.oy; d.samples.push([tMs, px, py]); while (d.samples.length > 2 && tMs - d.samples[0][0] > 100) d.samples.shift();
    const dx = d.samples.length > 1 ? px - d.samples[d.samples.length - 2][1] : 0; if (Math.abs(dx) > 1) this.dir = dx > 0 ? 1 : -1;
  }
  release(tMs: number): void {
    if (!this.drag) return; const s = this.drag.samples; this.drag = null;
    const a = s[0], b = s[s.length - 1]; const dt = Math.max(0.016, (b[0] - a[0]) / 1000);
    this.vx = clamp((b[1] - a[1]) / dt, -MAX_SPEED, MAX_SPEED); this.vy = clamp((b[2] - a[2]) / dt, -MAX_SPEED, MAX_SPEED);
    if (tMs - b[0] > 120) { this.vx = 0; this.vy = 0; }
    this.bounces = 0; this.enter(Math.hypot(this.vx, this.vy) > 250 ? 'thrown' : 'fall');
  }
  get dragging(): boolean { return !!this.drag; }
  /** A click on it: its click animation once, or a small hop. */
  click(): void {
    if (this.drag) return;
    if (this.on && this.has('click')) { this.enter('click'); return; }
    if (this.on) { this.on = null; this.vy = -380 * Math.sqrt(this.k); this.vx = 0; this.enter('fall'); }
  }
  /** Out of the way of the pointer coming at x: walks away fast for a moment (or hops aside). */
  flee(fromX: number): void {
    if (this.drag || !this.on || this.fleeLeft > 0) return;
    this.dir = this.x < fromX ? -1 : 1; this.fleeLeft = 0.9; this.chaseUntil = 0;
    if (this.has('walk')) { this.enter('walk'); this.steps = [{ anim: this.steps[0]?.anim ?? this.anim, left: 0.9 }]; }
    else { this.on = null; this.vy = -420; this.vx = this.dir * 260; this.enter('fall'); }
  }
  /** Less motion: standing on the floor in its first idle picture, nothing chosen, nothing moving. */
  rest(floor: number): void {
    this.on = 'floor'; this.y = floor; this.vx = this.vy = 0; this.drag = null; this.state = 'idle'; this.steps = [];
    const a = this.pack.states.idle?.[0]?.steps[0]?.anim ?? this.pack.states.walk?.[0]?.steps[0]?.anim; if (a) this.anim = a; this.animT = 0;
    this.x = clamp(this.x, this.halfW(), this.world.width - this.halfW());
  }
  /* ---------- time ---------- */
  private walkSpeed(): number {
    const a = this.animOf(); const base = a?.speed ? a.speed * this.k : 45 * Math.max(0.6, this.k);
    return Math.min(400, base * (ACT[this.opts.activity] ?? ACT.normal).speed * (this.fleeLeft > 0 ? 2.6 : 1));
  }
  private halfW(): number { const f = this.frame(); const sz = this.sizes[f] ?? [this.pack.frameW, this.pack.frameH]; return Math.max(4, sz[0] * this.k / 2); }
  private land(id: string, y: number): void {
    this.y = y; this.on = id; const s = id === 'floor' ? null : this.world.surfaces.find((x) => x.id === id); this.onX = s ? s.x : 0;
    if (this.state === 'thrown' && this.vy > BOUNCE_MIN && this.bounces < 3) { this.bounces++; this.on = null; this.vy = -this.vy * 0.42; this.vx *= 0.7; return; }
    this.vx = 0; this.vy = 0; this.bounces = 0; this.chaseUntil = 0; this.next();
  }
  step(dt: number, world: World): void {
    this.world = world; dt = Math.min(dt, 0.1); this.t += dt; this.animT += dt;
    if (this.fleeLeft > 0) this.fleeLeft -= dt;
    if (this.opts.speech && this.pack.speech?.length) { if (this.sayLeft > 0) { this.sayLeft -= dt; if (this.sayLeft <= 0) this.say = null; } else if (this.t > this.nextSay && this.on && this.state !== 'walk') { this.say = this.pack.speech[Math.floor(this.r() * this.pack.speech.length)]; this.sayLeft = 4; this.nextSay = this.t + 40 + 50 * this.r(); } }
    if (this.drag) { this.advanceSteps(dt, true); return; }
    const hw = this.halfW();
    if (!this.on) {
      const py = this.y; this.vy = Math.min(MAX_SPEED, this.vy + GRAVITY * dt); this.x += this.vx * dt; this.y += this.vy * dt;
      if (Math.abs(this.vx) > 30) this.dir = this.vx > 0 ? 1 : -1;
      if (this.x < hw) { this.x = hw; this.vx = Math.abs(this.vx) * 0.5; } else if (this.x > world.width - hw) { this.x = world.width - hw; this.vx = -Math.abs(this.vx) * 0.5; }
      const top = Math.min(world.floor - 8, 8 + (this.sizes[this.frame()]?.[1] ?? this.pack.frameH) * this.k); if (this.y < top && this.vy < 0) { this.y = top; this.vy = Math.abs(this.vy) * 0.3; }
      if (this.vy >= 0) {
        let best: Surface | null = null;
        for (const s of world.surfaces) if (py <= s.y + 0.5 && this.y >= s.y && this.x >= s.x && this.x <= s.x + s.w && (!best || s.y < best.y)) best = s;
        if (best) this.land(best.id, best.y);
        else if (this.y >= world.floor) this.land('floor', world.floor);
      }
      this.advanceSteps(dt, true); return;
    }
    // On a wall (climbing): up the screen's edge, letting go at the top.
    if (this.on === 'wall') {
      this.x = this.dir > 0 ? world.width - hw : hw;
      if (this.state === 'climb') { this.y -= Math.min(200, (this.animOf()?.speed ?? 30) * this.k) * dt; if (this.y < 8 + (this.sizes[this.frame()]?.[1] ?? this.pack.frameH) * this.k) { this.letGo(); return; } }
      this.advanceSteps(dt, false); return;
    }
    // On something: carried when it moves; falls when it is gone.
    if (this.on !== 'floor') {
      const s = world.surfaces.find((x) => x.id === this.on);
      if (!s) { this.on = null; this.enter('fall'); return; }
      this.x += s.x - this.onX; this.onX = s.x; this.y = s.y;
    } else this.y = world.floor;
    if (this.state === 'walk') {
      if (this.chaseUntil > this.t && world.pointer) { const d = world.pointer.x - this.x; if (Math.abs(d) < 30) this.chaseUntil = 0; else this.dir = d > 0 ? 1 : -1; }
      this.x += this.dir * this.walkSpeed() * dt;
      const s = this.on === 'floor' ? null : world.surfaces.find((x) => x.id === this.on);
      const lo = s ? s.x : hw, hi = s ? s.x + s.w : world.width - hw;
      if (this.x < lo || this.x > hi) {
        if (s && this.fleeLeft <= 0 && this.r() < STEP_OFF) { this.on = null; this.vx = this.dir * 60; this.vy = 0; this.enter('fall'); }
        // (The screen's edge, for a pack that climbs: up the wall, now and then.)
        else if (!s && this.fleeLeft <= 0 && this.chaseUntil <= this.t && this.r() < CLIMB && this.startClimb()) return;
        else { this.x = clamp(this.x, lo, hi); this.dir = this.dir > 0 ? -1 : 1; }
      }
      this.x = clamp(this.x, hw, world.width - hw);
    }
    this.advanceSteps(dt, false);
  }
  private advanceSteps(dt: number, held: boolean): void {
    if (held || !this.steps.length) return;
    const cur = this.steps[0]; cur.left -= dt;
    if (cur.left > 0) return;
    this.steps.shift();
    if (this.steps.length) { this.stepAnim(); return; }
    if (this.state === 'click') { this.enter('idle'); return; }
    if (this.follow()) return;
    if (this.chaseUntil > this.t) { this.enter('walk'); return; }
    this.next();
  }
  /** A climb started at the screen's edge where the pack has one allowed on a wall; false otherwise. */
  private startClimb(): boolean {
    const was = this.on; this.on = 'wall'; const c = this.pick('climb');
    if (!c) { this.on = was; return false; }
    this.vx = this.vy = 0; this.enter('climb', c); return true;
  }
  private letGo(): void { this.on = null; this.vx = (this.dir > 0 ? -1 : 1) * 80; this.vy = 0; this.enter('fall'); }
  /** The window resized (or a pet woken where it was): kept inside, on the floor where it stood on it. */
  fit(world: World): void {
    this.world = world; const hw = this.halfW();
    this.x = clamp(this.x, hw, Math.max(hw, world.width - hw));
    if (this.on === 'floor') this.y = world.floor; else if (this.on === 'wall') this.x = this.dir > 0 ? world.width - hw : hw;
    else if (this.y > world.floor) this.y = world.floor;
  }
  /** At rest: seconds until anything drawn changes by itself (the next picture, the end of what it does), else
   *  Infinity; 0 while it moves. */
  restFor(): number {
    if (this.busy() || this.state === 'climb') return 0;
    let t = this.steps[0] ? this.steps[0].left : Infinity;
    const a = this.animOf();
    if (a && a.frames.length > 1) {
      if (a.durations) { const total = a.durations.reduce((x, y) => x + y, 0); let u = a.loop ? this.animT % total : this.animT; let i = 0; while (i < a.durations.length && u >= a.durations[i]) { u -= a.durations[i]; i++; } if (i < a.durations.length && (a.loop || i < a.durations.length - 1)) t = Math.min(t, a.durations[i] - u); }
      else { const per = 1 / a.fps; const into = this.animT % per; if (a.loop || this.animT * a.fps < a.frames.length - 1) t = Math.min(t, per - into); }
    }
    if (this.opts.speech && this.sayLeft > 0) t = Math.min(t, this.sayLeft);
    return Math.max(0, t);
  }
  /* ---------- what is drawn ---------- */
  /** The frames used now: the pictures for walking right where the pack has them. */
  private right(a: PetAnim): boolean { return this.dir > 0 && !!a.framesRight && a.framesRight.length === a.frames.length; }
  frame(): number {
    const a = this.animOf(); if (!a) return 0;
    const n = a.frames.length; let i = 0;
    if (a.durations) { const total = a.durations.reduce((x, y) => x + y, 0); let t = a.loop ? this.animT % total : Math.min(this.animT, total - 1e-6); while (i < n - 1 && t >= a.durations[i]) { t -= a.durations[i]; i++; } }
    else { i = Math.floor(this.animT * a.fps); i = a.loop ? i % n : Math.min(i, n - 1); }
    return (this.right(a) ? a.framesRight! : a.frames)[i];
  }
  /** Moving (walking, in the air, held, reacting): drawn at 30 a second; else 10. */
  busy(): boolean { return !this.on || this.state === 'walk' || this.state === 'climb' || this.state === 'click' || !!this.drag; }
  view(): PetView {
    const a = this.animOf(); const f = this.frame(); const rt = !!a && this.right(a);
    const idx = a ? (rt ? a.framesRight! : a.frames).indexOf(f) : -1;
    const sz = this.sizes[f] ?? [this.pack.frameW, this.pack.frameH];
    const anc = (idx >= 0 && (rt ? a?.anchorsRight?.[idx] : a?.anchors?.[idx])) || [this.pack.anchor[0] * sz[0] / this.pack.frameW, this.pack.anchor[1] * sz[1] / this.pack.frameH];
    // (Drawn mirrored when facing away from the pictures' side — not the pictures made for the right, nor a climb, which
    // faces the wall it holds.)
    const flip = !rt && a?.mirror !== false && ((this.pack.facing === 'left') === (this.dir > 0));
    const w = sz[0] * this.k, h = sz[1] * this.k; const ax = (flip ? sz[0] - anc[0] : anc[0]) * this.k;
    return { x: this.x - ax, y: this.y - anc[1] * this.k, w, h, frame: f, flip, state: this.state, say: this.say };
  }
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** The draw scale: a pack's frames brought near a common height (96 px for «M»), then the size chosen. */
export function drawScale(pack: PetPack, size: 'S' | 'M' | 'L' | 'custom', custom?: number): number {
  const fit = clamp(96 / Math.max(1, pack.frameH * pack.scale), 0.25, 4) * pack.scale;
  const k = size === 'custom' ? clamp(custom ?? 1, 0.25, 4) : size === 'S' ? 0.67 : size === 'L' ? 1.5 : 1;
  return fit * k;
}
