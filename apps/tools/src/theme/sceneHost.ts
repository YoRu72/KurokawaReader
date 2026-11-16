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
import { contrast, over, type RGBA } from './themes';
import motes from './scenes/motes.json';
import nightSnowfall from './scenes/night-snowfall.json';
import auroraLake from './scenes/aurora-lake.json';

/** The scenes this build has, by id. */
const SCENES: Record<string, unknown> = { motes, 'night-snowfall': nightSnowfall, 'aurora-lake': auroraLake };
export const SCENE_IDS = Object.keys(SCENES);
const ABI = 2;
const PARAM_SPEED = 0;
const PARAM_REACT = 5;

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
/** Relative luminance (WCAG). */
const lum = (c: RGBA): number => { const f = (v: number): number => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
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
/** Sprite `id` in colour `c` (64 px, drawn scaled): 0 soft dot, 1 crisp dot, 2 streak, 3 ring, 4 puff, 5–7 crystal
 *  flakes (six arms, three shapes), 8 petal, 9 leaf, 10 feather, 11 curtain (a ribbon's slice). `edge`: a faint cool
 *  rim for light particles on a light sky (snow must read as snow, not as a hole). */
function sprite(id: number, c: RGBA, edge: RGBA | null): HTMLCanvasElement {
  const n = 64, m = n / 2; const [cv, g] = mk(n, n); if (!g) return cv;
  const radial = (stops: [number, number][]): void => { const grd = g.createRadialGradient(m, m, 0, m, m, m); for (const [s, a] of stops) grd.addColorStop(s, css(c, a)); g.fillStyle = grd; g.fillRect(0, 0, n, n); };
  const rim = (r: number): void => { if (!edge) return; g.strokeStyle = css(edge, 0.32); g.lineWidth = n * 0.06; g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); g.stroke(); };
  if (id === 1) { rim(n * 0.2); radial([[0, 1], [0.3, 0.95], [0.42, 0.35], [1, 0]]); }
  else if (id === 2) { const grd = g.createLinearGradient(0, 0, 0, n); grd.addColorStop(0, css(c, 0)); grd.addColorStop(0.6, css(c, 0.55)); grd.addColorStop(0.92, css(c, 0.95)); grd.addColorStop(1, css(c, 0)); g.fillStyle = grd; g.fillRect(m - n * 0.06, 0, n * 0.12, n); }
  else if (id === 3) { g.strokeStyle = css(c, 0.85); g.lineWidth = n * 0.045; g.beginPath(); g.ellipse(m, m, n * 0.44, n * 0.44, 0, 0, Math.PI * 2); g.stroke(); }
  else if (id === 4) radial([[0, 0.9], [0.4, 0.55], [0.75, 0.18], [1, 0]]);
  else if (id >= 5 && id <= 7) { // crystal flakes: six arms, side branches by shape
    const arm = (stroke: string, w: number): void => {
      g.strokeStyle = stroke; g.lineWidth = w; g.lineCap = 'round';
      for (let k = 0; k < 6; k++) {
        g.save(); g.translate(m, m); g.rotate((k * Math.PI) / 3); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -n * 0.44);
        const br = id === 5 ? [0.22, 0.32] : id === 6 ? [0.16, 0.26, 0.36] : [0.3];
        for (const b of br) { const L = n * (id === 7 ? 0.16 : 0.1); g.moveTo(0, -n * b); g.lineTo(-L, -n * b - L); g.moveTo(0, -n * b); g.lineTo(L, -n * b - L); }
        g.stroke(); g.restore();
      }
      if (id === 7) { g.beginPath(); g.arc(m, m, n * 0.09, 0, Math.PI * 2); g.stroke(); }
    };
    if (edge) arm(css(edge, 0.35), n * 0.085);
    arm(css(c, 0.95), n * 0.045);
  } else if (id === 8) { // petal: a soft teardrop with a notch, lighter at its heart
    const grd = g.createRadialGradient(m, m * 1.25, 0, m, m, m); grd.addColorStop(0, css(mix(c, [255, 255, 255, 1], 0.35), 1)); grd.addColorStop(1, css(c, 0.9)); g.fillStyle = grd;
    g.beginPath(); g.moveTo(m, n * 0.92); g.bezierCurveTo(n * 0.08, n * 0.62, n * 0.16, n * 0.08, m - n * 0.06, n * 0.1); g.lineTo(m, n * 0.2); g.lineTo(m + n * 0.06, n * 0.1); g.bezierCurveTo(n * 0.84, n * 0.08, n * 0.92, n * 0.62, m, n * 0.92); g.fill();
  } else if (id === 9) { // leaf: a pointed ellipse with its midrib
    g.fillStyle = css(c, 0.95); g.beginPath(); g.moveTo(m, n * 0.04); g.quadraticCurveTo(n * 0.95, m, m, n * 0.96); g.quadraticCurveTo(n * 0.05, m, m, n * 0.04); g.fill();
    g.strokeStyle = css(mix(c, [0, 0, 0, 1], 0.25), 0.7); g.lineWidth = n * 0.03; g.beginPath(); g.moveTo(m, n * 0.08); g.lineTo(m, n * 0.94); g.stroke();
  } else if (id === 10) { // feather: a long vane of fine barbs round a shaft
    g.strokeStyle = css(c, 0.8); g.lineWidth = n * 0.02;
    for (let k = 0; k < 18; k++) { const y = n * (0.12 + k * 0.042); const w = n * 0.2 * Math.sin((k / 17) * Math.PI) + n * 0.03; g.beginPath(); g.moveTo(m, y); g.lineTo(m - w, y - n * 0.05); g.moveTo(m, y); g.lineTo(m + w, y - n * 0.05); g.stroke(); }
    g.strokeStyle = css(c, 1); g.lineWidth = n * 0.03; g.beginPath(); g.moveTo(m, n * 0.06); g.lineTo(m, n * 0.97); g.stroke();
  } else if (id === 11) { // curtain: a ribbon's slice — faint at the top, bright low, a soft lower edge
    const grd = g.createLinearGradient(0, 0, 0, n); grd.addColorStop(0, css(c, 0)); grd.addColorStop(0.65, css(c, 0.55)); grd.addColorStop(0.86, css(c, 0.9)); grd.addColorStop(1, css(c, 0));
    g.fillStyle = grd; g.fillRect(0, 0, n, n); g.globalCompositeOperation = 'destination-in';
    const side = g.createLinearGradient(0, 0, n, 0); side.addColorStop(0, 'rgba(0,0,0,0)'); side.addColorStop(0.5, 'rgba(0,0,0,1)'); side.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = side; g.fillRect(0, 0, n, n); g.globalCompositeOperation = 'source-over';
  } else { // 0: a soft core that holds its colour, then a smooth fall-off: a dot of a pixel or two still shows its tint
    rim(n * 0.3);
    const st: [number, number][] = []; for (let i = 0; i <= 8; i++) { const s = i / 8; const u = s < 0.3 ? 0 : (s - 0.3) / 0.7; st.push([s, Math.max(0, (1 - u) * (1 - u) * (1 + 2 * u) * (1 - u * 0.15))]); } radial(st);
  }
  return cv;
}

