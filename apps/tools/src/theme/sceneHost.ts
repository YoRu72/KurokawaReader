// The scene engine's host (a computer's animated background «scene:…»): loads the Rust engine — public/scene/
// ktscene.wasm, built in CI from apps/tools/core/kt-scene and never committed —, hands it a scene file (theme/scenes/
// *.json, ktscene/1) and draws what it computes with Canvas2D. Fetched only when a scene is chosen (animbg.ts imports
// it on first use); when the engine cannot be loaded, or traps, the caller falls back to «drift».
//
// What the engine gives (core/kt-scene/src/drawlist.rs, ABI 2): a COMMAND per layer — its kind, blend, opacity and
// transform (scene units → CSS pixels: fit × camera × parallax) — and an INSTANCE buffer for the moving layers
// (particles, fog). Every stride and offset is read from the module (`kt_layout`), never assumed. Static layers (sky,
// silhouettes — hills, ridges, skylines, reeds; never trees —, disc, band, bokeh, grain, halftone) come as a small geometry each, drawn ONCE here into an offscreen
// canvas (consecutive ones with the same transform into one) and blitted after: they cost nothing per frame.
//
// Readability (the scenes' contrast rule): the theme's text must keep 4.5:1 wherever it may sit. The large static
// layers are measured once — their local mean, about two text heights a cell — and pulled toward the ground only where
// a cell is too bright (or too dark) for the text: a soft «scrim map» baked into the static canvases. Particles are
// exempt (small, sparse), with a gentle peak cap: never brighter against the ground than the text itself, and big soft
// ones (over 12 CSS px) at half alpha at most.
//
// A wasm trap (any throw from the engine) poisons that engine instance: every scene on it stops, the next load makes a
// new one, and the caller draws «drift» instead (animbg.ts).
import { contrast, type RGBA } from './themes';
import motes from './scenes/motes.json';
import nightSnowfall from './scenes/night-snowfall.json';

/** The scenes this build has, by id. */
const SCENES: Record<string, unknown> = { motes, 'night-snowfall': nightSnowfall };
export const SCENE_IDS = Object.keys(SCENES);
const ABI = 2;
const PARAM_SPEED = 0;

interface Exports {
  memory: WebAssembly.Memory;
  kt_abi(): number; kt_feature(id: number): number; kt_layout(id: number): number; kt_alloc(len: number): number; kt_free(ptr: number, len: number): void;
  scene_load(ptr: number, len: number, seed: number): number; scene_viewport(h: number, w: number, hh: number): number;
  scene_camera(h: number, px: number, py: number, zoom: number): number; scene_pointer(h: number, x: number, y: number, b: number): number; scene_click(h: number, x: number, y: number): number;
  scene_palette(h: number, i: number, rgba: number): number; scene_palette_get(h: number, i: number): number; scene_roles(h: number): number;
  scene_param(h: number, id: number, v: number): number; scene_param_get(h: number, id: number): number; scene_group(h: number, g: number, d: number, s: number): number;
  scene_step(h: number, dtMs: number): number; scene_substeps(h: number): number; scene_cmds(h: number): number; scene_ncmd(h: number): number;
  scene_inst(h: number): number; scene_geom(h: number, layer: number): number; scene_hint(h: number, id: number): number;
  scene_live(h: number): number; scene_state_hash(h: number): number; scene_free(h: number): number;
}
const NEEDED = ['memory', 'kt_abi', 'kt_feature', 'kt_layout', 'kt_alloc', 'kt_free', 'scene_load', 'scene_viewport', 'scene_camera', 'scene_pointer', 'scene_click', 'scene_palette', 'scene_palette_get', 'scene_roles', 'scene_param', 'scene_param_get', 'scene_group', 'scene_step', 'scene_substeps', 'scene_cmds', 'scene_ncmd', 'scene_inst', 'scene_geom', 'scene_hint', 'scene_live', 'scene_state_hash', 'scene_free'];

/** The layouts as the module states them (kt_layout ids: 0/1 strides, 100+ instance fields, 200+ command fields). */
interface Layout { IS: number; CS: number; X: number; Y: number; SX: number; SY: number; ROT: number; ALPHA: number; RGBA: number; SPRITE: number; COLOUR: number; KIND: number; BLEND: number; OPACITY: number; START: number; COUNT: number; LAYER: number; SCALE: number; TX: number; TY: number; STATIC: number; GLEN: number; GVER: number; KNOWN: number }
function readLayout(ex: Exports): Layout {
  const g = (id: number): number => { const v = ex.kt_layout(id); if (!(v >= 0)) throw new Error(`ktscene.wasm: no layout ${id}`); return v; };
  return { IS: g(0), CS: g(1), X: g(100), Y: g(101), SX: g(102), SY: g(103), ROT: g(104), ALPHA: g(105), RGBA: g(106), SPRITE: g(107), COLOUR: g(110), KIND: g(200), BLEND: g(201), OPACITY: g(202), START: g(205), COUNT: g(206), LAYER: g(207), SCALE: g(208), TX: g(209), TY: g(210), STATIC: g(211), GLEN: g(212), GVER: g(213), KNOWN: g(214) };
}

