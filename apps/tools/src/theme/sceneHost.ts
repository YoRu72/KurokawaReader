// The scene engine's host (a computer's animated background «scene:…»): loads the Rust engine — public/scene/
// ktscene.wasm, built in CI from apps/tools/core/kt-scene and never committed —, hands it a scene file (theme/scenes/
// *.json, ktscene/1) and draws the instances it computes with Canvas2D: one pre-rendered soft sprite per palette colour,
// `drawImage`d at each instance's place, size and alpha. Fetched only when a scene is chosen (animbg.ts imports it on
// first use); when the engine cannot be loaded the caller falls back to «drift».
//
// The ABI and the instance layout are the crate's (core/kt-scene/src/abi.rs and drawlist.rs): 8 floats an instance —
// x, y, size, rotation, alpha, sprite, colour, depth —, CSS pixels of the viewport. The engine allocates everything
// when a scene loads; the views on its memory are taken again whenever `memory.buffer` changes all the same.
import type { RGBA } from './themes';
import motes from './scenes/motes.json';

/** The scenes this build has, by id. */
const SCENES: Record<string, unknown> = { motes };
export const SCENE_IDS = Object.keys(SCENES);

/** The instance layout (drawlist.rs): floats per instance and each field's place. */
const STRIDE = 8; const F_X = 0, F_Y = 1, F_SIZE = 2, F_ALPHA = 4, F_COLOUR = 6;
const ABI = 1;
const PARAM_SPEED = 0;

interface Exports {
  memory: WebAssembly.Memory;
  kt_abi(): number; kt_alloc(len: number): number; kt_free(ptr: number, len: number): void;
  scene_load(ptr: number, len: number, seed: number): number; scene_viewport(h: number, w: number, hh: number): number;
  scene_palette(h: number, role: number, rgba: number): number; scene_roles(h: number): number; scene_param(h: number, id: number, v: number): number;
  scene_step(h: number, dtMs: number): number; scene_substeps(h: number): number; scene_inst(h: number): number; scene_stride(): number;
  scene_hint(h: number, id: number): number; scene_live(h: number): number; scene_state_hash(h: number): number; scene_free(h: number): number;
}
const NEEDED = ['memory', 'kt_abi', 'kt_alloc', 'kt_free', 'scene_load', 'scene_viewport', 'scene_palette', 'scene_roles', 'scene_param', 'scene_step', 'scene_substeps', 'scene_inst', 'scene_stride', 'scene_hint', 'scene_live', 'scene_state_hash', 'scene_free'];

