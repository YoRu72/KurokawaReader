// Tier A: the pets inside the app's window. Each pet is a small canvas the size of its picture, moved over the page
// (above the content, below sheets and menus); the page underneath gets every click except those on the pet's opaque
// pixels (the canvas takes the pointer only while it is over one). Pets walk on the window's bottom edge and on the
// tops of the app's panels (measured), move out of the way of a pointer heading for a control under them, are hidden
// in full screen and while a video plays (when chosen), stand still on battery (when chosen) and with the system's
// «less motion», and do no work at all while the window is hidden. 30 frames a second while moving, 10 at rest.
import { PetSim, drawScale, type Surface, type World } from './runtime';
import { loadPet, type LoadedPet } from './store';
import { hitView } from './draw';
import type { PetPrefs } from './prefs';

/** Where a pet may stand: the app's boxes (cards, grouped rows, download rows, bars) — those drawn as boxes (a background
 *  or a border of their own), whose top edge is open (nothing solid just above it: not the seam between two rows). */
const SURFACES = '#app .card, #app .card > .row, #app .card > label.row, #app .task, #app .dl-status, #app [data-pet-surface]';
const BUSY_MS = 1000 / 30, MAX_REST_MS = 15000;
interface Pet { id: string; lp: LoadedPet; sim: PetSim; cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D; masks: (Uint8Array | null)[]; bubble: HTMLElement; press: { x: number; y: number; t: number; moved: boolean; id: number } | null }
export type StageWhy = 'hidden' | 'fullscreen' | 'video' | 'battery' | 'motion' | null;