/** One instantiated engine; poisoned by a trap (nothing calls into it after). */
class Engine { poisoned = false; constructor(readonly ex: Exports, readonly L: Layout) {} }
/** The scene id was not in this build (the caller says so, not «engine unavailable»). `ktKind` survives minifying. */
export class UnknownScene extends Error { readonly ktKind = 'unknown'; }
/** The engine threw (a trap): the caller falls back. */
export class SceneTrap extends Error { readonly ktKind = 'trap'; }

/** The engine, compiled and instantiated once a page; a failure is kept for a while, then tried again. */
let engine: Promise<Engine> | null = null; let failedAt = 0;
const RETRY_MS = 30_000;
function loadEngine(): Promise<Engine> {
  if (engine && !(failedAt && performance.now() - failedAt > RETRY_MS)) return engine;
  failedAt = 0;
  const p = (async () => {
    const url = new URL('scene/ktscene.wasm', document.baseURI).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ktscene.wasm: HTTP ${res.status}`);
    let inst: WebAssembly.Instance | null = null;
    // (Streaming compiles while it downloads, but only from a response typed application/wasm; otherwise the bytes.)
    if (typeof WebAssembly.instantiateStreaming === 'function' && /application\/wasm/i.test(res.headers.get('content-type') ?? '')) {
      try { inst = (await WebAssembly.instantiateStreaming(res.clone(), {})).instance; } catch { inst = null; }
    }
    if (!inst) {
      const buf = await res.arrayBuffer(); const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      if (b.length < 4 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) throw new Error('ktscene.wasm: not a wasm file');
      inst = (await WebAssembly.instantiate(buf, {})).instance;
    }
    const ex = inst.exports as unknown as Exports;
    const miss = NEEDED.filter((k) => !(k in ex)); if (miss.length) throw new Error(`ktscene.wasm: no export ${miss[0]} (an older engine?)`);
    if (ex.kt_abi() !== ABI) throw new Error(`ktscene.wasm: ABI ${ex.kt_abi()}, this page speaks ${ABI}`);
    return new Engine(ex, readLayout(ex));
  })();
  p.catch(() => { if (engine === p) failedAt = performance.now(); });
  engine = p; return p;
}
/** A trap: this engine is never called again; the next scene loads a new one. */
function poison(e: Engine): void {
  e.poisoned = true;
  void engine?.then((cur) => { if (cur === e) engine = null; }, () => undefined);
}

/** A scene file into the engine: a handle (> 0), or the engine's error code thrown. */
function loadInto(ex: Exports, text: string, seed: number): number {
  const bytes = new TextEncoder().encode(text);
  const p = ex.kt_alloc(bytes.length); if (!p) throw new Error('ktscene: the scene file is too large');
  try { new Uint8Array(ex.memory.buffer, p, bytes.length).set(bytes); return ex.scene_load(p, bytes.length, seed >>> 0); }
  finally { ex.kt_free(p, bytes.length); }
}

/** Live scenes (the tests count them back to zero after a teardown). */
let live = 0;
export const liveScenes = (): number => live;

/* ---------- colours ---------- */
const mix = (a: RGBA, b: RGBA, k: number): RGBA => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] ?? 1];
const css = (c: RGBA, a = 1): string => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${+(a * (c[3] ?? 1)).toFixed(4)})`;
function hex(s: string): RGBA | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s); if (!m) return null; let h = m[1];
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
}
const pack = (c: RGBA): number => ((Math.round(c[0]) << 24) | (Math.round(c[1]) << 16) | (Math.round(c[2]) << 8) | Math.round(255 * (c[3] ?? 1))) >>> 0;
const unpack = (v: number): RGBA => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, (v & 255) / 255];

/** What the theme gives a scene: light or dark, the ground, the text roles, a role's colour, and the no-yellow rule. */
export interface SceneTheme { light: boolean; ground: RGBA; texts: RGBA[]; panel: RGBA | null; role(name: string): RGBA; noYellow(c: RGBA): RGBA }
interface PalSpec { role?: string; lit?: RGBA }
function palSpecs(def: unknown, light: boolean): PalSpec[] {
  const p = (def as { palette?: unknown }).palette; const list: unknown[] = Array.isArray(p) ? p : Array.isArray((p as { roles?: unknown[] })?.roles) ? (p as { roles: unknown[] }).roles : [];
  const one = (v: unknown): PalSpec => (typeof v === 'string' ? (v.startsWith('#') ? { lit: hex(v) ?? [128, 128, 128, 1] } : { role: v }) : { role: 'primary' });
  const out = list.map((e) => { if (typeof e === 'string') return one(e); const o = (e ?? {}) as Record<string, unknown>; const d = o.dark ?? o.colour ?? o.role; return one(light ? o.light ?? d : d); });
  return out.length ? out : [{ role: 'primary' }];
}