/** The engine, compiled and instantiated once a page (a failure is kept too: tried once). */
let engine: Promise<Exports> | null = null;
function loadEngine(): Promise<Exports> {
  if (engine) return engine;
  engine = (async () => {
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
    for (const k of NEEDED) if (!(k in ex)) throw new Error(`ktscene.wasm: no export ${k}`);
    if (ex.kt_abi() !== ABI || ex.scene_stride() !== STRIDE) throw new Error(`ktscene.wasm: ABI ${ex.kt_abi()}/${ex.scene_stride()}, expected ${ABI}/${STRIDE}`);
    return ex;
  })();
  return engine;
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

const rgbaCss = (c: RGBA, a = 1): string => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
/** The soft dot (sprite 0) in one colour: a radial fall-off on a small canvas, drawn scaled. */
function softDot(c: RGBA): HTMLCanvasElement {
  const n = 64; const cv = document.createElement('canvas'); cv.width = cv.height = n; const g = cv.getContext('2d'); if (!g) return cv;
  const grd = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  // (A soft core that holds its colour, then a smooth fall-off: a dot of a pixel or two still shows its tint.)
  for (let i = 0; i <= 8; i++) { const s = i / 8; const u = s < 0.3 ? 0 : (s - 0.3) / 0.7; const k = (1 - u) * (1 - u) * (1 + 2 * u) * (1 - u * 0.15); grd.addColorStop(s, rgbaCss(c, +Math.max(0, k).toFixed(4))); }
  g.fillStyle = grd; g.fillRect(0, 0, n, n); return cv;
}

export interface SceneStats { steps: number; stepMs: number; draws: number; drawMs: number; instances: number; live: number }

/** One scene in the engine, and how it is drawn. */
export class SceneRun {
  readonly fps: number; readonly resolution: number; readonly roles: string[];
  private sprites: HTMLCanvasElement[] = []; private f32: Float32Array | null = null; private buf: ArrayBuffer | null = null;
  private count = 0; private dead = false;
  private st = { steps: 0, stepMs: 0, draws: 0, drawMs: 0 };
  constructor(private ex: Exports, private h: number, roles: string[]) {
    this.roles = roles; live++;
    const fps = ex.scene_hint(h, 0), res = ex.scene_hint(h, 1);
    this.fps = fps >= 10 && fps <= 30 ? fps : 24; this.resolution = res >= 0.25 && res <= 1 ? res : 0.5;
  }
  /** The floats of the engine's memory, taken again when it has grown (a grown memory has a new buffer). */
  private view(): Float32Array {
    const b = this.ex.memory.buffer as ArrayBuffer;
    if (b !== this.buf || !this.f32) { this.buf = b; this.f32 = new Float32Array(b); }
    return this.f32;
  }
  viewport(w: number, h: number): void { if (!this.dead) this.ex.scene_viewport(this.h, w, h); }
  /** The theme's colour of each role, in the scene's role order: told to the engine, a sprite made for each. */
  setColours(cols: RGBA[]): void {
    if (this.dead) return;
    this.sprites = this.roles.map((_, i) => { const c = cols[i] ?? cols[0] ?? [128, 128, 128, 1]; this.ex.scene_palette(this.h, i, ((Math.round(c[0]) << 24) | (Math.round(c[1]) << 16) | (Math.round(c[2]) << 8) | 255) >>> 0); return softDot(c); });
  }
  /** 1 normal, 0.5 slower (Reduced), 0 stopped. */
  setSpeed(k: number): void { if (!this.dead) this.ex.scene_param(this.h, PARAM_SPEED, k); }
  /** Time passes (ms); true when anything moved (only then is a frame worth drawing). */
  step(dtMs: number): boolean {
    if (this.dead) return false;
    const t0 = performance.now(); const n = this.ex.scene_step(this.h, dtMs); this.st.stepMs += performance.now() - t0; this.st.steps++;
    this.count = n > 0 ? n : 0; return this.ex.scene_substeps(this.h) > 0;
  }
  /** The instances drawn on `g` (`w`×`h` device pixels, `k` of them a CSS pixel), over the ground. */
  render(g: CanvasRenderingContext2D, w: number, h: number, k: number, ground: RGBA): void {
    const t0 = performance.now();
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.fillStyle = rgbaCss(ground); g.fillRect(0, 0, w, h);
    if (!this.dead && this.count && this.sprites.length) {
      const p = this.ex.scene_inst(this.h);
      if (p) {
        const f = this.view(); const base = p >>> 2; const ns = this.sprites.length;
        for (let i = 0; i < this.count; i++) {
          const o = base + i * STRIDE; const s = f[o + F_SIZE] * k; const a = f[o + F_ALPHA];
          if (!(s >= 0.25) || !(a > 0.004)) continue;
          const spr = this.sprites[(f[o + F_COLOUR] | 0) % ns];
          g.globalAlpha = a > 1 ? 1 : a; g.drawImage(spr, f[o + F_X] * k - s / 2, f[o + F_Y] * k - s / 2, s, s);
        }
        g.globalAlpha = 1;
      }
    }
    this.st.drawMs += performance.now() - t0; this.st.draws++;
  }
  stats(): SceneStats { return { steps: this.st.steps, stepMs: this.st.steps ? this.st.stepMs / this.st.steps : 0, draws: this.st.draws, drawMs: this.st.draws ? this.st.drawMs / this.st.draws : 0, instances: this.count, live: this.dead ? 0 : this.ex.scene_live(this.h) }; }
  resetStats(): void { this.st = { steps: 0, stepMs: 0, draws: 0, drawMs: 0 }; }
  /** The state hash (tests: the same seed and steps give the same hash). */
  hash(): number { return this.dead ? 0 : this.ex.scene_state_hash(this.h) >>> 0; }
  free(): void { if (this.dead) return; this.dead = true; this.ex.scene_free(this.h); this.sprites = []; this.f32 = null; this.buf = null; live--; }
}

/** A built-in scene started in the engine (throws when the engine or the scene cannot be loaded). */
export async function openScene(id: string, seed: number): Promise<SceneRun> {
  const def = SCENES[id] as { palette?: { roles?: unknown } } | undefined; if (!def) throw new Error(`ktscene: no scene «${id}»`);
  const ex = await loadEngine();
  const h = loadInto(ex, JSON.stringify(def), seed); if (h <= 0) throw new Error(`ktscene: «${id}» refused (${h})`);
  const roles = Array.isArray(def.palette?.roles) ? (def.palette!.roles as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  return new SceneRun(ex, h, roles.length ? roles : ['primary']);
}

/** The wasm step for a scene of 4,096 particles (the perf gate's number): ms a step, averaged over `n` steps of 1/60 s. */
export async function bench4096(n = 240): Promise<{ stepMs: number; live: number }> {
  const ex = await loadEngine();
  const em = { max: 2048, rate: 300, prewarm: 1, initializers: [{ kind: 'lifetime', min: 8, max: 14 }, { kind: 'size', min: 2, max: 6 }, { kind: 'velocity', min: [-9, -9], max: [9, 9] }], operators: [{ kind: 'drift' }, { kind: 'gravity', y: -1 }, { kind: 'drag', k: 0.3 }, { kind: 'bounds' }, { kind: 'fade' }] };
  const h = loadInto(ex, JSON.stringify({ format: 'ktscene/1', emitters: [em, em] }), 1); if (h <= 0) throw new Error(`ktscene: bench refused (${h})`);
  try {
    ex.scene_viewport(h, 1920, 1080); ex.scene_step(h, 1000 / 60);
    const t0 = performance.now(); for (let i = 0; i < n; i++) ex.scene_step(h, 1000 / 60);
    return { stepMs: (performance.now() - t0) / n, live: ex.scene_live(h) };
  } finally { ex.scene_free(h); }
}