export interface StageHooks { hide(): void; settings(): void; /** A pet that failed (its pack): taken off, the user told. */ failed?(name: string): void; labels: { hide: string; settings: string } }
export class Stage {
  readonly host: HTMLElement; pets: Pet[] = [];
  private timer = 0; private off: (() => void)[] = []; private surfaces: Surface[] = []; private dirty = true; private mutTimer = 0;
  private ids = new WeakMap<Element, string>(); private nextId = 1; private last = 0;
  private pointer: { x: number; y: number } | null = null; private lastFlee = 0; private prevDist = new Map<string, number>();
  private video = false; private onBattery = false; private menu: HTMLElement | null = null;
  why: StageWhy = null;
  constructor(public prefs: PetPrefs, private hooks: StageHooks) {
    this.host = document.createElement('div'); this.host.id = 'kt-pets'; this.host.setAttribute('aria-hidden', 'true');
    document.body.append(this.host);
    const add = (tg: EventTarget, ev: string, fn: EventListener, o: AddEventListenerOptions | boolean = false) => { tg.addEventListener(ev, fn, o); this.off.push(() => tg.removeEventListener(ev, fn, o)); };
    const upd = () => this.gate();
    add(document, 'visibilitychange', upd); add(document, 'fullscreenchange', upd);
    add(window, 'resize', () => { this.dirty = true; const w = this.world(); for (const p of this.pets) p.sim.fit(w); this.draw(); this.wake(); }, { passive: true });
    add(document, 'scroll', () => { this.dirty = true; this.wakeIfStanding(); }, { capture: true, passive: true });
    // (The panels measured again only when the page's layout changes — a view changed, a row added, a size changed —,
    // a moment after it settles; a pet standing on one then follows it, or falls when it is gone.)
    const app = document.getElementById('app');
    const changed = () => { this.dirty = true; if (!this.mutTimer) this.mutTimer = window.setTimeout(() => { this.mutTimer = 0; this.wakeIfStanding(); }, 150); };
    if (app) {
      const mo = new MutationObserver(changed); mo.observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] }); this.off.push(() => mo.disconnect());
      if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(changed); ro.observe(app); this.off.push(() => ro.disconnect()); }
    }
    this.off.push(() => { clearTimeout(this.mutTimer); this.mutTimer = 0; });
    add(window, 'pointermove', ((e: PointerEvent) => this.move(e)) as EventListener, { passive: true, capture: true });
    add(window, 'blur', () => { for (const p of this.pets) p.cv.style.pointerEvents = 'none'; });
    const vid = () => { const v = Array.from(document.querySelectorAll('video')).some((x) => !x.paused && !x.ended && x.readyState > 1); if (v !== this.video) { this.video = v; this.gate(); } };
    for (const ev of ['playing', 'play', 'pause', 'ended', 'emptied']) add(document, ev, () => queueMicrotask(vid), true);
    const mq = matchMedia('(prefers-reduced-motion: reduce)'); add(mq, 'change', upd);
    const nb = navigator as Navigator & { getBattery?(): Promise<EventTarget & { charging: boolean }> };
    void nb.getBattery?.().then((b) => { if (!this.off.length) return; const read = () => { const on = !b.charging; if (on !== this.onBattery) { this.onBattery = on; this.gate(); } }; read(); add(b, 'chargingchange', read); }).catch(() => undefined);
  }
  /** The pets shown: loaded (or kept), placed on the floor. */
  async setPets(ids: string[]): Promise<void> {
    const keep = this.pets.filter((p) => ids.includes(p.id)); for (const p of this.pets) if (!keep.includes(p)) this.drop(p);
    this.pets = keep;
    for (const [i, id] of ids.entries()) {
      if (this.pets.some((p) => p.id === id)) continue;
      const lp = await loadPet(id); if (!lp || !this.off.length) { if (lp) for (const im of lp.images) im.close(); continue; }
      const cv = document.createElement('canvas'); cv.className = 'kt-pet'; cv.dataset.pet = id;
      const bubble = document.createElement('div'); bubble.className = 'kt-pet-say'; bubble.hidden = true;
      const ctx = cv.getContext('2d')!; this.host.append(cv, bubble);
      const w = this.world(); const sim = new PetSim(lp.pack, lp.sizes, this.simOpts(lp, i), w, { x: w.width * (0.25 + 0.25 * (i % 3)), y: w.floor - 1 });
      const p: Pet = { id, lp, sim, cv, ctx, masks: [], bubble, press: null };
      this.wire(p); this.pets.push(p);
    }
    this.gate();
  }
  private simOpts(lp: LoadedPet, i: number) { return { scale: drawScale(lp.pack, this.prefs.size, this.prefs.custom), activity: this.prefs.activity, chase: this.prefs.chase, seed: 1 + i * 7919 + (Date.now() % 100000), speech: this.prefs.speech }; }
  /** New choices: the pets keep their places; size and the rest take effect at once. */
  applyPrefs(p: PetPrefs): void {
    const sizeChanged = p.size !== this.prefs.size || p.custom !== this.prefs.custom; this.prefs = p;
    this.pets.forEach((pet, i) => {
      if (sizeChanged) { const s = pet.sim; const n = new PetSim(pet.lp.pack, pet.lp.sizes, this.simOpts(pet.lp, i), this.world(), { x: s.x, y: s.y - 1 }); pet.sim = n; }
      else pet.sim.opts = { ...pet.sim.opts, activity: p.activity, chase: p.chase, speech: p.speech };
    });
    this.gate();
  }
  private drop(p: Pet): void { p.cv.remove(); p.bubble.remove(); for (const im of p.lp.images) im.close(); }
  dispose(): void {
    clearTimeout(this.timer); this.timer = 0; for (const f of this.off.splice(0)) f();
    for (const p of this.pets) this.drop(p); this.pets = []; this.closeMenu(); this.host.remove();
  }
  /* ---------- when it runs ---------- */
  private gate(): void {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.why = document.visibilityState === 'hidden' ? 'hidden' : this.prefs.pauseVideo && document.fullscreenElement ? 'fullscreen' : this.prefs.pauseVideo && this.video ? 'video' : reduced ? 'motion' : this.prefs.pauseBattery && this.onBattery ? 'battery' : null;
    this.host.hidden = this.why === 'hidden' || this.why === 'fullscreen' || this.why === 'video';
    this.host.dataset.state = this.why ?? 'on';
    clearTimeout(this.timer); this.timer = 0;
    if (this.why === 'motion') { this.still(); return; }
    // (On battery: a pet in the air — thrown, falling, held — finishes its motion, then stays where it lands.)
    if (!this.why || this.why === 'battery') { this.last = performance.now(); this.schedule(0); }
  }
  private wake(): void { if ((!this.why || this.why === 'battery') && !this.timer) { this.last = performance.now(); this.schedule(0); } else if (this.why === 'motion') this.still(); }
  private wakeIfStanding(): void { if (this.pets.some((p) => p.sim.on && p.sim.on !== 'floor')) this.wake(); }
  /** One pet failed (a fault in its pack or ours): taken off the screen; the others go on. */
  private fail(p: Pet, e: unknown): void {
    console.error('[pets]', e); this.drop(p); this.pets = this.pets.filter((x) => x !== p);
    try { this.hooks.failed?.(p.lp.pack.name); } catch { /* told nobody */ }
  }
  private schedule(ms: number): void { if (this.timer || !this.pets.length) return; this.timer = window.setTimeout(() => { this.timer = 0; this.frame(); }, ms); }
  /** Less motion: each pet stands on the floor in its first idle picture; nothing scheduled. */
  private still(): void {
    const w = this.world();
    for (const p of this.pets) p.sim.rest(w.floor);
    this.draw();
  }
  private frame(): void {
    if ((this.why && this.why !== 'battery') || !this.host.isConnected) return;
    const now = performance.now(); let dt = Math.min(15, (now - this.last) / 1000); this.last = now;
    const w = this.world(); const battery = this.why === 'battery';
    for (const p of [...this.pets]) {
      try {
        if (battery && p.sim.on && !p.sim.dragging) continue;
        // (A long rest is stepped through in tenths: timers run their full time, physics stays fine-grained.)
        let left = dt; while (left > 1e-6) { const d = Math.min(0.1, left); p.sim.step(d, w); left -= d; }
      } catch (e) { this.fail(p, e); }
    }
    dt = 0; this.draw();
    // (Moving: 30 a second. At rest: woken only when something drawn changes by itself — the next picture, the end of
    // what it does —; events wake it sooner. On battery: only until every pet has landed.)
    if (battery) { if (this.pets.some((p) => !p.sim.on || p.sim.dragging)) this.schedule(BUSY_MS); return; }
    const rest = Math.min(...this.pets.map((p) => p.sim.restFor()));
    if (rest === 0) this.schedule(BUSY_MS); else if (Number.isFinite(rest)) this.schedule(Math.min(MAX_REST_MS, Math.max(BUSY_MS, rest * 1000 + 5)));
  }
  /* ---------- the world: the window, its panels ---------- */
  world(): World {
    if (this.dirty) { this.dirty = false; this.surfaces = this.measure(); }
    return { width: innerWidth, height: innerHeight, floor: innerHeight, surfaces: this.surfaces, pointer: this.pointer };
  }
  private boxes = new WeakMap<Element, boolean>();
  /** Drawn as a box: a background or a top border that can be seen (read once per element). */
  private box(el: Element): boolean {
    let b = this.boxes.get(el);
    if (b === undefined) {
      const cs = getComputedStyle(el); const alpha = (c: string) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return 0; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? Number(p[3]) : 1; };
      b = alpha(cs.backgroundColor) > 0.04 || (parseFloat(cs.borderTopWidth) > 0 && alpha(cs.borderTopColor) > 0.1) || cs.backgroundImage !== 'none';
      this.boxes.set(el, b);
    }
    return b;
  }
  /** Something solid (a box that does not hold `el`) at (x, y). */
  private solidAt(x: number, y: number, el: Element): boolean {
    let n: Element | null = document.elementFromPoint(x, y); const app = document.getElementById('app');
    while (n && n !== app && n !== document.body) { if (n.contains(el)) return false; if (this.box(n)) return true; n = n.parentElement; }
    return false;
  }
  private measure(): Surface[] {
    const out: Surface[] = [];
    for (const el of Array.from(document.querySelectorAll(SURFACES))) {
      if ((el as HTMLElement).hidden || !this.box(el)) continue;
      const r = el.getBoundingClientRect(); if (r.width < 80 || r.height < 24 || r.top < 48 || r.top > innerHeight - 40 || r.right < 0 || r.left > innerWidth) continue;
      // (Covered by something on top — a sheet, a menu —: not a place to stand; a seam under another box: neither.)
      const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
      const probe = document.elementFromPoint(cx, r.top + 2);
      if (probe && !el.contains(probe) && !this.host.contains(probe)) continue;
      if (this.solidAt(cx, r.top - 3, el)) continue;
      let id = this.ids.get(el); if (!id) { id = `s${this.nextId++}`; this.ids.set(el, id); }
      out.push({ id, x: r.left, y: r.top, w: r.width });
    }
    return out;
  }
  /* ---------- drawing ---------- */
  draw(): void {
    const dpr = Math.min(2, devicePixelRatio || 1);
    for (const p of [...this.pets]) {
      let v: ReturnType<PetSim['view']>; try { v = p.sim.view(); } catch (e) { this.fail(p, e); continue; }
      const im = p.lp.images[v.frame]; if (!im) continue;
      const cw = Math.max(1, Math.ceil(v.w)), ch = Math.max(1, Math.ceil(v.h));
      if (p.cv.width !== Math.round(cw * dpr) || p.cv.height !== Math.round(ch * dpr)) { p.cv.width = Math.round(cw * dpr); p.cv.height = Math.round(ch * dpr); p.cv.style.width = `${cw}px`; p.cv.style.height = `${ch}px`; }
      const c = p.ctx; c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, p.cv.width, p.cv.height);
      c.imageSmoothingEnabled = p.sim.k < 1.5;
      if (v.flip) { c.translate(p.cv.width, 0); c.scale(-1, 1); }
      c.drawImage(im, 0, 0, p.cv.width, p.cv.height);
      p.cv.style.transform = `translate(${Math.round(v.x)}px, ${Math.round(v.y)}px)`;
      p.cv.dataset.state = v.state; p.cv.dataset.on = p.sim.on ?? ''; p.cv.dataset.frame = String(v.frame); p.cv.dataset.flip = v.flip ? '1' : '';
      p.cv.dataset.x = String(Math.round(p.sim.x)); p.cv.dataset.y = String(Math.round(p.sim.y));
      if (v.say) { p.bubble.hidden = false; p.bubble.textContent = v.say; p.bubble.style.transform = `translate(${Math.round(v.x + v.w / 2)}px, ${Math.round(v.y - 6)}px) translate(-50%, -100%)`; } else p.bubble.hidden = true;
    }
  }
  /* ---------- the pointer ---------- */
  /** Whether (x, y) — window pixels — falls on an opaque pixel of the pet. */
  hit(p: Pet, x: number, y: number): boolean { const v = p.sim.view(); return hitView(v, p.lp.images[v.frame], p.masks, x, y); }
  private move(e: PointerEvent): void {
    this.pointer = { x: e.clientX, y: e.clientY };
    for (const p of this.pets) {
      if (p.press) continue;
      const on = !this.host.hidden && this.hit(p, e.clientX, e.clientY);
      p.cv.style.pointerEvents = on ? 'auto' : 'none';
    }
    // Moving aside: the pointer coming close, a control under the pet.
    const now = performance.now(); if (now - this.lastFlee < 90 || e.buttons) return; this.lastFlee = now;
    for (const p of this.pets) {
      const v = p.sim.view(); const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
      const d = Math.hypot(e.clientX - cx, e.clientY - cy) - Math.max(v.w, v.h) / 2; const prev = this.prevDist.get(p.id) ?? 1e9; this.prevDist.set(p.id, d);
      if (d > 110 || d >= prev - 2 || !p.sim.on) continue;
      if (this.controlUnder(v)) { p.sim.flee(e.clientX); this.wake(); }
    }
  }
  private controlUnder(v: { x: number; y: number; w: number; h: number }): boolean {
    for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.7], [0.8, 0.7], [0.5, 0.9]]) {
      const x = v.x + v.w * fx, y = v.y + v.h * fy; if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      for (const el of document.elementsFromPoint(x, y)) { if (this.host.contains(el)) continue; if ((el as HTMLElement).closest?.('button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="switch"], [tabindex]:not([tabindex="-1"])')) return true; break; }
    }
    return false;
  }
  private wire(p: Pet): void {
    const cv = p.cv;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; e.preventDefault(); cv.setPointerCapture(e.pointerId); this.closeMenu();
      p.press = { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false, id: e.pointerId };
    });
    cv.addEventListener('pointermove', (e) => {
      const pr = p.press; if (!pr || e.pointerId !== pr.id) return;
      if (!pr.moved && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 4) { pr.moved = true; p.sim.grab(pr.x, pr.y, pr.t); cv.style.cursor = 'grabbing'; }
      if (pr.moved) { p.sim.dragTo(e.clientX, e.clientY, e.timeStamp); this.draw(); this.wake(); }
    });
    const up = (e: PointerEvent) => {
      const pr = p.press; if (!pr || e.pointerId !== pr.id) return; p.press = null; cv.style.cursor = '';
      if (pr.moved) p.sim.release(e.timeStamp); else if (e.type === 'pointerup') p.sim.click();
      this.wake();
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('contextmenu', (e) => { e.preventDefault(); this.openMenu(e.clientX, e.clientY); });
  }
  /* ---------- its small menu: hide, settings ---------- */
  private openMenu(x: number, y: number): void {
    this.closeMenu();
    const m = document.createElement('div'); m.className = 'kt-pet-menu'; m.setAttribute('role', 'menu');
    const item = (label: string, run: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.textContent = label; b.onclick = () => { this.closeMenu(); run(); }; m.append(b); };
    item(this.hooks.labels.hide, () => this.hooks.hide()); item(this.hooks.labels.settings, () => this.hooks.settings());
    document.body.append(m);
    const w = m.offsetWidth, h = m.offsetHeight; m.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`; m.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
    const away = (e: Event) => { if (!m.contains(e.target as Node)) this.closeMenu(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') this.closeMenu(); };
    window.addEventListener('pointerdown', away, true); window.addEventListener('keydown', esc, true);
    this.menu = m; (m as HTMLElement & { __off?: () => void }).__off = () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc, true); };
    (m.querySelector('button') as HTMLButtonElement | null)?.focus();
  }
  private closeMenu(): void { const m = this.menu as (HTMLElement & { __off?: () => void }) | null; if (!m) return; m.__off?.(); m.remove(); this.menu = null; }
}