/* ---------- static layers, drawn from their geometry ---------- */
type Pal = RGBA[];
interface Bounds { x0: number; y0: number; x1: number; y1: number; w: number; h: number }
function drawStatic(g: CanvasRenderingContext2D, kind: number, geo: Float32Array, pal: Pal, b: Bounds, opacity: number): void {
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
    // (Shaded: the crest lighter — hazed toward the far air —, deepening down the slope.)
    const fill = (): void => { const deep = mix(col, [0, 0, 0, 1], 0.28); const grd = g.createLinearGradient(0, topY, 0, b.y1); grd.addColorStop(0, css(mix(col, P(hci), haze))); grd.addColorStop(Math.min(0.95, Math.max(0.05, (baseY - topY) / Math.max(1, b.y1 - topY))), css(col)); grd.addColorStop(1, css(deep)); g.fillStyle = grd; };
    if (form === 0 || form === 1) {
      const edge = (): void => { g.beginPath(); g.moveTo(b.x0, b.y1 + 2); for (let i = 0; i < n; i++) g.lineTo(geo[8 + i * 2], geo[9 + i * 2]); g.lineTo(b.x1, b.y1 + 2); g.closePath(); };
      fill(); edge(); g.fill();
      // (Snow-covered: the snow on the crests, thinning down the slopes in a short band, shaded by the slope's own
      //  gradient below it, and a soft rim of light along the crest. No trees.)
      if (snow >= 0) {
        // (The snow follows the crest — strokes of the crest line, wide and faint to narrow and bright, clipped to the
        //  silhouette so only their lower half shows —: a cap on every ridge, never a pale block at the top's height.)
        const sc = P(snow); const span = Math.max(8, (baseY - topY) * 0.9); g.save(); edge(); g.clip();
        const crest = (): void => { g.beginPath(); for (let i = 0; i < n; i++) { if (i) g.lineTo(geo[8 + i * 2], geo[9 + i * 2]); else g.moveTo(geo[8], geo[9]); } };
        g.lineJoin = 'round'; g.lineCap = 'round';
        // (Soft: the wide stroke drawn only as its blurred shadow — off to the side, the shadow brought back —, then a
        //  narrow brighter one at the crest itself; no bands.)
        const tr = g.getTransform(); const off = Math.round(((b.x1 - b.x0) + 400) * Math.abs(tr.a)) + 400; g.save(); g.translate(-off / (tr.a || 1), 0); g.shadowColor = css(sc, 0.62); g.shadowBlur = Math.max(3, span * 0.32 * Math.abs(tr.a)); g.shadowOffsetX = off;
        g.strokeStyle = '#000'; g.lineWidth = Math.max(3, span * 0.34); crest(); g.stroke(); g.restore();
        g.strokeStyle = css(sc, 0.3); g.lineWidth = Math.max(2, span * 0.07); crest(); g.stroke();
        const shade = g.createLinearGradient(0, topY + span * 0.6, 0, b.y1); shade.addColorStop(0, css(col, 0)); shade.addColorStop(1, css(mix(col, [0, 0, 0, 1], 0.35), 0.55));
        g.fillStyle = shade; g.fillRect(b.x0, topY, b.x1 - b.x0, b.y1 - topY); g.restore();
        g.strokeStyle = css(mix(sc, [255, 255, 255, 1], 0.4), 0.55); g.lineWidth = 2; crest(); g.stroke();
      }
    } else if (form === 3) { // skyline: blocks; a few windows in the snow colour when one is given
      g.fillStyle = css(col); for (let i = 0; i < n; i++) { const [x, w, h] = [geo[8 + i * 3], geo[9 + i * 3], geo[10 + i * 3]]; g.fillRect(x, baseY - h, w, b.y1 - baseY + h + 2); }
      if (snow >= 0) { let s = 777; const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; g.fillStyle = css(P(snow), 0.8);
        for (let i = 0; i < n; i++) { const [x, w, h] = [geo[8 + i * 3], geo[9 + i * 3], geo[10 + i * 3]]; for (let yy = baseY - h + 10; yy < baseY - 8; yy += 14) for (let xx = x + 5; xx < x + w - 6; xx += 10) if (rnd() < 0.07) g.fillRect(xx, yy, 4, 5); } }
    } else if (form === 4) { g.strokeStyle = css(col); g.lineCap = 'round'; for (let i = 0; i < n; i++) { const [x, h, lean, w] = [geo[8 + i * 4], geo[9 + i * 4], geo[10 + i * 4], geo[11 + i * 4]]; g.lineWidth = w; g.beginPath(); g.moveTo(x, b.y1 + 2); g.quadraticCurveTo(x + lean * 0.2, b.h - h * 0.6, x + lean, b.h - h); g.stroke(); } g.fillStyle = css(col); g.fillRect(b.x0, b.h - 6, b.x1 - b.x0, b.y1 - b.h + 8); }
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
const PANEL_TARGET = 4.9, BARE_TARGET = 4.8;
/** What a bare text's halo (text-shadow in the ground colour, `data-abg-halo`) is counted as: the ground mixed this
 *  much into the scene right round the glyphs. */
export const HALO = 0.35;
/** The most a panel's scrim may take: glass stays glass. */
const PANEL_MAX = 0.9;
const BLEND: GlobalCompositeOperation[] = ['source-over', 'lighter', 'screen', 'multiply', 'soft-light'];

export interface SceneStats { steps: number; stepMs: number; draws: number; drawMs: number; instances: number; live: number; statics: number; scrimMax: number; panelScrim: number }
/** A run of consecutive static layers with the same parallax, drawn into one canvas at the transform of its making;
 *  blitted after at the transform of the frame (the camera's shift and a small zoom need no redraw). */
interface StaticGroup { first: number; clean: HTMLCanvasElement; cv: HTMLCanvasElement; bx: number; by: number; scale: number; tx: number; ty: number }
/** What the page gives the scrim: its panels (rectangles in the canvas's CSS pixels, each with its own tint) and its
 *  bare texts (rectangles); null: no page around (a preview): everything counts as bare text. */
/** The page under a scene: each panel (with the text it holds — measured there, not under its whole surface — when the
 *  page knows it) and each text with no panel under it; rectangles in the canvas's CSS pixels. */
export interface SceneDom { panels: { x: number; y: number; w: number; h: number; tint: RGBA; text?: { x: number; y: number; w: number; h: number }[] }[]; bare: { x: number; y: number; w: number; h: number }[] }
/** What the scrim asks of the page: each panel's veil (0–PANEL_MAX), in the panels' order, and the most of them. */
export interface SceneScrim { panels: number[]; max: number }

/** One scene in the engine, and how it is drawn. */
export class SceneRun {
  readonly fps: number; readonly resolution: number; readonly space: { w: number; h: number; ov: number };
  private ex: Exports; private L: Layout;
  private pal: RGBA[] = []; private palKey = ''; private sprites = new Map<number, HTMLCanvasElement>(); private spriteCol: RGBA[] = []; private edge: RGBA | null = null;
  theme: SceneTheme | null = null; private groundCss = 'rgb(0,0,0)';
  private f32: Float32Array | null = null; private u32: Uint32Array | null = null; private buf: ArrayBuffer | null = null;
  private count = 0; private dead = false; private statics: StaticGroup[] = []; private scrimMax = 0; private needBake = true;
  private mirrorCv: HTMLCanvasElement | null = null; private reflCv: HTMLCanvasElement | null = null; private reflAt = -1; private reflWy = 0; private accumBumps = new Map<number, Float32Array>(); private t0 = performance.now();
  /** The page's panels and bare text, asked when the scrim is made; null: everywhere bare (a preview). */
  dom: (() => SceneDom) | null = null;
  /** Told when the scrim is made: what the page's panels should take. */
  onScrim: ((s: SceneScrim) => void) | null = null;
  panelScrim = 0;
  /** The scene has large moving layers (ribbons, a mirror, settled snow): its frames are measured too. */
  private wide = false;
  private ribCv: HTMLCanvasElement | null = null;
  /** The colour the veils and halos are made of (the page puts it on the panels too). */
  veil: RGBA = [0, 0, 0, 1];
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
  /** The scene file's small UI palette for the mode (accent, accent2, tint), when it has one. */
  ui(light: boolean): { accent?: RGBA; accent2?: RGBA; tint?: RGBA } | null {
    const u = (this.def as { ui?: Record<string, Record<string, string>> }).ui; const m = u?.[light ? 'light' : 'dark'] ?? u?.dark; if (!m) return null;
    const one = (k: string): RGBA | undefined => (typeof m[k] === 'string' ? hex(m[k]) ?? undefined : undefined);
    return { accent: one('accent'), accent2: one('accent2'), tint: one('tint') };
  }
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
  /** The camera: a shift −1…1 each way (× each layer's parallax), a zoom 1–1.5. */
  camera(px: number, py: number, zoom: number): void { this.call(() => this.ex.scene_camera(this.h, px, py, zoom)); }
  /** How much the pointer and clicks move things: 0 off, 1 subtle, 2.2 lively. */
  react(k: number): void { this.call(() => this.ex.scene_param(this.h, PARAM_REACT, k)); }
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
    // (The veil's colour: the scene's own deepest colour in dark — its lightest in light — so a veiled panel keeps the
    //  scene's hue instead of turning grey; the theme's ground when that colour would not carry the text.)
    const ext = pal.reduce((a, c) => ((t.light ? lum(c) > lum(a) : lum(c) < lum(a)) ? c : a), t.ground);
    this.veil = t.texts.every((tx) => contrast(tx, ext) >= PANEL_TARGET + 1) ? [ext[0], ext[1], ext[2], 1] : t.ground;
    this.call(() => { pal.forEach((c, i) => this.ex.scene_palette(this.h, i, pack(c))); });
    // (The particles' colours: a role must show — at least 2:1 against the ground —, and nothing may stand out more
    //  than the text does: the peak cap. In light, particles lighter than the ground get a faint cool rim.)
    const on = t.texts[0] ?? (t.light ? [24, 27, 35, 1] : [228, 228, 230, 1]); const cap = contrast(on, t.ground) * 0.85;
    this.spriteCol = pal.map((c0, i) => {
      let c: RGBA = [c0[0], c0[1], c0[2], 1];
      if (specs[i]?.role) for (let k = 0; k < 20 && contrast(c, t.ground) < 2; k++) c = mix(c, on, 0.08);
      for (let k = 0; k < 40 && contrast(c, t.ground) > cap; k++) c = mix(c, t.ground, 0.05);
      return c;
    });
    this.edge = t.light ? [92, 112, 150, 1] : null;
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
    if (!s) {
      const c = this.spriteCol[ci] ?? this.spriteCol[0] ?? [128, 128, 128, 1];
      // (The rim only for what is lighter than the ground: snow on a pale sky.)
      const edge = this.edge && this.theme && lum(c) > lum(this.theme.ground) - 0.02 ? this.edge : null;
      s = sprite(id, c, edge); this.sprites.set(k, s);
    }
    return s;
  }
  /** The static layers drawn into canvases: runs of consecutive ones with the same parallax into one, at the frame's
   *  transform. A clean copy is kept: the scrim is laid over a copy of it, so it can be made again (the page's text
   *  moved) without drawing the art again. */
  private buildStatics(cmds: Float32Array, base: number, n: number, k: number): void {
    const L = this.L; const groups: { first: number; last: number; scale: number; tx: number; ty: number; par: number }[] = [];
    this.wide = false; for (let i = 0; i < n; i++) { const kd = cmds[base + i * L.CS + L.KIND] | 0; if (cmds[base + i * L.CS + L.KNOWN] && kd >= 9 && kd <= 11) this.wide = true; }
    for (let i = 0; i < n; i++) {
      const o = base + i * L.CS; if (!cmds[o + L.STATIC] || !cmds[o + L.KNOWN]) continue;
      const [s, tx, ty, bl, par] = [cmds[o + L.SCALE], cmds[o + L.TX], cmds[o + L.TY], cmds[o + L.BLEND], cmds[o + 4]];
      const g = groups[groups.length - 1];
      if (g && g.last === i - 1 && Math.abs(g.par - par) < 1e-4 && !bl) g.last = i; else groups.push({ first: i, last: i, scale: s, tx, ty, par });
    }
    const { w: SW, h: SH, ov } = this.space; const bnd: Bounds = { x0: -SW * ov, y0: -SH * ov, x1: SW * (1 + ov), y1: SH * (1 + ov), w: SW, h: SH };
    const out: StaticGroup[] = [];
    for (const gr of groups) {
      const S = gr.scale * k; const bx = Math.floor((bnd.x0 * gr.scale + gr.tx) * k), by = Math.floor((bnd.y0 * gr.scale + gr.ty) * k);
      const W = Math.min(4096, Math.ceil((bnd.x1 - bnd.x0) * S) + 2), H = Math.min(4096, Math.ceil((bnd.y1 - bnd.y0) * S) + 2);
      const [clean, g] = mk(W, H); if (!g) continue;
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
      const [cv] = mk(W, H);
      out.push({ first: gr.first, clean, cv, bx, by, scale: gr.scale, tx: gr.tx, ty: gr.ty });
    }
    this.statics = out; this.needBake = true;
  }
  /** The contrast rule, from the static layers' local mean (cells of about two text heights; the particles left out):
   *  - PANELS: each panel its own veil — the least share of the ground laid over its tint that keeps every text role
   *    at 5.3:1 over the worst cell under that panel (at most PANEL_MAX: glass stays glass) — given to the page
   *    (`onScrim`), which puts it on that panel; cards over a dark sky stay clear;
   *  - BARE TEXT (no panel under it): a halo first (the page gives such text a soft text-shadow in the ground colour,
   *    counted as HALO), then, only as far as still needed for 5:1, a soft dimming of the art under it — a feathered
   *    shape of the text block, no edge — laid into the static canvases. With no page (a preview), everything is bare. */
  private bake(cw: number, ch: number, k: number, frame?: HTMLCanvasElement): void {
    this.needBake = false;
    const t = this.theme; if (!t || !this.statics.length) { this.scrimMax = 0; this.panelScrim = 0; return; }
    for (const s of this.statics) { const g = s.cv.getContext('2d'); if (!g) continue; g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'copy'; g.drawImage(s.clean, 0, 0); g.globalCompositeOperation = 'source-over'; }
    const GW = Math.max(4, Math.round(cw / 20)), GH = Math.max(3, Math.round(ch / 20));
    const [, mg] = mk(GW, GH); if (!mg) return;
    mg.fillStyle = this.groundCss; mg.fillRect(0, 0, GW, GH); mg.imageSmoothingQuality = 'high';
    for (const st of this.statics) mg.drawImage(st.clean, st.bx * GW / cw, st.by * GH / ch, st.clean.width * GW / cw, st.clean.height * GH / ch);
    const d = mg.getImageData(0, 0, GW, GH).data;
    // (Scenes with large moving layers — aurora curtains, a mirrored lake —: the frame just drawn is measured too, each
    //  cell taking the worse of the two and of its neighbours above and below — the curtains sway.)
    let fd: Uint8ClampedArray | null = null;
    if (frame) { mg.drawImage(frame, 0, 0, frame.width, frame.height, 0, 0, GW, GH); fd = mg.getImageData(0, 0, GW, GH).data; }
    const far = (c: RGBA): number => Math.abs(lum(c) - lum(this.veil));
    const at = (src: Uint8ClampedArray, x: number, y: number): RGBA => { const i = (Math.min(GH - 1, Math.max(0, y)) * GW + Math.min(GW - 1, Math.max(0, x))) * 4; return [src[i], src[i + 1], src[i + 2], 1]; };
    const cell = (x: number, y: number): RGBA => {
      let c = at(d, x, y); if (!fd) return c;
      for (const dy of [-1, 0, 1]) { const e = at(fd, x, y + dy); if (far(e) > far(c)) c = e; }
      return c;
    };
    const texts = t.texts.length ? t.texts : [[128, 128, 128, 1] as RGBA];
    const least = (ok: (x: number) => boolean): number => { if (ok(0)) return 0; let lo = 0, hi = 1; for (let it = 0; it < 12; it++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; } return hi; };
    const cx = GW / cw * k, cy = GH / ch * k;
    const cellsOf = (r: { x: number; y: number; w: number; h: number }): RGBA[] => { const out: RGBA[] = []; const x0 = Math.floor(r.x * cx), x1 = Math.floor((r.x + r.w) * cx), y0 = Math.floor(r.y * cy), y1 = Math.floor((r.y + r.h) * cy); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < GW && y < GH) out.push(cell(x, y)); return out; };
    const dom = this.dom ? this.dom() : null;
    // (Panels: each its own veil over its own tint.)
    const panels = (dom?.panels ?? []).map((p) => {
      const pt = p.tint; let need = 0;
      const cs = p.text?.length ? p.text.flatMap(cellsOf) : cellsOf(p);
      for (const c of cs) need = Math.max(need, least((s) => { const u = over(pt, c); const b = mix(u, this.veil, s); return texts.every((tx) => contrast(tx, b) >= PANEL_TARGET); }));
      return Math.min(PANEL_MAX, need);
    });
    this.panelScrim = panels.reduce((a, b) => Math.max(a, b), 0);
    // (Bare text: the halo counted, then a feathered dimming where it is still short.)
    const bare = dom ? dom.bare : [{ x: 0, y: 0, w: cw / k, h: ch / k }];
    const dims: { x: number; y: number; w: number; h: number; a: number }[] = [];
    for (const r of bare) {
      const cs = cellsOf(r); if (!cs.length) continue; const mean: RGBA = [0, 0, 0, 1];
      for (const c of cs) for (let j = 0; j < 3; j++) mean[j] += c[j] / cs.length;
      const worst = cs.reduce((a, c) => (Math.abs(lum(c) - lum(this.veil)) > Math.abs(lum(a) - lum(this.veil)) ? c : a), mean);
      const need = least((x) => { const b = mix(mix(worst, this.veil, x), this.veil, dom ? HALO : 0); return texts.every((tx) => contrast(tx, b) >= BARE_TARGET); });
      if (need > 0) dims.push({ ...r, a: need });
    }
    this.scrimMax = dims.reduce((a, b) => Math.max(a, b.a), 0);
    if (dims.length) {
      // (Feathered: each block drawn only as its shadow — blurred by about two text heights —, the block grown by the
      //  blur so its core still covers the text fully; no edge anywhere.)
      const blur = 26 * k; const [mp, mpg] = mk(cw, ch);
      if (mpg) {
        const off = cw + ch + 100;
        for (const r of dims) {
          mpg.shadowColor = css(this.veil, r.a); mpg.shadowBlur = blur; mpg.shadowOffsetX = off; mpg.fillStyle = '#000';
          const x = r.x * k - blur * 0.6, y = r.y * k - blur * 0.6, w = r.w * k + blur * 1.2, h = r.h * k + blur * 1.2;
          mpg.beginPath(); mpg.roundRect ? mpg.roundRect(x - off, y, w, h, blur) : mpg.rect(x - off, y, w, h); mpg.fill();
        }
        for (const s of this.statics) { const g = s.cv.getContext('2d'); if (!g) continue; g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-atop'; g.drawImage(mp, -s.bx, -s.by); g.restore(); }
      }
    }
    this.onScrim?.({ panels, max: this.panelScrim });
  }
  /** The scrim made again at the next frame (the page's text moved: another view, a scroll settled). */
  rebake(): void { this.needBake = true; }
  /** One frame on `g` (`w`×`h` device pixels, `k` of them a CSS pixel): the ground, then every layer in order. */
  render(g: CanvasRenderingContext2D, w: number, h: number, k: number): void {
    const t0 = performance.now();
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.fillStyle = this.groundCss; g.fillRect(0, 0, w, h);
    const L = this.L;
    const [f, u] = this.views();
    const pc = this.call(() => this.ex.scene_cmds(this.h)), n = this.call(() => this.ex.scene_ncmd(this.h)), pi = this.call(() => this.ex.scene_inst(this.h));
    if (pc && n > 0) {
      const cb = pc >>> 2, ib = pi >>> 2;
      if (!this.statics.length) this.buildStatics(f, cb, n, k);
      const after = this.needBake && this.wide; if (this.needBake && !after) this.bake(w, h, k);
      let si = 0; let stale = false;
      for (let c = 0; c < n; c++) {
        const o = cb + c * L.CS; if (!f[o + L.KNOWN]) continue;
        const kind = f[o + L.KIND] | 0;
        if (f[o + L.STATIC]) {
          const s = this.statics[si];
          if (s && s.first === c) {
            // (The camera moved it: blitted where the frame's transform puts it; a zoom past 4 % made again.)
            const r = f[o + L.SCALE] / s.scale; if (Math.abs(r - 1) > 0.04) stale = true;
            const { w: SW, h: SH, ov } = this.space; const x0 = -SW * ov, y0 = -SH * ov;
            const bx = (x0 * f[o + L.SCALE] + f[o + L.TX]) * k, by = (y0 * f[o + L.SCALE] + f[o + L.TY]) * k;
            g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
            if (Math.abs(r - 1) < 1e-4 && Math.abs(bx - s.bx) < 0.01 && Math.abs(by - s.by) < 0.01) g.drawImage(s.cv, s.bx, s.by); else g.drawImage(s.cv, bx, by, s.cv.width * r, s.cv.height * r);
            si++;
          }
          continue;
        }
        const S = f[o + L.SCALE], tx = f[o + L.TX], ty = f[o + L.TY]; const px = S * k;
        if (kind === 10 || kind === 11) { this.drawDynamic(g, kind, f[o + L.LAYER] | 0, f[o + L.GLEN] | 0, S, tx, ty, k, w, h, f[o + L.OPACITY]); continue; }
        const count = f[o + L.COUNT] | 0; if (!count || !pi) continue;
        if (kind === 9) { this.drawRibbon(g, f, u, ib, f[o + L.START] | 0, count, px, tx * k, ty * k, w, h, BLEND[f[o + L.BLEND] | 0] ?? 'source-over'); continue; }
        g.setTransform(px, 0, 0, px, tx * k, ty * k); g.globalCompositeOperation = BLEND[f[o + L.BLEND] | 0] ?? 'source-over';
        const start = f[o + L.START] | 0;
        for (let i = 0; i < count; i++) {
          const q = ib + (start + i) * L.IS; const sx = f[q + L.SX], sy = f[q + L.SY]; let a = f[q + L.ALPHA];
          if (!(sx * px >= 0.25) || !(a > 0.004)) continue;
          const sp = f[q + L.SPRITE] | 0;
          // (The peak cap: big soft particles at half alpha at most; fog puffs at a quarter.)
          if (sp === 4) { if (a > 0.25) a = 0.25; } else if (sp !== 11 && sx * S > 12 && a > 0.5) a = 0.5;
          const ci = this.palIndexOf(u[q + L.RGBA], f[q + L.COLOUR]);
          g.globalAlpha = a > 1 ? 1 : a;
          const rot = f[q + L.ROT];
          if (rot) { const x = f[q + L.X], y = f[q + L.Y]; const cs = Math.cos(rot), sn = Math.sin(rot); g.setTransform(px * cs, px * sn, -px * sn, px * cs, (x * S + tx) * k, (y * S + ty) * k); g.drawImage(this.sprite(sp, ci), -sx / 2, -sy / 2, sx, sy); g.setTransform(px, 0, 0, px, tx * k, ty * k); }
          else g.drawImage(this.sprite(sp, ci), f[q + L.X] - sx / 2, f[q + L.Y] - sy / 2, sx, sy);
        }
      }
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      if (after) this.bake(w, h, k, g.canvas as HTMLCanvasElement);
      if (stale) this.statics = [];
    }
    this.st.drawMs += performance.now() - t0; this.st.draws++;
  }
  /** The layers the page draws every frame from their geometry: the mirror (what is drawn so far, reflected below
   *  the waterline in rippling slices, tinted) and the settled snow. */
  private drawDynamic(g: CanvasRenderingContext2D, kind: number, layer: number, len: number, S: number, tx: number, ty: number, k: number, w: number, h: number, opacity: number): void {
    if (!len) return; const p = this.call(() => this.ex.scene_geom(this.h, layer)); if (!p) return;
    const geo = new Float32Array(this.views()[0].buffer, p, len);
    const t = (performance.now() - this.t0) / 1000;
    if (kind === 10) {
      const wy = Math.round((geo[0] * S + ty) * k); const below = h - wy; if (below <= 2 || wy <= 2) return;
      const ripple = geo[1] * S * k, alpha = geo[2] * opacity, tint = this.pal[geo[3] | 0] ?? this.theme?.ground ?? [0, 0, 0, 1], strength = geo[4];
      const H = Math.min(below, wy);
      // (Made at half size, and again only every other frame — a reflection is soft and slow —: the part above the
      //  line copied, then laid flipped in rippling slices into the reflection canvas; each frame blits that once.)
      const M = 2, mw = Math.ceil(w / M), mh = Math.max(1, Math.ceil(H / M));
      if (!this.mirrorCv || this.mirrorCv.width !== mw || this.mirrorCv.height !== mh) { [this.mirrorCv] = mk(mw, mh); [this.reflCv] = mk(mw, mh); this.reflAt = -1; }
      const mg = this.mirrorCv.getContext('2d'), rg = this.reflCv?.getContext('2d'); if (!mg || !rg || !this.reflCv) return;
      if (this.reflAt < 0 || this.st.draws - this.reflAt >= 2 || this.reflWy !== wy) {
        this.reflAt = this.st.draws; this.reflWy = wy;
        mg.setTransform(1, 0, 0, 1, 0, 0); mg.globalCompositeOperation = 'copy'; mg.imageSmoothingQuality = 'low'; mg.drawImage(g.canvas, 0, wy - H, w, H, 0, 0, mw, mh);
        rg.setTransform(1, 0, 0, 1, 0, 0); rg.clearRect(0, 0, mw, mh);
        const N = 16; const sh = Math.ceil(mh / N);
        for (let j = 0; j < N; j++) {
          const dy = j * sh; const off = ripple / M * Math.sin(t * 1.6 + j * 0.9) * (0.3 + j / N);
          // (Slice j below the line mirrors the slice j above it.)
          rg.setTransform(1, 0, 0, -1, off, dy + sh); rg.drawImage(this.mirrorCv, 0, mh - dy - sh, mw, sh, 0, 0, mw, sh);
        }
      }
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = alpha; g.globalCompositeOperation = 'source-over'; g.imageSmoothingQuality = 'low';
      g.drawImage(this.reflCv, 0, 0, mw, mh, 0, wy, mw * M, mh * M);
      const grd = g.createLinearGradient(0, wy, 0, h); grd.addColorStop(0, css(tint, strength * 0.6)); grd.addColorStop(1, css(tint, Math.min(1, strength * 1.6)));
      g.globalAlpha = 1; g.fillStyle = grd; g.fillRect(0, wy, w, below);
      g.fillStyle = css(mix(tint, [255, 255, 255, 1], 0.5), 0.18); g.fillRect(0, wy, w, Math.max(1, k));
    } else {
      const [top, bottom, ci, alpha, rough, seed] = [geo[0], geo[1], geo[2], geo[3], geo[4], geo[5]]; const c = this.pal[ci | 0] ?? [255, 255, 255, 1];
      let bumps = this.accumBumps.get(layer);
      if (!bumps) { bumps = new Float32Array(40); let s = (seed | 0) + 9; for (let i = 0; i < bumps.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; bumps[i] = s / 4294967296; } this.accumBumps.set(layer, bumps); }
      const { w: SW, ov } = this.space; const x0 = -SW * ov, x1 = SW * (1 + ov); const amp = (bottom - top) * rough * 0.5 + 2;
      g.setTransform(S * k, 0, 0, S * k, tx * k, ty * k); g.globalAlpha = alpha * opacity; g.globalCompositeOperation = 'source-over';
      const grd = g.createLinearGradient(0, top - amp, 0, bottom); grd.addColorStop(0, css(c)); grd.addColorStop(1, css(mix(c, this.theme?.ground ?? [0, 0, 0, 1], 0.25)));
      g.fillStyle = grd; g.beginPath(); g.moveTo(x0, bottom + 2);
      for (let i = 0; i < bumps.length; i++) { const x = x0 + (x1 - x0) * i / (bumps.length - 1); g.lineTo(x, top - amp * (0.4 + 0.6 * bumps[i])); }
      g.lineTo(x1, bottom + 2); g.closePath(); g.fill();
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
    }
  }
  /** Aurora curtains: soft and large, so drawn at a quarter of the canvas's size and laid on it scaled up — a
   *  sixteenth of the pixels to fill, the same look. */
  private drawRibbon(g: CanvasRenderingContext2D, f: Float32Array, u: Uint32Array, ib: number, start: number, count: number, px: number, ox: number, oy: number, w: number, h: number, blend: GlobalCompositeOperation): void {
    const R = 4, L = this.L; const rw = Math.max(1, Math.ceil(w / R)), rh = Math.max(1, Math.ceil(h / R));
    if (!this.ribCv || this.ribCv.width !== rw || this.ribCv.height !== rh) [this.ribCv] = mk(rw, rh);
    const rg = this.ribCv.getContext('2d'); if (!rg) return;
    rg.setTransform(1, 0, 0, 1, 0, 0); rg.globalAlpha = 1; rg.globalCompositeOperation = 'source-over'; rg.clearRect(0, 0, rw, rh);
    rg.setTransform(px / R, 0, 0, px / R, ox / R, oy / R); rg.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      const q = ib + (start + i) * L.IS; const sx = f[q + L.SX], sy = f[q + L.SY]; const a = f[q + L.ALPHA]; if (!(a > 0.004) || !(sx > 0)) continue;
      rg.globalAlpha = a > 1 ? 1 : a; rg.drawImage(this.sprite(f[q + L.SPRITE] | 0, this.palIndexOf(u[q + L.RGBA], f[q + L.COLOUR])), f[q + L.X] - sx / 2, f[q + L.Y] - sy / 2, sx, sy);
    }
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = blend; g.imageSmoothingQuality = 'low';
    g.drawImage(this.ribCv, 0, 0, rw * R, rh * R); g.globalCompositeOperation = 'source-over';
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
  private abandon(): void { if (this.dead) return; this.dead = true; this.sprites.clear(); this.statics = []; this.mirrorCv = this.reflCv = null; this.accumBumps.clear(); this.f32 = this.u32 = null; this.buf = null; live--; }
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
