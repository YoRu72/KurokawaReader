// A background of the reader's own (theme/bgLib.ts) drawn as the app's background: the same shape as a scene's run
// (theme/sceneHost.ts SceneRun) so the background's one canvas, its pause gate, frame cap, self-throttle and teardown
// (theme/animbg.ts) carry it unchanged. A picture is drawn once (fitted, placed, blurred, its veil laid over) and blitted
// after; a moving picture frame by frame through the web view's own decoder; a video through a <video> element that
// is never on the page, muted, looped, playing only while the background may move (paused when the window is hidden,
// another video plays, the battery is low, «less motion» is asked: then its frame of that moment stays).
// Text stays readable as over the scenes: each panel takes the least veil of the ground that keeps every text role at
// 4.9:1 over the worst place under it (the reader's own «panel tint» as its least), and text with no panel gets a halo
// and, where still short, a soft feathered dimming. A moving background is measured again every few seconds, each
// place keeping the worst it has shown lately (eased back slowly), so the veils do not flicker.
import { contrast, over, type RGBA } from './themes';
import { itemById, itemFile, coloursOf, imageDecoder, type BgItem } from './bgLib';
import type { SceneTheme, SceneDom, SceneScrim } from './sceneHost';

const PANEL_TARGET = 4.9, BARE_TARGET = 4.8, HALO = 0.35;
/** A moving background's places measured again this often (ms). */
const MOVING_BAKE_MS = 2500;
const lum = (c: RGBA): number => { const f = (v: number): number => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const mix = (a: RGBA, b: RGBA, k: number): RGBA => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, 1];
const css = (c: RGBA, a = 1): string => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${+a.toFixed(4)})`;
function mk(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return [c, c.getContext('2d', { willReadFrequently: true })]; }
/** Live runs (the tests' leak check). */
let live = 0;
export const liveUserBgs = (): number => live;

type Frame = { close(): void; displayWidth: number; displayHeight: number; duration: number | null };
type Media = { kind: 'image'; bmp: ImageBitmap } | { kind: 'video'; v: HTMLVideoElement; url: string } | { kind: 'anim'; dec: { decode(o: { frameIndex: number }): Promise<{ image: Frame }>; close(): void; tracks: { selectedTrack?: { frameCount: number } } }; frame: Frame | null; next: number; due: number; busy: boolean; n: number };

/** The rectangle a picture `mw`×`mh` takes on a canvas `w`×`h` (device pixels, `k` of them a CSS pixel). */
export function fitRect(fit: BgItem['fit'], mw: number, mh: number, w: number, h: number, k: number, x: number, y: number): [number, number, number, number] {
  if (fit === 'fill') return [0, 0, w, h];
  const s = fit === 'cover' ? Math.max(w / mw, h / mh) : fit === 'contain' ? Math.min(w / mw, h / mh) : k;
  const dw = mw * s, dh = mh * s; return [(w - dw) * x, (h - dh) * y, dw, dh];
}

export class UserBgRun {
  readonly fps: number; readonly resolution: number;
  dom: (() => SceneDom) | null = null; onScrim: ((s: SceneScrim) => void) | null = null; thumb = false; trapAfter = -1;
  veil: RGBA = [0, 0, 0, 1]; theme: SceneTheme | null = null;
  private base: HTMLCanvasElement | null = null; private dimCv: HTMLCanvasElement | null = null; private needBake = true; private dead = false;
  private vw = 0; private vh = 0; private cw = 0; private ch = 0; private lastT = -1; private running = false; private speed = 1; private nextBake = 0;
  /** The worst each measured place has shown lately (a moving background), as luminance far from the veil. */
  private env: Float32Array | null = null; private envDims = '';
  /** Throttled by the background (its frames came late): the glass made light, when the entry asks «auto». */
  private slowNow = false;
  private st = { draws: 0, drawMs: 0, bakes: 0, panelScrim: 0, scrimMax: 0 };
  constructor(public item: BgItem, private media: Media) {
    live++;
    this.fps = media.kind === 'image' ? 12 : 24;
    // (A blurred moving background needs fewer pixels: the blur hides them.)
    this.resolution = media.kind === 'image' ? 1 : item.blur >= 4 ? 0.5 : 0.75;
  }
  get kind(): BgItem['kind'] { return this.media.kind; }
  private get mw(): number { const m = this.media; return m.kind === 'image' ? m.bmp.width : m.kind === 'video' ? m.v.videoWidth : m.frame?.displayWidth ?? this.item.w; }
  private get mh(): number { const m = this.media; return m.kind === 'image' ? m.bmp.height : m.kind === 'video' ? m.v.videoHeight : m.frame?.displayHeight ?? this.item.h; }
  ui(_light: boolean): { accent?: RGBA; accent2?: RGBA; tint?: RGBA } | null { return coloursOf(this.item); }
  viewport(w: number, h: number): void { if (w === this.vw && h === this.vh) return; this.vw = w; this.vh = h; this.base = null; this.needBake = true; }
  pointer(_x: number, _y: number, _b: number): void { /* a picture does not answer the mouse */ }
  click(_x: number, _y: number): void { /* nor clicks */ }
  camera(_x: number, _y: number, _z: number): void { /* nor a camera */ }
  react(_k: number): void { /* nothing to react */ }
  setSpeed(k: number): void { this.speed = k > 0 ? k : 1; const m = this.media; if (m.kind === 'video') m.v.playbackRate = this.speed; }
  setTheme(t: SceneTheme): boolean {
    const key = JSON.stringify([t.ground, t.texts, t.panel]); const was = this.theme ? JSON.stringify([this.theme.ground, this.theme.texts, this.theme.panel]) : '';
    this.theme = t; if (key === was) return false;
    this.veil = [t.ground[0], t.ground[1], t.ground[2], 1]; this.base = null; this.needBake = true; this.env = null; return true;
  }
  /** Playing or not, as the background's gate says (paused, still, held: not). */
  setRunning(on: boolean): void {
    if (this.dead || on === this.running) return; this.running = on; const m = this.media;
    if (m.kind === 'video') { if (on) { void m.v.play().catch(() => undefined); } else m.v.pause(); }
  }
  get playing(): boolean { const m = this.media; return m.kind === 'video' ? !m.v.paused : m.kind === 'anim' ? this.running : false; }
  /** The background's frames came late (or no longer): «auto» light glass follows it. */
  throttled(on: boolean): void { this.slowNow = on; this.glass(); }
  /** Light glass now: chosen, or «auto» for a moving background that the computer cannot keep up with. */
  get glassLight(): boolean { return this.item.light === 'on' || (this.item.light === 'auto' && this.media.kind !== 'image' && this.slowNow); }
  private glass(): void {
    if (!this.dom) return; const html = document.documentElement; const on = !this.dead && this.glassLight;
    if (html.classList.contains('abg-glasslight') !== on) html.classList.toggle('abg-glasslight', on);
  }
  /** Time passes (ms): true when a new frame is there to draw. */
  step(dtMs: number): boolean {
    const m = this.media; if (this.dead) return false;
    if (this.trapAfter >= 0 && this.st.draws >= this.trapAfter) throw new Error('user background stopped (test trap)');
    if (m.kind === 'video') { const t = m.v.currentTime; if (t !== this.lastT) { this.lastT = t; return true; } return false; }
    if (m.kind === 'anim') {
      m.due -= dtMs * this.speed;
      if (m.due <= 0 && !m.busy && this.running) {
        m.busy = true; const idx = m.next;
        void m.dec.decode({ frameIndex: idx }).then(({ image }) => {
          m.busy = false; if (this.dead) { image.close(); return; }
          m.frame?.close(); m.frame = image; m.next = (idx + 1) % Math.max(1, m.n);
          // (A frame's own time, at least a 24th of a second: the background draws no faster.)
          m.due = Math.max(1000 / 24, (image.duration ?? 100_000) / 1000); this.fresh = true;
        }, () => { m.busy = false; m.due = 1000; });
      }
      if (this.fresh) { this.fresh = false; return true; }
      return false;
    }
    return false;
  }
  private fresh = false;
  rebake(): void { this.needBake = true; }
  /** The picture as it is laid on the canvas: the ground, the media fitted and placed (blurred), its veil. */
  private paintMedia(g: CanvasRenderingContext2D, w: number, h: number, k: number): void {
    const it = this.item; const src: CanvasImageSource | null = this.media.kind === 'image' ? this.media.bmp : this.media.kind === 'video' ? this.media.v : this.media.frame as unknown as CanvasImageSource | null;
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none';
    g.fillStyle = css(this.veil); g.fillRect(0, 0, w, h);
    if (src && this.mw && this.mh) {
      let [x, y, dw, dh] = fitRect(it.fit, this.mw, this.mh, w, h, k, it.x, it.y);
      const b = it.blur * k;
      // (Blurred: a little larger, so the blur's soft edge falls outside the window; the canvas reaches past it too.)
      if (b > 0) { g.filter = `blur(${b.toFixed(1)}px)`; if (it.fit !== 'contain' && it.fit !== 'center') { x -= b * 2; y -= b * 2; dw += b * 4; dh += b * 4; } }
      g.imageSmoothingQuality = 'high'; g.drawImage(src, x, y, dw, dh); g.filter = 'none';
    }
    if (it.dim > 0) { g.fillStyle = css(this.veil, it.dim); g.fillRect(0, 0, w, h); }
  }
  render(g: CanvasRenderingContext2D, w: number, h: number, k: number): void {
    if (this.dead) return; const t0 = performance.now();
    if (this.media.kind === 'image') {
      if (!this.base || this.cw !== w || this.ch !== h) { const [c, cg] = mk(w, h); if (cg) this.paintMedia(cg, w, h, k); this.base = c; this.cw = w; this.ch = h; this.needBake = true; }
      g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(this.base, 0, 0);
    } else { this.paintMedia(g, w, h, k); this.cw = w; this.ch = h; }
    const now = performance.now();
    if (this.needBake || (this.media.kind !== 'image' && this.running && now > this.nextBake)) { this.nextBake = now + MOVING_BAKE_MS; this.bake(g.canvas as HTMLCanvasElement, w, h, k); }
    if (this.dimCv) { g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(this.dimCv, 0, 0); }
    this.st.draws++; this.st.drawMs += performance.now() - t0;
  }
  /** The contrast rule (as a scene's, theme/sceneHost.ts bake): each panel its veil, bare text its halo and dimming. */
  private bake(frame: HTMLCanvasElement, cw: number, ch: number, k: number): void {
    this.needBake = false; this.st.bakes++; const t = this.theme; if (!t) return;
    const GW = Math.max(4, Math.round(cw / 20)), GH = Math.max(3, Math.round(ch / 20));
    const [, mg] = mk(GW, GH); if (!mg) return;
    mg.imageSmoothingQuality = 'high'; mg.drawImage(this.media.kind === 'image' && this.base ? this.base : frame, 0, 0, cw, ch, 0, 0, GW, GH);
    const d = mg.getImageData(0, 0, GW, GH).data; const vl = lum(this.veil);
    // (Moving: each place keeps the worst it has shown — eased back a little each time —; and its neighbours'.)
    const moving = this.media.kind !== 'image'; const dims = `${GW}x${GH}`;
    if (moving && (this.envDims !== dims || !this.env)) { this.env = new Float32Array(GW * GH * 3); this.envDims = dims; for (let i = 0; i < GW * GH; i++) for (let j = 0; j < 3; j++) this.env[i * 3 + j] = d[i * 4 + j]; }
    const env = this.env;
    if (moving && env) for (let i = 0; i < GW * GH; i++) {
      const cur: RGBA = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], 1]; const old: RGBA = [env[i * 3], env[i * 3 + 1], env[i * 3 + 2], 1];
      const keep = Math.abs(lum(old) - vl) > Math.abs(lum(cur) - vl) ? mix(old, cur, 0.15) : cur; for (let j = 0; j < 3; j++) env[i * 3 + j] = keep[j];
    }
    const at = (x: number, y: number): RGBA => { const i = Math.min(GH - 1, Math.max(0, y)) * GW + Math.min(GW - 1, Math.max(0, x)); return env ? [env[i * 3], env[i * 3 + 1], env[i * 3 + 2], 1] : [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], 1]; };
    const far = (c: RGBA): number => Math.abs(lum(c) - vl);
    const cell = (x: number, y: number): RGBA => { let c = at(x, y); if (!moving) return c; for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) { const e = at(x + dx, y + dy); if (far(e) > far(c)) c = e; } return c; };
    const texts = t.texts.length ? t.texts : [[128, 128, 128, 1] as RGBA];
    const least = (ok: (x: number) => boolean): number => { if (ok(0)) return 0; let lo = 0, hi = 1; for (let it = 0; it < 12; it++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; } return hi; };
    const cx = GW / cw * k, cy = GH / ch * k;
    const cellsOf = (r: { x: number; y: number; w: number; h: number }): RGBA[] => { const out: RGBA[] = []; const x0 = Math.floor(r.x * cx), x1 = Math.floor((r.x + r.w) * cx), y0 = Math.floor(r.y * cy), y1 = Math.floor((r.y + r.h) * cy); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < GW && y < GH) out.push(cell(x, y)); return out; };
    const dom = this.dom ? this.dom() : null;
    // (Light glass: panels lose their blur, so they take a little more of the ground.)
    const floor = Math.min(0.9, this.item.veil + (this.glassLight ? 0.25 : 0));
    const panels = (dom?.panels ?? []).map((p) => {
      const pt = p.tint; let need = floor;
      const cs = p.text?.length ? p.text.flatMap(cellsOf) : cellsOf(p);
      for (const c of cs) need = Math.max(need, least((s) => { const b = mix(over(pt, c), this.veil, s); return texts.every((tx) => contrast(tx, b) >= PANEL_TARGET); }));
      return Math.min(1, need);
    });
    this.st.panelScrim = panels.reduce((a, b) => Math.max(a, b), 0);
    const bare = dom ? dom.bare : this.thumb ? [] : [{ x: 0, y: 0, w: cw / k, h: ch / k }];
    const out: { x: number; y: number; w: number; h: number; a: number }[] = [];
    for (const r of bare) {
      const cs = cellsOf(r); if (!cs.length) continue;
      const worst = cs.reduce((a, c) => (far(c) > far(a) ? c : a), cs[0]);
      const need = least((x) => { const b = mix(mix(worst, this.veil, x), this.veil, dom ? HALO : 0); return texts.every((tx) => contrast(tx, b) >= BARE_TARGET); });
      if (need > 0) out.push({ ...r, a: need });
    }
    this.st.scrimMax = out.reduce((a, b) => Math.max(a, b.a), 0); this.dimCv = null;
    if (out.length) {
      const blur = 26 * k; const [mp, mpg] = mk(cw, ch);
      if (mpg) {
        const off = cw + ch + 100;
        for (const r of out) {
          mpg.shadowColor = css(this.veil, r.a); mpg.shadowBlur = blur; mpg.shadowOffsetX = off; mpg.fillStyle = '#000';
          const x = r.x * k - blur * 0.6, y = r.y * k - blur * 0.6, w = r.w * k + blur * 1.2, h = r.h * k + blur * 1.2;
          mpg.beginPath(); if (mpg.roundRect) mpg.roundRect(x - off, y, w, h, blur); else mpg.rect(x - off, y, w, h); mpg.fill();
        }
        this.dimCv = mp;
      }
    }
    this.glass();
    this.onScrim?.({ panels, max: this.st.panelScrim });
  }
  stats(): Record<string, unknown> { return { kind: this.media.kind, item: this.item.id, playing: this.playing, running: this.running, draws: this.st.draws, drawMs: this.st.draws ? this.st.drawMs / this.st.draws : 0, bakes: this.st.bakes, panelScrim: +this.st.panelScrim.toFixed(3), scrimMax: +this.st.scrimMax.toFixed(3), glassLight: this.glassLight, live, steps: this.st.draws, stepMs: 0 }; }
  resetStats(): void { this.st.draws = 0; this.st.drawMs = 0; }
  hash(): number { return 0; }
  free(): void {
    if (this.dead) return; this.dead = true; live--;
    const m = this.media;
    if (m.kind === 'image') m.bmp.close();
    else if (m.kind === 'video') { m.v.pause(); m.v.removeAttribute('src'); m.v.load(); URL.revokeObjectURL(m.url); }
    else { m.frame?.close(); m.frame = null; try { m.dec.close(); } catch { /* closed */ } }
    this.base = this.dimCv = null; this.env = null;
    if (this.dom && document.documentElement.classList.contains('abg-glasslight')) document.documentElement.classList.remove('abg-glasslight');
  }
}

export class MissingBg extends Error { readonly ktKind = 'missing'; }
/** A background of the library opened (`id`, or «~draft»: the controls sheet's): its file read from the app's storage
 *  and made ready to draw. Throws MissingBg when the entry or its file is not here (a restored backup), or the file
 *  cannot be read. */
export async function openUserBg(id: string): Promise<UserBgRun> {
  const it = itemById(id); if (!it) throw new MissingBg(`no background «${id}» in the library`);
  const blob = await itemFile(it); if (!blob) throw new MissingBg(`the file of «${it.id}» is not in the app's storage`);
  const Dec = imageDecoder();
  if (it.kind === 'video') {
    const v = document.createElement('video'); v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto'; v.disablePictureInPicture = true;
    v.setAttribute('aria-hidden', 'true'); const url = URL.createObjectURL(blob); v.src = url;
    try {
      await new Promise<void>((res, rej) => { const done = (ok: boolean) => { clearTimeout(tm); v.removeEventListener('loadeddata', y); v.removeEventListener('error', n); if (ok) res(); else rej(new MissingBg('the video cannot be read')); }; const y = () => done(true), n = () => done(false); const tm = window.setTimeout(() => done(false), 15_000); v.addEventListener('loadeddata', y); v.addEventListener('error', n); });
    } catch (e) { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); throw e; }
    return new UserBgRun(it, { kind: 'video', v, url });
  }
  if (it.kind === 'anim' && Dec) {
    const dec = new Dec({ data: new Uint8Array(await blob.arrayBuffer()), type: it.type });
    try {
      await dec.tracks.ready; const { image } = await dec.decode({ frameIndex: 0 });
      return new UserBgRun(it, { kind: 'anim', dec, frame: image, next: 1, due: Math.max(1000 / 24, (image.duration ?? 100_000) / 1000), busy: false, n: dec.tracks.selectedTrack?.frameCount ?? 1 });
    } catch { try { dec.close(); } catch { /* closed */ } throw new MissingBg('the moving picture cannot be read'); }
  }
  let bmp: ImageBitmap; try { bmp = await createImageBitmap(blob); } catch { throw new MissingBg('the picture cannot be read'); }
  return new UserBgRun(it, { kind: 'image', bmp });
}