/* ---------- sprites ---------- */
function mk(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
/** Sprite `id` in colour `c`: 0 soft dot, 1 crisp flake, 2 streak, 3 ring, 4 puff. */
function sprite(id: number, c: RGBA): HTMLCanvasElement {
  const n = 64; const [cv, g] = mk(n, n); if (!g) return cv;
  const radial = (stops: [number, number][]): void => { const grd = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2); for (const [s, a] of stops) grd.addColorStop(s, css(c, a)); g.fillStyle = grd; g.fillRect(0, 0, n, n); };
  if (id === 1) radial([[0, 1], [0.3, 0.95], [0.42, 0.35], [1, 0]]);
  else if (id === 2) { const grd = g.createLinearGradient(0, 0, 0, n); grd.addColorStop(0, css(c, 0)); grd.addColorStop(0.5, css(c, 0.9)); grd.addColorStop(1, css(c, 0)); g.fillStyle = grd; g.fillRect(n * 0.4, 0, n * 0.2, n); }
  else if (id === 3) { g.strokeStyle = css(c, 0.9); g.lineWidth = n * 0.06; g.beginPath(); g.arc(n / 2, n / 2, n * 0.4, 0, Math.PI * 2); g.stroke(); }
  else if (id === 4) radial([[0, 0.9], [0.4, 0.55], [0.75, 0.18], [1, 0]]);
  // (A soft core that holds its colour, then a smooth fall-off: a dot of a pixel or two still shows its tint.)
  else { const st: [number, number][] = []; for (let i = 0; i <= 8; i++) { const s = i / 8; const u = s < 0.3 ? 0 : (s - 0.3) / 0.7; st.push([s, Math.max(0, (1 - u) * (1 - u) * (1 + 2 * u) * (1 - u * 0.15))]); } radial(st); }
  return cv;
}

