// The background MIXER (a computer's scenes): a ground (a sky gradient of its own, light and dark), one base scene
// (or none), and up to two overlays of moving particles — snow, snowflakes, rain, mist, petals, motes, stars, bubbles,
// frost on glass —, composed here into ONE ktscene/1 document that the engine loads like any built-in scene
// (sceneHost.ts openScene «mix:…»). Everything is drawn by what the engine has today: particles with its sprites
// (dots, crystals, streaks, rings, petals, glows, stars), fog puffs and gradient bands; nothing new in the engine.
//
// The particle budget is shared: the base keeps its own count, and the overlays scale down together so the whole never
// goes past MIX_BUDGET (the heaviest built-in scene is 1,190; the engine's own gate is 4,096). The engine's caps
// (layers, emitters, palette entries) are held too: an overlay that would pass one is left out.
//
// A saved mix is data the reader made — or a backup brought in —, so it is never trusted: `cleanMix` keeps only what it
// knows (ids by pattern, kinds and grounds from fixed lists, numbers clamped, names cut and stripped of control
// characters), at most MAX_OVERLAYS overlays and MAX_SAVED mixes.
// Loaded only with the scene host or the mixer sheet (never at the start).
import { getSettings } from '../settings';
import { baseScenes } from './sceneList';

export type OverlayKind = 'snow' | 'flakes' | 'rain' | 'mist' | 'petals' | 'motes' | 'stars' | 'bubbles' | 'frost';
export const OVERLAY_KINDS: OverlayKind[] = ['snow', 'flakes', 'rain', 'mist', 'frost', 'petals', 'motes', 'stars', 'bubbles'];
export type GroundId = 'scene' | 'frost' | 'night' | 'dusk' | 'teal' | 'ink';
export const GROUNDS: GroundId[] = ['scene', 'frost', 'night', 'dusk', 'teal', 'ink'];
export interface MixOverlay { kind: OverlayKind; amount: number; size: number }
export interface Mix { id: string; name: string; ground: GroundId; base: string; overlays: MixOverlay[]; wind: number }

/** The whole mix's particles at most (base and overlays together). */
export const MIX_BUDGET = 1600;
export const MAX_OVERLAYS = 2;
export const MAX_SAVED = 24;
export const NAME_MAX = 40;
/** The ranges every number is clamped to. */
export const RANGE = { amount: [0, 1], size: [0.5, 2], wind: [-1, 1] } as const;
/** The wind at ±1, in scene units a second (the engine's PARAM_WIND_X). */
export const WIND_UNITS = 70;
const CAPS = { layers: 32, emitters: 16, palette: 32 };

/* ---------- the ready-made presets ---------- */
/** Snowy and rainy presets: each must read in light and in dark (cold blues, violets, teals, whites; never yellow). */
export const PRESETS: Mix[] = [
  { id: 'cold-light', name: 'mixPColdLight', ground: 'frost', base: 'snowflakes', overlays: [{ kind: 'flakes', amount: 0.7, size: 1.2 }, { kind: 'snow', amount: 0.45, size: 0.8 }], wind: 0.1 },
  { id: 'night-snow', name: 'mixPNightSnow', ground: 'night', base: 'night-snowfall', overlays: [{ kind: 'flakes', amount: 0.35, size: 0.9 }], wind: -0.15 },
  { id: 'blizzard-dusk', name: 'mixPBlizzardDusk', ground: 'dusk', base: 'blizzard', overlays: [{ kind: 'flakes', amount: 0.6, size: 1 }, { kind: 'mist', amount: 0.6, size: 1.2 }], wind: 0.7 },
  { id: 'frosted-window', name: 'mixPFrosted', ground: 'frost', base: 'none', overlays: [{ kind: 'frost', amount: 0.85, size: 1 }, { kind: 'snow', amount: 0.6, size: 1 }], wind: 0.05 },
  { id: 'aurora-snow', name: 'mixPAuroraSnow', ground: 'night', base: 'aurora-lake', overlays: [{ kind: 'snow', amount: 0.6, size: 0.9 }, { kind: 'flakes', amount: 0.2, size: 0.8 }], wind: -0.1 },
  { id: 'first-snow', name: 'mixPFirstSnow', ground: 'scene', base: 'first-snow', overlays: [{ kind: 'flakes', amount: 0.3, size: 0.8 }, { kind: 'stars', amount: 0.5, size: 1 }], wind: 0 },
  { id: 'soft-rain', name: 'mixPSoftRain', ground: 'teal', base: 'rain', overlays: [{ kind: 'mist', amount: 0.55, size: 1.1 }], wind: -0.1 },
  { id: 'night-rain', name: 'mixPNightRain', ground: 'night', base: 'rain', overlays: [{ kind: 'rain', amount: 0.5, size: 1 }, { kind: 'mist', amount: 0.35, size: 1 }], wind: -0.3 },
];
/** Which presets are snowy and which rainy (the picker's groups). */
export const SNOWY = ['cold-light', 'night-snow', 'blizzard-dusk', 'frosted-window', 'aurora-snow', 'first-snow'];
export const RAINY = ['soft-rain', 'night-rain'];

