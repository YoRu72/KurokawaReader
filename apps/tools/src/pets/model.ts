// The pet model every importer produces (our pet.json, a Shimeji pack, a folder of frames) and the runtime plays.
// Frames are numbered pictures kept beside it (pets/store.ts); an animation lists frame numbers. The app carries no pet
// and no artwork: a pack exists only once the user imported one himself.

export type PetState = 'idle' | 'walk' | 'sit' | 'sleep' | 'fall' | 'dragged' | 'thrown' | 'climb' | 'click';
export const STATES: PetState[] = ['idle', 'walk', 'sit', 'sleep', 'fall', 'dragged', 'thrown', 'climb', 'click'];
/** States the pet chooses by itself on a surface (the rest happen to it). */
export const CHOSEN: PetState[] = ['idle', 'walk', 'sit', 'sleep'];

export interface PetAnim {
  /** Frame numbers (0-based, into the pack's frames). */
  frames: number[];
  /** Frames a second, when `durations` is not given. */
  fps: number;
  /** Seconds each frame shows (Shimeji's poses), same length as `frames`. */
  durations?: number[];
  loop: boolean;
  /** Horizontal speed while this plays, in frame pixels a second (a walk); 0 or unset: the pet's own pace. */
  speed?: number;
  /** false: never drawn flipped (a picture that must keep its side); default true. */
  mirror?: boolean;
  /** Where the feet are in each frame (frame pixels), when they differ from the pack's anchor. */
  anchors?: [number, number][];
}
/** One step of something the pet does: an animation for a while (seconds, from min to max). */
export interface PetStep { anim: string; min: number; max: number }
/** One choice for a state: its steps, its weight among the others, and (Shimeji) a condition it needs. */
export interface PetChoice { steps: PetStep[]; weight: number; when?: string; name?: string }

export interface PetPack {
  v: 1;
  name: string;
  credit: string;
  licence: string;
  source: 'pet' | 'shimeji' | 'frames';
  /** The largest frame (pixels); frames may be smaller. */
  frameW: number; frameH: number;
  /** The feet: x, y in frame pixels (default: bottom centre). */
  anchor: [number, number];
  /** The pack's own scale (1 = its pixels as they are, before the user's size). */
  scale: number;
  /** Which way the pictures face (Shimeji's face left). */
  facing: 'left' | 'right';
  /** How many frames (pictures 0 … n-1). */
  frames: number;
  animations: Record<string, PetAnim>;
  states: Partial<Record<PetState, PetChoice[]>>;
  speech?: string[];
}

/* ---------- limits of what may be imported ---------- */
export const LIMITS = {
  files: 2000,
  totalBytes: 64 << 20,
  fileBytes: 8 << 20,
  framePx: 1024,
  /** One picture (a strip or sheet) before it is cut into frames. */
  sheetPx: 8192,
  frames: 600,
  /** All frames together, in pixels (a guard on memory). */
  totalPixels: 600 * 256 * 256,
  animations: 200,
  nameLen: 80,
  textLen: 4000,
  speech: 50,
};

/** A path inside a pack: forward slashes, no '..', no absolute or drive paths, no control characters, a sane length. */
export function safePath(p: string): string | null {
  if (typeof p !== 'string' || !p || p.length > 260) return null;
  const s = p.replace(/\\/g, '/');
  if (/^\/|^[a-zA-Z]:|[\u0000-\u001f\u007f]/.test(s)) return null;
  const parts = s.split('/').filter((x) => x !== '' && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || x.length > 120)) return null;
  return parts.join('/');
}
export type ImgKind = 'png' | 'webp' | 'gif';
/** The picture's kind by its first bytes (never by its name). */
export function imageKind(b: Uint8Array): ImgKind | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  return null;
}
/** Width and height from the picture's header (no decoding), or null. */
export function imageSize(b: Uint8Array): [number, number] | null {
  const k = imageKind(b); if (!k) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (k === 'png') return b.length >= 24 ? [dv.getUint32(16), dv.getUint32(20)] : null;
  if (k === 'gif') return [dv.getUint16(6, true), dv.getUint16(8, true)];
  // WebP: VP8 / VP8L / VP8X.
  if (b.length < 30) return null;
  const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (tag === 'VP8X') return [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))];
  if (tag === 'VP8L') { const v = dv.getUint32(21, true); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; }
  if (tag === 'VP8 ') return [dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff];
  return null;
}

/** Problems found while importing: what was skipped and why (shown to the user, never thrown). */
export interface ImportReport { skipped: string[]; notes: string[] }
export const newReport = (): ImportReport => ({ skipped: [], notes: [] });

/** A pack checked for consistency (frame numbers in range, animations named by states exist); throws on a fault. */
export function checkPack(p: PetPack): PetPack {
  const bad = (w: string): never => { throw new Error(`badPack:${w}`); };
  if (p.v !== 1) bad('version');
  if (!(p.frames > 0 && p.frames <= LIMITS.frames)) bad('frames');
  if (!(p.frameW > 0 && p.frameW <= LIMITS.framePx && p.frameH > 0 && p.frameH <= LIMITS.framePx)) bad('frameSize');
  if (!(p.scale > 0 && p.scale <= 8)) bad('scale');
  const names = Object.keys(p.animations); if (!names.length || names.length > LIMITS.animations) bad('animations');
  for (const [n, a] of Object.entries(p.animations)) {
    if (!a.frames.length || a.frames.some((f) => !Number.isInteger(f) || f < 0 || f >= p.frames)) bad(`anim:${n}`);
    if (!(a.fps > 0 && a.fps <= 60)) bad(`fps:${n}`);
    if (a.durations && (a.durations.length !== a.frames.length || a.durations.some((d) => !(d > 0 && d <= 60)))) bad(`durations:${n}`);
  }
  for (const [s, cs] of Object.entries(p.states)) for (const c of cs ?? []) for (const st of c.steps) if (!p.animations[st.anim]) bad(`state:${s}`);
  if (!p.states.idle?.length && !p.states.walk?.length) bad('noIdle');
  return p;
}

/** The names a converted condition may use (filled in by the runtime). */
export const COND_NAMES: ReadonlySet<string> = new Set([
  'onFloor', 'onCeiling', 'onWall', 'onWindowTop', 'onWindowBottom', 'onWindowSide', 'windowVisible', 'x', 'y', 'lookRight', 'count',
  ...['left', 'right', 'top', 'bottom', 'width', 'height'].flatMap((k) => [`area.${k}`, `screen.${k}`, `win.${k}`]), 'cursor.x', 'cursor.y',
]);