/* ---------- static layers, drawn from their geometry ---------- */
type Pal = RGBA[];
function drawStatic(g: CanvasRenderingContext2D, kind: number, geo: Float32Array, pal: Pal, b: { x0: number; y0: number; x1: number; y1: number; w: number; h: number }, opacity: number): void {
  const P = (i: number): RGBA => pal[Math.max(0, Math.min(pal.length - 1, i | 0))] ?? [128, 128, 128, 1];
  g.globalAlpha = opacity;
  if (kind === 1) { // sky
    const n = geo[0] | 0; const grd = g.createLinearGradient(0, 0, 0, b.h);
    for (let i = 0; i < n; i++) grd.addColorStop(Math.max(0, Math.min(1, geo[1 + i * 2])), css(P(geo[2 + i * 2])));
    g.fillStyle = grd; g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    const o = 1 + n * 2; if (geo[o]) { const [gx, gy, gr, gc, ga] = [geo[o + 1], geo[o + 2], geo[o + 3], geo[o + 4], geo[o + 5]]; g.save(); g.translate(gx, gy); g.scale(1, 0.5);
      const rg = g.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, gr)); rg.addColorStop(0, css(P(gc), ga)); rg.addColorStop(1, css(P(gc), 0)); g.fillStyle = rg; g.fillRect(-gr, -gr, gr * 2, gr * 2); g.restore(); }
  } else if (kind === 2) { // silhouette
    const [form, ci, hci, haze, snow, baseY, topY] = [geo[0], geo[1], geo[2], geo[3], geo[4], geo[5], geo[6]]; const n = geo[7] | 0; const col = P(ci);
    const fill = (): void => { const grd = g.createLinearGradient(0, topY, 0, b.y1); grd.addColorStop(0, css(mix(col, P(hci), haze))); grd.addColorStop(Math.min(1, Math.max(0.01, (baseY - topY) / Math.max(1, b.y1 - topY))), css(col)); grd.addColorStop(1, css(col)); g.fillStyle = grd; };
    if (form === 0 || form === 1) {
      const edge = (): void => { g.beginPath(); g.moveTo(b.x0, b.y1 + 2); for (let i = 0; i < n; i++) g.lineTo(geo[8 + i * 2], geo[9 + i * 2]); g.lineTo(b.x1, b.y1 + 2); g.closePath(); };
      fill(); edge(); g.fill();
      // (Snow-covered: the heights white, fading down the slopes, and a soft rim of light along the crest. No trees.)
      if (snow >= 0) {
        const sc = P(snow); g.save(); edge(); g.clip();
        const grd = g.createLinearGradient(0, topY, 0, baseY + (baseY - topY) * 0.8); grd.addColorStop(0, css(sc, 0.85)); grd.addColorStop(0.45, css(sc, 0.32)); grd.addColorStop(1, css(sc, 0));
        g.fillStyle = grd; g.fillRect(b.x0, topY - 4, b.x1 - b.x0, b.y1 - topY + 6); g.restore();
        g.strokeStyle = css(mix(sc, [255, 255, 255, 1], 0.3), 0.5); g.lineWidth = 2.5; g.lineJoin = 'round';
        g.beginPath(); for (let i = 0; i < n; i++) { if (i) g.lineTo(geo[8 + i * 2], geo[9 + i * 2]); else g.moveTo(geo[8], geo[9]); } g.stroke();
      }
    }
    else if (form === 3) { g.fillStyle = css(col); for (let i = 0; i < n; i++) { const [x, w, h] = [geo[8 + i * 3], geo[9 + i * 3], geo[10 + i * 3]]; g.fillRect(x, baseY - h, w, b.y1 - baseY + h + 2); } }
    else if (form === 4) { g.strokeStyle = css(col); g.lineCap = 'round'; for (let i = 0; i < n; i++) { const [x, h, lean, w] = [geo[8 + i * 4], geo[9 + i * 4], geo[10 + i * 4], geo[11 + i * 4]]; g.lineWidth = w; g.beginPath(); g.moveTo(x, b.y1 + 2); g.quadraticCurveTo(x + lean * 0.2, b.h - h * 0.6, x + lean, b.h - h); g.stroke(); } g.fillStyle = css(col); g.fillRect(b.x0, b.h - 6, b.x1 - b.x0, b.y1 - b.h + 8); }
  } else if (kind === 3) { // disc with halo
    const [x, y, r, halo, ci, glow] = [geo[0], geo[1], geo[2], geo[3], geo[4], geo[5]]; const c = P(ci); const R = r * halo;
    const rg = g.createRadialGradient(x, y, r * 0.8, x, y, R); rg.addColorStop(0, css(c, glow)); rg.addColorStop(0.35, css(c, glow * 0.35)); rg.addColorStop(1, css(c, 0)); g.fillStyle = rg; g.fillRect(x - R, y - R, R * 2, R * 2);
    g.fillStyle = css(c); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  } else if (kind === 5) { // band
    const [y0, y1, top, bottom, a0, a1] = [geo[0], geo[1], geo[2], geo[3], geo[4], geo[5]]; const grd = g.createLinearGradient(0, y0, 0, Math.max(y0 + 1, y1));
    grd.addColorStop(0, css(P(top), a0)); grd.addColorStop(1, css(P(bottom), a1)); g.fillStyle = grd; g.fillRect(b.x0, y0, b.x1 - b.x0, Math.max(b.y1, y1) - y0);
  } else if (kind === 6) { // bokeh
    const n = geo[0] | 0; for (let i = 0; i < n; i++) { const [x, y, r, ci, a] = [geo[1 + i * 5], geo[2 + i * 5], geo[3 + i * 5], geo[4 + i * 5], geo[5 + i * 5]]; const c = P(ci); const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, css(c, a)); rg.addColorStop(0.7, css(c, a * 0.8)); rg.addColorStop(1, css(c, 0)); g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2); }
  } else if (kind === 7 || kind === 8) { // grain / halftone: screen overlays, seeded
    const a = geo[0]; const cell = kind === 8 ? Math.max(2, geo[1]) : 2; let s = 12345;
    const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let y = b.y0; y < b.y1; y += cell) for (let x = b.x0; x < b.x1; x += cell) { const v = rnd(); if (kind === 7) { if (v < 0.5) continue; g.fillStyle = v > 0.75 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`; g.fillRect(x, y, cell, cell); } else { g.fillStyle = `rgba(0,0,0,${a})`; g.beginPath(); g.arc(x + cell / 2, y + cell / 2, cell * 0.22 * (0.6 + v * 0.6), 0, 6.2832); g.fill(); } }
  }
  g.globalAlpha = 1;
}
/** The contrast the scrim aims at, above 4.5: the static layers' cell mean leaves out the moving particles (snow over
 *  a lit slope adds a little light) and a text's own rectangle is smaller than a cell. */
const PANEL_TARGET = 5.3, BARE_TARGET = 5.0;
const BLEND: GlobalCompositeOperation[] = ['source-over', 'lighter', 'screen', 'multiply', 'soft-light'];

export interface SceneStats { steps: number; stepMs: number; draws: number; drawMs: number; instances: number; live: number; statics: number; scrimMax: number; panelScrim: number }
/** A group of consecutive static layers drawn into one canvas (same transform). */
interface StaticGroup { first: number; cv: HTMLCanvasElement; bx: number; by: number; scale: number; tx: number; ty: number }

/** One scene in the engine, and how it is drawn. */
export class SceneRun {
  readonly fps: number; readonly resolution: number; readonly space: { w: number; h: number; ov: number };
  private ex: Exports; private L: Layout;
  private pal: RGBA[] = []; private palKey = ''; private sprites = new Map<number, HTMLCanvasElement>(); private spriteCol: RGBA[] = [];
  private theme: SceneTheme | null = null; private groundCss = 'rgb(0,0,0)';
  private f32: Float32Array | null = null; private u32: Uint32Array | null = null; private buf: ArrayBuffer | null = null;
  private count = 0; private dead = false; private statics: StaticGroup[] = []; private scrimMax = 0;
  /** The panels' scrim the contrast rule asks for (0–1); the caller puts it on the page. */
  panelScrim = 0;
  /** Where bare text is (rectangles in the canvas's CSS pixels), asked when the scrim is made; null: everywhere. */
  bare: (() => { x: number; y: number; w: number; h: number }[]) | null = null;
  private st = { steps: 0, stepMs: 0, draws: 0, drawMs: 0 };
  /** (Tests only, with the perf flag: throw as a trap would after this many steps.) */
  trapAfter = -1;
  constructor(private eng: Engine, private h: number, private def: unknown) {
    this.ex = eng.ex; this.L = eng.L; live++;
    const fps = this.ex.scene_hint(h, 0), res = this.ex.scene_hint(h, 1);
    this.fps = fps >= 10 && fps <= 30 ? fps : 24; this.resolution = res >= 0.25 && res <= 1 ? res : 0.5;
    this.space = { w: this.ex.scene_hint(h, 2), h: this.ex.scene_hint(h, 3), ov: this.ex.scene_hint(h, 4) };
  }
  get alive(): boolean { return !this.dead && !this.eng.poisoned; }
  /** Every call into the engine: a throw poisons it and is passed on as a SceneTrap. */
  private call<T>(f: () => T): T {
    if (this.dead) throw new SceneTrap('ktscene: the scene is gone');
    if (this.eng.poisoned) { this.abandon(); throw new SceneTrap('ktscene: the engine trapped'); }
    try { return f(); } catch (e) { poison(this.eng); this.abandon(); throw new SceneTrap(`ktscene trapped: ${e instanceof Error ? e.message : String(e)}`); }
  }
  /** The engine's memory as floats and words, taken again when it has grown (a grown memory has a new buffer). */
  private views(): [Float32Array, Uint32Array] {
    const b = this.ex.memory.buffer as ArrayBuffer;
    if (b !== this.buf || !this.f32 || !this.u32) { this.buf = b; this.f32 = new Float32Array(b); this.u32 = new Uint32Array(b); }
    return [this.f32, this.u32];
  }
  viewport(w: number, h: number): void { this.call(() => this.ex.scene_viewport(this.h, w, h)); this.statics = []; }
  pointer(x: number, y: number, buttons: number): void { this.call(() => this.ex.scene_pointer(this.h, x, y, buttons)); }
  click(x: number, y: number): void { this.call(() => this.ex.scene_click(this.h, x, y)); }
  /** 1 normal, 0.6 Reduced, 0 stopped. */
  setSpeed(k: number): void { this.call(() => this.ex.scene_param(this.h, PARAM_SPEED, k)); }
  /** The theme's colours for the scene's palette: resolved, the no-yellow rule applied, told to the engine. Returns
   *  false when nothing changed (an unrelated change on <html>: no sprite or canvas is made again). */
  setTheme(t: SceneTheme): boolean {
    const specs = palSpecs(this.def, t.light);
    const pal = specs.map((s) => t.noYellow(s.role ? t.role(s.role) : s.lit ?? [128, 128, 128, 1]));
    const key = JSON.stringify([pal.map((c) => c.map((v) => Math.round(v * 100) / 100)), t.ground, t.texts, t.panel]);
    this.theme = t;
    if (key === this.palKey) return false;
    this.palKey = key; this.pal = pal; this.groundCss = css(t.ground);
    this.call(() => { pal.forEach((c, i) => this.ex.scene_palette(this.h, i, pack(c))); });
    // (The particles' colours: a role must show — at least 2:1 against the ground —, and nothing may stand out more
    //  than the text does: the peak cap.)
    const on = t.texts[0] ?? (t.light ? [24, 27, 35, 1] : [228, 228, 230, 1]); const cap = contrast(on, t.ground) * 0.85;
    this.spriteCol = pal.map((c0, i) => {
      let c: RGBA = [c0[0], c0[1], c0[2], 1];
      if (specs[i]?.role) for (let k = 0; k < 20 && contrast(c, t.ground) < 2; k++) c = mix(c, on, 0.08);
      for (let k = 0; k < 40 && contrast(c, t.ground) > cap; k++) c = mix(c, t.ground, 0.05);
      return c;
    });
    this.sprites.clear(); this.statics = [];
    return true;
  }
  /** Time passes (ms); true when anything moved (only then is a frame worth drawing). */
  step(dtMs: number): boolean {
    const t0 = performance.now();
    const moved = this.call(() => {
      if (this.trapAfter >= 0 && this.st.steps >= this.trapAfter) throw new WebAssembly.RuntimeError('unreachable (test trap)');
      const n = this.ex.scene_step(this.h, dtMs); this.count = n > 0 ? n : 0; return this.ex.scene_substeps(this.h) > 0;
    });
    this.st.stepMs += performance.now() - t0; this.st.steps++;
    return moved;
  }
  private sprite(id: number, ci: number): HTMLCanvasElement {
    const k = id * 64 + ci; let s = this.sprites.get(k);
    if (!s) { s = sprite(id, this.spriteCol[ci] ?? this.spriteCol[0] ?? [128, 128, 128, 1]); this.sprites.set(k, s); }
    return s;
  }
  /** The static layers between two moving ones, drawn into canvases (same transform: one canvas), and the scrim map
   *  baked into them. Made again only when the transform, the canvas or the colours changed. */
  private buildStatics(cmds: Float32Array, base: number, n: number, cw: number, ch: number, k: number): void {
    const L = this.L; const groups: { first: number; last: number; scale: number; tx: number; ty: number }[] = [];
    for (let i = 0; i < n; i++) {
      const o = base + i * L.CS; if (!cmds[o + L.STATIC] || !cmds[o + L.KNOWN]) continue;
      const [s, tx, ty, bl] = [cmds[o + L.SCALE], cmds[o + L.TX], cmds[o + L.TY], cmds[o + L.BLEND]];
      const g = groups[groups.length - 1];
      if (g && g.last === i - 1 && Math.abs(g.scale - s) < 1e-4 && Math.abs(g.tx - tx) < 0.01 && Math.abs(g.ty - ty) < 0.01 && !bl) g.last = i; else groups.push({ first: i, last: i, scale: s, tx, ty });
    }
    const { w: SW, h: SH, ov } = this.space; const bnd = { x0: -SW * ov, y0: -SH * ov, x1: SW * (1 + ov), y1: SH * (1 + ov), w: SW, h: SH };
    const out: StaticGroup[] = [];
    for (const gr of groups) {
      const S = gr.scale * k; const bx = Math.floor((bnd.x0 * gr.scale + gr.tx) * k), by = Math.floor((bnd.y0 * gr.scale + gr.ty) * k);
      const W = Math.min(4096, Math.ceil((bnd.x1 - bnd.x0) * S) + 2), H = Math.min(4096, Math.ceil((bnd.y1 - bnd.y0) * S) + 2);
      const [cv, g] = mk(W, H); if (!g) continue;
      g.setTransform(S, 0, 0, S, (gr.tx * k - bx), (gr.ty * k - by));
      for (let i = gr.first; i <= gr.last; i++) {
        const o = base + i * L.CS; if (!cmds[o + L.STATIC] || !cmds[o + L.KNOWN]) continue;
        const layer = cmds[o + L.LAYER] | 0, len = cmds[o + L.GLEN] | 0; if (!len) continue;
        const p = this.call(() => this.ex.scene_geom(this.h, layer)); if (!p) continue;
        const geo = new Float32Array(this.views()[0].buffer, p, len).slice();
        g.globalCompositeOperation = BLEND[cmds[o + L.BLEND] | 0] ?? 'source-over';
        drawStatic(g, cmds[o + L.KIND] | 0, geo, this.pal, bnd, cmds[o + L.OPACITY]);
      }
      g.globalCompositeOperation = 'source-over';
      out.push({ first: gr.first, cv, bx, by, scale: gr.scale, tx: gr.tx, ty: gr.ty });
    }
    this.statics = out;
    this.bakeScrim(cw, ch, k);
  }
  /** The contrast rule, from the static layers' local mean (cells of about two text heights, the scene's particles
   *  left out):
   *  - PANELS (glass): the least mix of the ground into the panels' tint that keeps every text role at 5.3:1 over the
   *    worst cell — `panelScrim`, which the caller puts on the page (--abg-scrim); the scene stays as it is;
   *  - BARE TEXT (no panel under it, `bare` gives its rectangles in the canvas's CSS pixels; none given: everywhere):
   *    only the cells under it are pulled toward the ground, as little as keeps 5:1 (above 4.5 for the text's own
   *    spread and the particles) — spread to the neighbouring cells, smoothed, and baked into the static canvases. */
  private bakeScrim(cw: number, ch: number, k: number): void {
    const t = this.theme; if (!t || !this.statics.length) { this.scrimMax = 0; this.panelScrim = 0; return; }
    // (Cells of about 20 canvas pixels: at the scenes' half resolution, 40 CSS pixels — two lines of text.)
    const GW = Math.max(4, Math.round(cw / 20)), GH = Math.max(3, Math.round(ch / 20));
    const [, mg] = mk(GW, GH); if (!mg) return;
    mg.fillStyle = this.groundCss; mg.fillRect(0, 0, GW, GH); mg.imageSmoothingQuality = 'high';
    for (const st of this.statics) mg.drawImage(st.cv, st.bx * GW / cw, st.by * GH / ch, st.cv.width * GW / cw, st.cv.height * GH / ch);
    const d = mg.getImageData(0, 0, GW, GH).data;
    const texts = t.texts.length ? t.texts : [[128, 128, 128, 1] as RGBA];
    const least = (ok: (x: number) => boolean): number => { if (ok(0)) return 0; let lo = 0, hi = 1; for (let it = 0; it < 12; it++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; } return hi; };
    // (Which cells hold bare text.)
    let mask: Uint8Array | null = null;
    const rects = this.bare ? this.bare() : null;
    if (rects) {
      mask = new Uint8Array(GW * GH); const cx = GW / cw * k, cy = GH / ch * k;
      for (const r of rects) { const x0 = Math.max(0, Math.floor(r.x * cx)), x1 = Math.min(GW - 1, Math.floor((r.x + r.w) * cx)), y0 = Math.max(0, Math.floor(r.y * cy)), y1 = Math.min(GH - 1, Math.floor((r.y + r.h) * cy)); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * GW + x] = 1; }
    }
    const need = new Float32Array(GW * GH); let panel = 0; const pt = t.panel;
    for (let i = 0; i < GW * GH; i++) {
      const c: RGBA = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], 1];
      if (!mask || mask[i]) need[i] = least((x) => { const b = mix(c, t.ground, x); return texts.every((tx) => contrast(tx, b) >= BARE_TARGET); });
      if (pt) panel = Math.max(panel, least((sc) => { const A = sc + pt[3] * (1 - sc); const b: RGBA = [0, 1, 2].map((j) => t.ground[j] * sc + pt[j] * pt[3] * (1 - sc) + c[j] * (1 - A)) as unknown as RGBA; b[3] = 1; return texts.every((tx) => contrast(tx, b) >= PANEL_TARGET); }));
    }
    this.panelScrim = panel;
    // (Each cell takes the most its neighbours need: the smoothing never leaves a cell short.)
    const [mp, mpg] = mk(GW, GH); if (!mpg) return; const img = mpg.createImageData(GW, GH); let max = 0;
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      let v = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < GW && yy < GH) v = Math.max(v, need[yy * GW + xx]); }
      const j = (y * GW + x) * 4; img.data[j] = t.ground[0]; img.data[j + 1] = t.ground[1]; img.data[j + 2] = t.ground[2]; img.data[j + 3] = Math.ceil(v * 255); max = Math.max(max, v);
    }
    mpg.putImageData(img, 0, 0); this.scrimMax = max;
    if (max <= 0) return;
    for (const st of this.statics) { const g = st.cv.getContext('2d'); if (!g) continue; g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-atop'; g.imageSmoothingEnabled = true; g.drawImage(mp, -st.bx, -st.by, cw, ch); g.restore(); }
  }
  /** The static canvases (and the scrim) made again at the next frame: the page's text moved (another view). */
  rebake(): void { this.statics = []; }
  /** One frame on `g` (`w`×`h` device pixels, `k` of them a CSS pixel): the ground, then every layer in order. */
  render(g: CanvasRenderingContext2D, w: number, h: number, k: number): void {
    const t0 = performance.now();
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.fillStyle = this.groundCss; g.fillRect(0, 0, w, h);
    const L = this.L;
    const [f, u] = this.views();
    const pc = this.call(() => this.ex.scene_cmds(this.h)), n = this.call(() => this.ex.scene_ncmd(this.h)), pi = this.call(() => this.ex.scene_inst(this.h));
    if (pc && n > 0) {
      const cb = pc >>> 2, ib = pi >>> 2;
      if (!this.statics.length) this.buildStatics(f, cb, n, w, h, k);
      let si = 0; let stale = false;
      for (let c = 0; c < n; c++) {
        const o = cb + c * L.CS; if (!f[o + L.KNOWN]) continue;
        if (f[o + L.STATIC]) {
          const s = this.statics[si];
          if (s && s.first === c) {
            // (The camera moved this layer: drawn where it was this frame, made again for the next.)
            if (Math.abs(s.scale - f[o + L.SCALE]) > 1e-4 || Math.abs(s.tx - f[o + L.TX]) > 0.01 || Math.abs(s.ty - f[o + L.TY]) > 0.01) stale = true;
            g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.drawImage(s.cv, s.bx, s.by); si++;
          }
          continue;
        }
        const count = f[o + L.COUNT] | 0; if (!count || !pi) continue;
        const S = f[o + L.SCALE], tx = f[o + L.TX], ty = f[o + L.TY]; const px = S * k;
        g.setTransform(px, 0, 0, px, tx * k, ty * k); g.globalCompositeOperation = BLEND[f[o + L.BLEND] | 0] ?? 'source-over';
        const start = f[o + L.START] | 0;
        for (let i = 0; i < count; i++) {
          const q = ib + (start + i) * L.IS; const sx = f[q + L.SX], sy = f[q + L.SY]; let a = f[q + L.ALPHA];
          if (!(sx * px >= 0.25) || !(a > 0.004)) continue;
          const sp = f[q + L.SPRITE] | 0;
          // (The peak cap: big soft particles at half alpha at most; fog puffs at a quarter.)
          if (sp === 4) { if (a > 0.25) a = 0.25; } else if (sx * S > 12 && a > 0.5) a = 0.5;
          const ci = this.palIndexOf(u[q + L.RGBA], f[q + L.COLOUR]);
          g.globalAlpha = a > 1 ? 1 : a;
          const rot = f[q + L.ROT];
          if (rot) { const x = f[q + L.X], y = f[q + L.Y]; const cs = Math.cos(rot), sn = Math.sin(rot); g.setTransform(px * cs, px * sn, -px * sn, px * cs, (x * S + tx) * k, (y * S + ty) * k); g.drawImage(this.sprite(sp, ci), -sx / 2, -sy / 2, sx, sy); g.setTransform(px, 0, 0, px, tx * k, ty * k); }
          else g.drawImage(this.sprite(sp, ci), f[q + L.X] - sx / 2, f[q + L.Y] - sy / 2, sx, sy);
        }
      }
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      if (stale) this.statics = [];
    }
    this.st.drawMs += performance.now() - t0; this.st.draws++;
  }
  /** The palette index of an instance: its colour field, else found by its rgba word. */
  private palIndexOf(rgba: number, colour: number): number {
    const ci = colour | 0;
    if (ci >= 0 && ci < this.pal.length) return ci;
    const i = this.pal.findIndex((c) => pack(c) === rgba); return i < 0 ? 0 : i;
  }
  stats(): SceneStats { return { steps: this.st.steps, stepMs: this.st.steps ? this.st.stepMs / this.st.steps : 0, draws: this.st.draws, drawMs: this.st.draws ? this.st.drawMs / this.st.draws : 0, instances: this.count, live: this.alive ? this.ex.scene_live(this.h) : 0, statics: this.statics.length, scrimMax: +this.scrimMax.toFixed(3), panelScrim: +this.panelScrim.toFixed(3) }; }
  resetStats(): void { this.st = { steps: 0, stepMs: 0, draws: 0, drawMs: 0 }; }
  /** The state hash (tests: the same seed and steps give the same hash). */
  hash(): number { return this.alive ? this.ex.scene_state_hash(this.h) >>> 0 : 0; }
  /** The palette as the engine holds it (tests). */
  palette(): RGBA[] { return this.alive ? this.pal.map((_, i) => unpack(this.ex.scene_palette_get(this.h, i) >>> 0)) : []; }
  /** Freed in the engine (when it is still sound) and here. */
  free(): void { if (this.dead) return; if (!this.eng.poisoned) { try { this.ex.scene_free(this.h); } catch { poison(this.eng); } } this.abandon(); }
  /** Dropped here without calling the engine (it trapped). */
  private abandon(): void { if (this.dead) return; this.dead = true; this.sprites.clear(); this.statics = []; this.f32 = this.u32 = null; this.buf = null; live--; }
}

/** A built-in scene started in the engine (throws UnknownScene, or when the engine or the scene cannot be loaded). */
export async function openScene(id: string, seed: number): Promise<SceneRun> {
  const def = SCENES[id]; if (!def) throw new UnknownScene(`no scene «${id}» in this build`);
  const eng = await loadEngine();
  let h: number;
  try { h = loadInto(eng.ex, JSON.stringify(def), seed); } catch (e) { poison(eng); throw e; }
  if (h <= 0) throw new Error(`ktscene: «${id}» refused (${h})`);
  return new SceneRun(eng, h, def);
}

/** The wasm step for a scene of 4,096 particles (the perf gate's number): ms a step, averaged over `n` steps of 1/60 s. */
export async function bench4096(n = 240): Promise<{ stepMs: number; live: number }> {
  const { ex } = await loadEngine();
  const em = (id: string): unknown => ({ id, max: 2048, rate: 300, prewarm: 1, initializers: [{ kind: 'lifetime', min: 8, max: 14 }, { kind: 'size', min: 2, max: 6 }, { kind: 'velocity', min: [-9, -9], max: [9, 9] }], operators: [{ kind: 'drift' }, { kind: 'gravity', y: -1 }, { kind: 'drag', k: 0.3 }, { kind: 'bounds' }, { kind: 'fade' }] });
  const h = loadInto(ex, JSON.stringify({ format: 'ktscene/1', emitters: [em('a'), em('b')] }), 1); if (h <= 0) throw new Error(`ktscene: bench refused (${h})`);
  try {
    ex.scene_viewport(h, 1920, 1080); ex.scene_step(h, 1000 / 60);
    const t0 = performance.now(); for (let i = 0; i < n; i++) ex.scene_step(h, 1000 / 60);
    return { stepMs: (performance.now() - t0) / n, live: ex.scene_live(h) };
  } finally { ex.scene_free(h); }
}