/* ---------- cleaning what is stored ---------- */
const clamp = (v: unknown, [lo, hi]: readonly [number, number], d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const baseIds = (): Set<string> => new Set(baseScenes().map((s) => s.id));
/** A name as the reader may keep it: control and bidi-override characters out, spaces folded, at most NAME_MAX. */
export function cleanName(v: unknown): string {
  if (typeof v !== 'string') return '';
  return [...v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim();
}
/** A mix from anywhere (settings, a backup): a clean copy, or null when it is not one. */
export function cleanMix(v: unknown): Mix | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  const name = cleanName(o.name); if (!name) return null;
  const ground = GROUNDS.includes(o.ground as GroundId) ? (o.ground as GroundId) : 'scene';
  const base = typeof o.base === 'string' && (o.base === 'none' || baseIds().has(o.base)) ? o.base : 'none';
  const overlays: MixOverlay[] = [];
  if (Array.isArray(o.overlays)) for (const x of o.overlays.slice(0, 8)) {
    if (overlays.length >= MAX_OVERLAYS) break;
    const q = (x ?? {}) as Record<string, unknown>; if (!OVERLAY_KINDS.includes(q.kind as OverlayKind)) continue;
    overlays.push({ kind: q.kind as OverlayKind, amount: clamp(q.amount, RANGE.amount, 0.5), size: clamp(q.size, RANGE.size, 1) });
  }
  return { id: o.id, name, ground: base === 'none' && ground === 'scene' ? 'frost' : ground, base, overlays, wind: clamp(o.wind, RANGE.wind, 0) };
}
/** The saved mixes as stored (untrusted): the clean ones, ids unique, at most MAX_SAVED. */
export function cleanMixes(v: unknown): Mix[] {
  const out: Mix[] = []; const seen = new Set<string>();
  if (!Array.isArray(v)) return out;
  for (const x of v.slice(0, MAX_SAVED * 2)) { if (out.length >= MAX_SAVED) break; const m = cleanMix(x); if (m && !seen.has(m.id) && !PRESETS.some((p) => p.id === m.id)) { seen.add(m.id); out.push(m); } }
  return out;
}
export const savedMixes = (): Mix[] => cleanMixes(getSettings().animBgMixes);
/** A new id for a saved mix (not a preset's, not one in use). */
export function newMixId(taken: string[]): string {
  for (let i = 0; i < 50; i++) { const id = 'u' + Math.random().toString(36).slice(2, 9); if (!taken.includes(id) && ID_RE.test(id)) return id; }
  return 'u' + Date.now().toString(36);
}

/** The mixer sheet's work in progress, shown live by its preview (id «mix:~draft»). */
let draft: Mix | null = null;
export function setDraft(m: Mix | null): void { draft = m ? cleanMix({ ...m, id: 'draft', name: m.name || 'draft' }) : null; }
/** A mix by its id: a preset, a saved one, or the draft («~draft»). */
export function mixById(id: string): Mix | null {
  if (id === '~draft') return draft;
  return PRESETS.find((p) => p.id === id) ?? savedMixes().find((m) => m.id === id) ?? null;
}
/** What a thumbnail of a mix depends on (its picture is made again when the mix changes). */
export function mixKey(id: string): string { const m = mixById(id); return m ? JSON.stringify([m.ground, m.base, m.overlays, m.wind]) : ''; }

/* ---------- the grounds ---------- */
interface Col { dark: string; light: string }
/** Three sky stops (top, middle, bottom) and a soft glow, per mode; cold hues only. */
const GROUND: Record<Exclude<GroundId, 'scene'>, { stops: [Col, Col, Col]; glow: Col; ui: { dark: Record<string, string>; light: Record<string, string> } }> = {
  frost: { stops: [{ dark: '#0b1a2e', light: '#c4d8ef' }, { dark: '#123251', light: '#a2c0e4' }, { dark: '#1c4b73', light: '#7c9fcd' }], glow: { dark: '#5fb8e8', light: '#ffffff' },
    ui: { dark: { accent: '#8fd0ff', accent2: '#b0a6ff', tint: '#123251' }, light: { accent: '#1d5f96', accent2: '#5246a8', tint: '#c6daf0' } } },
  night: { stops: [{ dark: '#02040d', light: '#6d82b6' }, { dark: '#081230', light: '#8b9fcb' }, { dark: '#14254e', light: '#b3c2e2' }], glow: { dark: '#3a4fa8', light: '#ffffff' },
    ui: { dark: { accent: '#9fb8ff', accent2: '#c0a8ff', tint: '#0c1a3e' }, light: { accent: '#2f4f9e', accent2: '#5a44a8', tint: '#c8d2ec' } } },
  dusk: { stops: [{ dark: '#0d0a26', light: '#9d8fcf' }, { dark: '#2a2252', light: '#b8abdf' }, { dark: '#4a3d78', light: '#d6cdee' }], glow: { dark: '#a07ad8', light: '#ffffff' },
    ui: { dark: { accent: '#c0a8ff', accent2: '#8fc8ff', tint: '#2a2252' }, light: { accent: '#53409e', accent2: '#2f5f9a', tint: '#d6cfee' } } },
  teal: { stops: [{ dark: '#03141b', light: '#7fb6c2' }, { dark: '#07303a', light: '#a3cdd5' }, { dark: '#0e4c58', light: '#c6e2e6' }], glow: { dark: '#3fc0c8', light: '#ffffff' },
    ui: { dark: { accent: '#6fe0e0', accent2: '#9fb8ff', tint: '#07303a' }, light: { accent: '#0f6b73', accent2: '#3a55a0', tint: '#c0e2e5' } } },
  ink: { stops: [{ dark: '#05070d', light: '#95a3c6' }, { dark: '#0d121f', light: '#b2bed9' }, { dark: '#161e33', light: '#cfd7ea' }], glow: { dark: '#4b5f9a', light: '#ffffff' },
    ui: { dark: { accent: '#a8bcff', accent2: '#8fd6e8', tint: '#111829' }, light: { accent: '#34488e', accent2: '#1f6f86', tint: '#dde4f2' } } },
};

/* ---------- the overlays: palette, layers and emitters of each kind (at amount 1, size 1) ---------- */
type J = Record<string, unknown>;
interface Part { palette: J[]; layers: J[]; emitters: J[] }
const em = (id: string, layer: string, max: number, rate: number, inits: J[], ops: J[], extra: J = {}): J => ({ id, layer, max, rate, prewarm: 1, ...extra, initializers: inits, operators: ops });
const ini = (kind: string, min: number | number[], max: number | number[]): J => ({ kind, min, max });
const col = (...roles: string[]): J => ({ kind: 'colour', roles });
const spr = (id: number): J => ({ kind: 'sprite', id });
const WRAP = (m: number): J => ({ kind: 'bounds', mode: 'wrap', margin: m });
const FADE = (a: number, b = a): J => ({ kind: 'fade', in: a, out: b });
const PTR = (s: number, r: number): J => ({ kind: 'pointer', strength: s, radius: r });
const CLICK = (i: number, r: number): J => ({ kind: 'click', impulse: i, radius: r });
function overlayPart(kind: OverlayKind, p: string): Part {
  const c = (id: string, dark: string, light: string): J => ({ id: `${p}${id}`, dark, light });
  const r = (id: string): string => `${p}${id}`;
  switch (kind) {
    case 'snow': return {
      palette: [c('s1', '#eef5ff', '#ffffff'), c('s2', '#c8daf6', '#f3f8ff')],
      layers: [{ id: r('far'), depth: 0.3 }, { id: r('near'), depth: 0.85 }],
      emitters: [
        em(r('far'), r('far'), 300, 22, [ini('lifetime', 40, 70), ini('size', 2.2, 4), ini('alpha', 0.45, 0.85), ini('velocity', [-5, 16], [5, 30]), col(r('s1'), r('s2')), spr(1)], [{ kind: 'drift', scale: 0.004, speed: 0.06, strength: 5 }, { kind: 'drag', k: 0.1 }, WRAP(10), FADE(0.05)], { wind: 0.7 }),
        em(r('near'), r('near'), 90, 6, [ini('lifetime', 30, 50), ini('size', 6, 10), ini('alpha', 0.6, 0.95), ini('velocity', [-8, 34], [8, 52]), col(r('s1')), spr(0)], [{ kind: 'drift', scale: 0.003, speed: 0.06, strength: 8 }, { kind: 'drag', k: 0.1 }, PTR(-60, 180), CLICK(120, 240), WRAP(20), FADE(0.06)], { wind: 1 }),
      ] };
    case 'flakes': return {
      palette: [c('f1', '#f0f7ff', '#ffffff'), c('f2', '#c4dcff', '#5f86bd')],
      layers: [{ id: r('mid'), depth: 0.6 }, { id: r('near'), depth: 0.95 }],
      emitters: [
        em(r('mid'), r('mid'), 80, 6, [ini('lifetime', 40, 70), ini('size', 10, 16), ini('alpha', 0.65, 0.95), ini('velocity', [-6, 16], [6, 28]), ini('rotation', 0, 6.28), ini('spin', -0.5, 0.5), col(r('f1'), r('f2')), spr(6)], [{ kind: 'drift', scale: 0.003, speed: 0.05, strength: 6 }, { kind: 'drag', k: 0.1 }, PTR(-60, 180), CLICK(120, 240), WRAP(24), FADE(0.05)], { wind: 0.7 }),
        em(r('near'), r('near'), 16, 1.2, [ini('lifetime', 30, 50), ini('size', 24, 38), ini('alpha', 0.75, 1), ini('velocity', [-8, 24], [8, 40]), ini('rotation', 0, 6.28), ini('spin', -0.35, 0.35), col(r('f1')), spr(7)], [{ kind: 'drift', scale: 0.002, speed: 0.05, strength: 8 }, { kind: 'drag', k: 0.1 }, PTR(-80, 220), CLICK(160, 280), WRAP(40), FADE(0.08)], { wind: 1 }),
      ] };
    case 'rain': return {
      palette: [c('r1', '#a9c7e8', '#4f6a90'), c('r2', '#c9defa', '#3e5a80')],
      layers: [{ id: r('far'), depth: 0.3 }, { id: r('near'), depth: 0.85 }],
      emitters: [
        em(r('far'), r('far'), 240, 110, [ini('lifetime', 1.2, 2), ini('size', 9, 11), ini('stretch', 2.4, 3), ini('alpha', 0.22, 0.38), ini('velocity', [-50, 620], [-30, 700]), col(r('r1')), spr(2)], [{ kind: 'bounds', mode: 'kill', margin: 40 }], { align: true, wind: 0.4, shape: { kind: 'rect', x: -0.1, y: -0.1, w: 1.2, h: 0.6 } }),
        em(r('near'), r('near'), 70, 34, [ini('lifetime', 0.9, 1.4), ini('size', 13, 17), ini('stretch', 3, 3.8), ini('alpha', 0.3, 0.5), ini('velocity', [-70, 860], [-50, 960]), col(r('r2')), spr(2)], [{ kind: 'bounds', mode: 'kill', margin: 60 }], { align: true, wind: 0.6, shape: { kind: 'rect', x: -0.1, y: -0.15, w: 1.2, h: 0.6 } }),
      ] };
    case 'mist': return {
      palette: [c('m1', '#7f9cc4', '#ffffff')],
      layers: [
        { id: r('high'), kind: 'fog', depth: 0.2, params: { y: 0.34, h: 0.24, count: 9, size: 1000, speed: 40, alpha: 0.12, colour: r('m1') } },
        { id: r('low'), kind: 'fog', depth: 0.75, params: { y: 0.86, h: 0.18, count: 10, size: 1200, speed: 70, alpha: 0.16, colour: r('m1') } },
      ],
      emitters: [] };
    case 'frost': return { // frost on the glass: a pale rim, crystals gathered at the edges, a fine rime over all; nearly still
      palette: [c('g1', '#9cc8ec', '#ffffff'), c('g2', '#d6ecff', '#ffffff'), c('g3', '#5f95c8', '#e8f2fc')],
      layers: [
        { id: r('top'), kind: 'band', depth: 0.98, parallax: 0, params: { y0: 0, y1: 0.22, top: r('g3'), bottom: r('g3'), a0: 0.5, a1: 0 } },
        { id: r('bot'), kind: 'band', depth: 0.98, parallax: 0, params: { y0: 0.62, y1: 1, top: r('g3'), bottom: r('g1'), a0: 0, a1: 0.62 } },
        { id: r('rime'), depth: 0.97, parallax: 0 },
        { id: r('ice'), depth: 0.99, parallax: 0 },
      ],
      emitters: [
        em(r('rime'), r('rime'), 260, 4, [ini('lifetime', 50, 90), ini('size', 1.4, 2.8), ini('alpha', 0.25, 0.6), col(r('g2')), spr(1)], [{ kind: 'twinkle', speed: 0.12, depth: 0.4 }, FADE(0.2)], { wind: 0 }),
        // (Strips along the edges — bottom, top, both sides — then thicker clusters in the corners, larger crystals.)
        ...([[0, 0.82, 1, 0.2, 150, 18], [0, -0.02, 1, 0.1, 70, 14], [-0.02, 0, 0.08, 1, 60, 14], [0.94, 0, 0.08, 1, 60, 14], [0.8, -0.02, 0.22, 0.26, 90, 28], [0.76, 0.7, 0.26, 0.32, 120, 32], [-0.02, 0.7, 0.24, 0.32, 90, 28]] as const).map(([x, y, w, hh, n, big], i) =>
          em(r(`ice${i}`), r('ice'), n, n / 40, [ini('lifetime', 40, 80), ini('size', 8, big), ini('alpha', 0.55, 0.95), ini('velocity', [-0.3, -0.2], [0.3, 0.2]), ini('rotation', 0, 6.28), ini('spin', -0.02, 0.02), col(r('g2'), r('g1')), spr(5 + (i % 3))],
            [{ kind: 'twinkle', speed: 0.15, depth: 0.25 }, FADE(0.2)], { wind: 0, shape: { kind: 'rect', x, y, w, h: hh } })),
      ] };
    case 'petals': return {
      palette: [c('p1', '#f2bcd8', '#c45f98'), c('p2', '#cdb8ff', '#7f62c8')],
      layers: [{ id: r('mid'), depth: 0.6 }, { id: r('near'), depth: 0.92 }],
      emitters: [
        em(r('mid'), r('mid'), 40, 2, [ini('lifetime', 20, 34), ini('size', 12, 18), ini('alpha', 0.7, 0.95), ini('velocity', [16, 12], [32, 24]), ini('rotation', 0, 6.28), ini('spin', -1.4, 1.4), col(r('p1'), r('p2')), spr(8)], [{ kind: 'drift', scale: 0.003, speed: 0.1, strength: 20 }, { kind: 'drag', k: 0.2 }, PTR(-60, 200), WRAP(40), FADE(0.06)], { wind: 1 }),
        em(r('near'), r('near'), 10, 0.5, [ini('lifetime', 20, 30), ini('size', 22, 32), ini('alpha', 0.8, 1), ini('velocity', [24, 16], [44, 30]), ini('rotation', 0, 6.28), ini('spin', -1.6, 1.6), col(r('p1'), r('p2')), spr(8)], [{ kind: 'drift', scale: 0.002, speed: 0.1, strength: 26 }, { kind: 'drag', k: 0.2 }, PTR(-80, 240), CLICK(160, 300), WRAP(50), FADE(0.06)], { wind: 1 }),
      ] };
    case 'motes': return {
      palette: [c('o1', '#9fdcff', '#2f6fae'), c('o2', '#c4b4ff', '#5a46b8'), c('o3', '#8ff0e0', '#16857a')],
      layers: [{ id: r('mid'), depth: 0.5, opacity: 0.9 }],
      emitters: [em(r('mid'), r('mid'), 120, 9, [ini('lifetime', 9, 16), ini('size', 6, 12), ini('alpha', 0.5, 0.9), ini('velocity', [-5, -6], [5, 2]), col(r('o1'), r('o2'), r('o3')), spr(13)], [{ kind: 'drift', scale: 0.0028, speed: 0.045, strength: 8 }, { kind: 'gravity', x: 0, y: -1.2 }, { kind: 'drag', k: 0.4 }, PTR(-40, 140), WRAP(16), FADE(0.2, 0.3)], { wind: 0.3 })] };
    case 'stars': return {
      palette: [c('t1', '#ffffff', '#3f5f9a'), c('t2', '#bcd6ff', '#5a4cb0')],
      layers: [{ id: r('sky'), depth: 0.04, parallax: 0.03 }],
      emitters: [em(r('sky'), r('sky'), 140, 2, [ini('lifetime', 60, 120), ini('size', 1.6, 3.2), ini('alpha', 0.35, 0.85), col(r('t1'), r('t2')), spr(1)], [{ kind: 'twinkle', speed: 0.25, depth: 0.55 }, FADE(0.15)], { wind: 0, shape: { kind: 'rect', x: 0, y: 0, w: 1, h: 0.55 } })] };
    case 'bubbles': return {
      palette: [c('b1', '#9fe0f0', '#2f7f9c'), c('b2', '#bfd0ff', '#4a5fb0')],
      layers: [{ id: r('mid'), depth: 0.7 }],
      emitters: [em(r('mid'), r('mid'), 70, 5, [ini('lifetime', 8, 16), ini('size', 4, 12), ini('alpha', 0.45, 0.85), ini('velocity', [-6, -70], [6, -40]), col(r('b1'), r('b2')), spr(3)], [{ kind: 'drift', scale: 0.01, speed: 0.4, strength: 30 }, PTR(-70, 200), CLICK(140, 260), { kind: 'bounds', mode: 'kill', margin: 30 }, FADE(0.1)], { wind: 0.2, shape: { kind: 'rect', x: 0, y: 0.55, w: 1, h: 0.5 } })] };
  }
}

/* ---------- composing ---------- */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const emitMax = (e: J): number => (typeof e.max === 'number' && Number.isFinite(e.max) ? e.max : 0);
const EMPTY = (): J => ({ format: 'ktscene/1', meta: { id: 'mix', name: 'Mix' }, view: { fps: 24, resolution: 0.5 }, space: { w: 1600, h: 1000, overscan: 0.06, fit: 'cover' }, palette: [], params: [{ id: 'amount', type: 'slider', min: 0, max: 1, default: 1 }], layers: [], emitters: [] });
export interface Composed { def: J; wind: number; total: number; dropped: number; scale: number }
/** A mix as one ktscene/1 document (the base scene's file, its sky given the ground, the overlays added on top), the
 *  wind for the engine (units/s), the particles at most, the overlays left out (caps), the overlays' scale (budget). */
export function compose(m0: Mix, scenes: Record<string, unknown>): Composed {
  // (A mix not yet named — the mixer's work — composes all the same.)
  const m = cleanMix({ ...m0, id: ID_RE.test(String(m0?.id)) ? m0.id : 'draft', name: cleanName(m0?.name) || 'mix' }) ?? { id: 'x', name: 'x', ground: 'frost', base: 'none', overlays: [], wind: 0 } as Mix;
  const baseDef = m.base !== 'none' ? scenes[m.base] : null;
  const def: J = baseDef ? clone(baseDef as J) : EMPTY();
  const pal = (Array.isArray(def.palette) ? def.palette : (def.palette = [])) as unknown[];
  const layers = (Array.isArray(def.layers) ? def.layers : (def.layers = [])) as J[];
  const emitters = (Array.isArray(def.emitters) ? def.emitters : (def.emitters = [])) as J[];
  def.meta = { id: `mix-${m.id}`, name: m.name };
  // (The ground: the base's first sky given three stops and a glow of its own; with no sky, one put under everything.)
  const gid = m.ground === 'scene' ? (baseDef ? null : 'frost') : m.ground;
  if (gid && pal.length + 4 <= CAPS.palette) {
    const g = GROUND[gid];
    pal.push({ id: 'mixg0', ...g.stops[0] }, { id: 'mixg1', ...g.stops[1] }, { id: 'mixg2', ...g.stops[2] }, { id: 'mixglow', ...g.glow });
    const params = { stops: [[0, 'mixg0'], [0.55, 'mixg1'], [1, 'mixg2']], glow: { x: 0.5, y: -0.05, r: 0.9, colour: 'mixglow', alpha: 0.22 } };
    const sky = layers.find((l) => l.kind === 'sky');
    if (sky) sky.params = { ...(sky.params as J ?? {}), ...params }; else if (layers.length < CAPS.layers) layers.unshift({ id: 'mixsky', kind: 'sky', depth: 0, parallax: 0, params });
    if (!baseDef || !def.ui) def.ui = clone(g.ui);
  }
  // (The overlays: their parts, scaled by amount and size; then all of them scaled down together to the budget.)
  const baseTotal = emitters.reduce((a, e) => a + emitMax(e), 0);
  const parts: { part: Part; o: MixOverlay }[] = []; let dropped = 0;
  m.overlays.forEach((o, i) => {
    if (o.amount <= 0) return;
    const part = overlayPart(o.kind, `o${i + 1}`);
    for (const e of part.emitters) { e.max = emitMax(e) * o.amount; e.rate = (e.rate as number) * o.amount; for (const x of e.initializers as J[]) if (x.kind === 'size') { x.min = (x.min as number) * o.size; x.max = (x.max as number) * o.size; } }
    for (const l of part.layers) if (l.kind === 'fog') { const q = l.params as J; q.size = (q.size as number) * o.size; q.count = Math.max(1, Math.round((q.count as number) * (0.4 + 0.6 * o.amount))); q.alpha = (q.alpha as number) * (0.5 + 0.5 * o.amount); }
    parts.push({ part, o });
  });
  const want = parts.reduce((a, p) => a + p.part.emitters.reduce((b, e) => b + emitMax(e), 0), 0);
  const room = Math.max(0, MIX_BUDGET - baseTotal); const scale = want > room ? room / want : 1;
  for (const { part } of parts) {
    if (pal.length + part.palette.length > CAPS.palette || layers.length + part.layers.length > CAPS.layers || emitters.length + part.emitters.length > CAPS.emitters) { dropped++; continue; }
    const keep = part.emitters.map((e) => ({ ...e, max: Math.floor(emitMax(e) * scale), rate: Math.max(0.05, (e.rate as number) * scale) })).filter((e) => e.max >= 1);
    pal.push(...part.palette); layers.push(...part.layers); emitters.push(...keep);
  }
  const total = emitters.reduce((a, e) => a + emitMax(e), 0);
  return { def, wind: m.wind * WIND_UNITS, total, dropped, scale };
}
