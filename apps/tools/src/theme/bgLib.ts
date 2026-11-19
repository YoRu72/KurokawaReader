// The background library (a computer only; Settings → Appearance → «Your pictures and videos»): the reader's own
// pictures, moving pictures (GIF, APNG, animated WebP) and looping videos as the app's background. Each file is COPIED
// into the app's own storage (its IndexedDB, in the app's data folder) — never read again from where it was chosen, so
// moving or deleting the original breaks nothing — after its caps are checked from its header (a small file can claim a
// huge picture) and it is decoded once: a still re-encoded within a 3840×2400 box (its EXIF turn and colour profile
// baked in, its metadata dropped), a moving picture kept as it is (drawn frame by frame under the background's pause
// gate), a video kept as it is (played muted through a <video> element only). Its few colours are read once, here, from
// a small copy (a video: from four frames), for «Match the app's colours to the background».
// The list itself lives in the settings (animBgLib: cleaned on every read, never trusted; it travels in a backup, the
// files do not — a restored entry whose file is not here is shown as missing). Loaded on first use only.
import { db } from '../db';
import { getSettings, updateSettings } from '../settings';
import { sniffImage, imageSize, MAX_PIXELS } from '../anime/covers';
import type { RGBA } from './themes';

/* ---------- caps ---------- */
/** At most this many backgrounds, and this much stored for all of them. */
export const MAX_ITEMS = 40, MAX_TOTAL = 2048 * 1024 * 1024;
/** A picture: the file at most 50 MB, at most 40 megapixels (the custom covers' cap); kept within 3840×2400. */
export const PIC_MAX_IN = 50 * 1024 * 1024, PIC_BOX_W = 3840, PIC_BOX_H = 2400;
/** A moving picture: the file at most 40 MB, a frame at most 4.2 megapixels (and 4096 a side), at most 2000 frames. */
export const ANIM_MAX_IN = 40 * 1024 * 1024, ANIM_MAX_PX = 4_200_000, ANIM_MAX_FRAMES = 2000;
/** A video: the file at most 400 MB, at most 10 minutes (half a second at least), at most 3840×2160 (4096 a side). */
export const VID_MAX_IN = 400 * 1024 * 1024, VID_MAX_SEC = 600, VID_MAX_PX = 3840 * 2160, SIDE_MAX = 4096;
/** How long a file may take to show its size and first frame before it is refused as unreadable. */
const META_MS = 15_000;
export const NAME_MAX = 40;

export type Fit = 'cover' | 'contain' | 'fill' | 'center';
export type GlassLight = 'auto' | 'on' | 'off';
/** A colour role's choice: «auto» (from the picture, picked here), one of the picture's swatches («p0»…), or a colour. */
export type ColChoice = string;
export interface BgItem {
  id: string; name: string; kind: 'image' | 'anim' | 'video'; type: string;
  /** Bytes stored (the file and its small picture), its pixel size, a video's length (s), when it was added, where from. */
  bytes: number; w: number; h: number; dur?: number; at: number; from: 'file' | 'we';
  /** A moving picture kept still (this web view cannot draw its frames). */
  still?: boolean;
  fit: Fit; x: number; y: number; dim: number; blur: number; veil: number; light: GlassLight;
  /** The picture's colours (hex, the no-yellow rule already applied), most present first. */
  pal: string[];
  col: { accent: ColChoice; accent2: ColChoice; tint: ColChoice };
}
export const RANGE = { dim: [0, 0.8], blur: [0, 24], veil: [0, 0.9], pos: [0, 1] } as const;
export const DEFAULTS = { fit: 'cover' as Fit, x: 0.5, y: 0.5, dim: 0.15, blur: 0, veil: 0.2, light: 'auto' as GlassLight };
const ID_RE = /^[a-z0-9]{6,24}$/;
const HEX_RE = /^#[0-9a-f]{6}$/;
const TYPES = new Set(['image/webp', 'image/png', 'image/jpeg', 'image/gif', 'image/avif', 'image/bmp', 'video/mp4', 'video/webm', 'video/quicktime']);
const fileKey = (id: string) => `bglib:${id}`;
const thumbKey = (id: string) => `bglib:${id}:thumb`;
const clamp = (v: unknown, [lo, hi]: readonly [number, number], d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** A name made safe to show: control and direction marks out, spaces folded, at most 40 characters. */
export function cleanName(v: unknown): string {
  if (typeof v !== 'string') return '';
  return [...v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim();
}
const cleanCol = (v: unknown, n: number): ColChoice => {
  if (v === 'auto') return 'auto';
  if (typeof v === 'string' && /^p[0-9]$/.test(v) && Number(v.slice(1)) < n) return v;
  if (typeof v === 'string' && HEX_RE.test(v.toLowerCase())) return v.toLowerCase();
  return 'auto';
};
/** An entry from anywhere (the settings, a backup): a clean copy, or null when it is not one. */
export function cleanItem(v: unknown): BgItem | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  const name = cleanName(o.name); if (!name) return null;
  const kind = o.kind === 'image' || o.kind === 'anim' || o.kind === 'video' ? o.kind : null; if (!kind) return null;
  const type = typeof o.type === 'string' && TYPES.has(o.type) ? o.type : null; if (!type) return null;
  const num = (x: unknown, max: number): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(max, Math.round(x)) : 0);
  const pal = (Array.isArray(o.pal) ? o.pal : []).filter((x): x is string => typeof x === 'string' && HEX_RE.test(x.toLowerCase())).slice(0, 6).map((x) => x.toLowerCase());
  const c = (o.col && typeof o.col === 'object' ? o.col : {}) as Record<string, unknown>;
  const fit: Fit = o.fit === 'contain' || o.fit === 'fill' || o.fit === 'center' ? o.fit : 'cover';
  const light: GlassLight = o.light === 'on' || o.light === 'off' ? o.light : 'auto';
  const out: BgItem = {
    id: o.id, name, kind, type, bytes: num(o.bytes, MAX_TOTAL), w: num(o.w, 65535), h: num(o.h, 65535), at: num(o.at, 8.64e15), from: o.from === 'we' ? 'we' : 'file',
    fit, x: clamp(o.x, RANGE.pos, 0.5), y: clamp(o.y, RANGE.pos, 0.5), dim: clamp(o.dim, RANGE.dim, DEFAULTS.dim), blur: clamp(o.blur, RANGE.blur, 0), veil: clamp(o.veil, RANGE.veil, DEFAULTS.veil), light,
    pal, col: { accent: cleanCol(c.accent, pal.length), accent2: cleanCol(c.accent2, pal.length), tint: cleanCol(c.tint, pal.length) },
  };
  if (kind === 'video') out.dur = typeof o.dur === 'number' && Number.isFinite(o.dur) && o.dur > 0 ? Math.min(VID_MAX_SEC, o.dur) : 0;
  if (o.still === true && kind === 'image') out.still = true;
  return out;
}
/** The whole list, cleaned: at most MAX_ITEMS, ids unique, junk skipped. */
export function cleanItems(v: unknown): BgItem[] {
  if (!Array.isArray(v)) return [];
  const out: BgItem[] = []; const seen = new Set<string>();
  for (const x of v) { const it = cleanItem(x); if (it && !seen.has(it.id)) { seen.add(it.id); out.push(it); if (out.length >= MAX_ITEMS) break; } }
  return out;
}
export const libItems = (): BgItem[] => cleanItems(getSettings().animBgLib);
export const itemById = (id: string): BgItem | null => (id === '~draft' ? draft : libItems().find((x) => x.id === id) ?? null);
/** The controls sheet's draft (its preview draws it, as «user:~draft»). */
let draft: BgItem | null = null;
export function setDraft(it: BgItem | null): void { draft = it ? { ...it, col: { ...it.col }, pal: [...it.pal] } : null; }
export const storageUsed = (): number => libItems().reduce((a, x) => a + x.bytes, 0);
/** The stored file of an entry (the draft's: its own entry's). */
export async function itemFile(it: BgItem): Promise<Blob | null> { try { return (await db.getFile(fileKey(it.id))) ?? null; } catch { return null; } }

/* ---------- thumbnails (data: addresses: nothing to release) ---------- */
const thumbs = new Map<string, string>();
export async function thumbUrl(id: string): Promise<string> {
  const have = thumbs.get(id); if (have) return have;
  let b: Blob | undefined; try { b = await db.getFile(thumbKey(id)); } catch { b = undefined; }
  if (!b) return '';
  const url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(typeof r.result === 'string' ? r.result : ''); r.onerror = () => res(''); r.readAsDataURL(b!); });
  if (url) { if (thumbs.size > 80) thumbs.clear(); thumbs.set(id, url); }
  return url;
}

/* ---------- colours ---------- */
const hexOf = (c: RGBA): string => '#' + [0, 1, 2].map((i) => Math.round(Math.max(0, Math.min(255, c[i]))).toString(16).padStart(2, '0')).join('');
export const parseHex = (s: string): RGBA => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 1];
function hsl(c: RGBA): [number, number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const l = (mx + mn) / 2; const d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1)); let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360;
  return [h, s, l];
}
function fromHsl(h: number, s: number, l: number): RGBA {
  const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255, 1];
}
/** The hues the app never shows (yellow, amber, gold, orange: 20°–85°). */
export const BANNED: readonly [number, number] = [20, 85];
/** A colour moved out of the banned hues to the nearest allowed neighbour — a rose red below, a green above — keeping
 *  its lightness and saturation; a colour with almost no hue stays (a neutral). */
export function shiftHue(c: RGBA): RGBA {
  const [h, s, l] = hsl(c); const chroma = (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255;
  if (chroma < 0.06 || h < BANNED[0] || h > BANNED[1]) return [c[0], c[1], c[2], 1];
  return fromHsl(h < (BANNED[0] + BANNED[1]) / 2 ? 352 : 95, s, l);
}
export const hueOf = (c: RGBA): number => hsl(c)[0];
const chromaOf = (c: RGBA): number => (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255;
/** A picture's few colours: a median cut of its pixels (a small copy's, the nearly transparent ones left out) into
 *  eight boxes, the near ones merged, most present first; at most six. */
export function quantise(px: Uint8ClampedArray, n = 6): { c: RGBA; pop: number }[] {
  const pts: number[][] = [];
  for (let i = 0; i + 3 < px.length; i += 4) if (px[i + 3] >= 128) pts.push([px[i], px[i + 1], px[i + 2]]);
  if (!pts.length) return [];
  let boxes: number[][][] = [pts];
  while (boxes.length < 8) {
    // (The box with the widest channel split at its median.)
    let bi = -1, ch = 0, width = -1;
    boxes.forEach((b, i) => { if (b.length < 2) return; for (let k = 0; k < 3; k++) { let lo = 255, hi = 0; for (const p of b) { if (p[k] < lo) lo = p[k]; if (p[k] > hi) hi = p[k]; } if (hi - lo > width) { width = hi - lo; bi = i; ch = k; } } });
    if (bi < 0 || width < 8) break;
    const b = boxes[bi].sort((a, z) => a[ch] - z[ch]); const mid = b.length >> 1;
    boxes = [...boxes.slice(0, bi), b.slice(0, mid), b.slice(mid), ...boxes.slice(bi + 1)];
  }
  const out: { c: RGBA; pop: number }[] = [];
  for (const b of boxes) { if (!b.length) continue; const m = [0, 0, 0]; for (const p of b) for (let k = 0; k < 3; k++) m[k] += p[k] / b.length; out.push({ c: [m[0], m[1], m[2], 1], pop: b.length / pts.length }); }
  out.sort((a, z) => z.pop - a.pop);
  const merged: { c: RGBA; pop: number }[] = [];
  for (const x of out) { const near = merged.find((y) => Math.hypot(y.c[0] - x.c[0], y.c[1] - x.c[1], y.c[2] - x.c[2]) < 28); if (near) near.pop += x.pop; else merged.push({ ...x }); }
  return merged.sort((a, z) => z.pop - a.pop).slice(0, n);
}
/** The swatches kept for an entry: quantised, then moved out of the banned hues. */
export const swatchesOf = (px: Uint8ClampedArray): string[] => quantise(px).map((q) => hexOf(shiftHue(q.c)));
/** The colours the app takes from a background: its own choices, or picked here — the accent the most vivid colour
 *  (by vividness and presence), the second accent the next one of another hue, the surface tint the most present; a
 *  picture with no vivid colour gives its most present one (a neutral). Always out of the banned hues; the contrast
 *  with the text is the page's (theme/animbg.ts draws an accent toward the text until it reads at 4.5:1). */
export function coloursOf(it: Pick<BgItem, 'pal' | 'col'>): { accent?: RGBA; accent2?: RGBA; tint?: RGBA } | null {
  const pal = it.pal.map(parseHex); if (!pal.length && Object.values(it.col).every((c) => c === 'auto')) return null;
  const score = (c: RGBA, i: number) => chromaOf(c) * (0.35 + Math.sqrt(Math.max(0.02, 1 - i * 0.15)));
  const vivid = pal.map((c, i) => ({ c, s: score(c, i) })).filter((x) => chromaOf(x.c) >= 0.12).sort((a, z) => z.s - a.s);
  const autoAccent = vivid[0]?.c ?? pal[0];
  const autoA2 = vivid.find((x) => autoAccent && Math.min(Math.abs(hueOf(x.c) - hueOf(autoAccent)), 360 - Math.abs(hueOf(x.c) - hueOf(autoAccent))) >= 30)?.c ?? autoAccent;
  const pick = (ch: ColChoice, auto: RGBA | undefined): RGBA | undefined => {
    if (ch.startsWith('#')) return shiftHue(parseHex(ch));
    if (ch.startsWith('p')) { const c = pal[Number(ch.slice(1))]; return c ? shiftHue(c) : auto && shiftHue(auto); }
    return auto && shiftHue(auto);
  };
  const out = { accent: pick(it.col.accent, autoAccent), accent2: pick(it.col.accent2, autoA2), tint: pick(it.col.tint, pal[0]) };
  return out.accent ? out : null;
}

/* ---------- adding ---------- */
export type BgFault = 'notMedia' | 'tooLarge' | 'tooBig' | 'tooLong' | 'tooShort' | 'decode' | 'store' | 'full' | 'total';
/** A file refused, with why (the views say it in the reader's language, with the cap). */
export class BgError extends Error { constructor(public fault: BgFault) { super(fault); } }
const encode = (cv: HTMLCanvasElement, type: string, q = 0.9): Promise<Blob | null> => new Promise((res) => cv.toBlob(res, type, q));
/** A video's container from its first bytes: MP4/MOV (ftyp) or WebM/Matroska (EBML). */
export function sniffVideo(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(4, 0x66, 0x74, 0x79, 0x70)) { const brand = String.fromCharCode(b[8], b[9], b[10], b[11]); if (/^(avif|avis)$/.test(brand)) return null; return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4'; }
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
  return null;
}
const mk = (w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); const g = c.getContext('2d', { willReadFrequently: true }); if (!g) throw new BgError('decode'); return [c, g]; };
/** A small copy's pixels (48×48 at most, its shape kept), for the colours. */
function sample(src: CanvasImageSource, w: number, h: number, into?: number[]): number[] {
  const k = Math.min(1, 48 / Math.max(w, h)); const [, g] = mk(w * k, h * k); g.drawImage(src, 0, 0, g.canvas.width, g.canvas.height);
  const d = g.getImageData(0, 0, g.canvas.width, g.canvas.height).data; const out = into ?? []; for (let i = 0; i < d.length; i++) out.push(d[i]); return out;
}
/** The picture's small copy for the picker (320×200, the middle of it), WebP or PNG. */
async function thumbOf(src: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const [c, g] = mk(320, 200); const s = Math.max(320 / w, 200 / h); const dw = w * s, dh = h * s;
  g.fillStyle = '#20232a'; g.fillRect(0, 0, 320, 200); g.imageSmoothingQuality = 'high'; g.drawImage(src, (320 - dw) / 2, (200 - dh) / 2, dw, dh);
  let b = await encode(c, 'image/webp', 0.82); if (!b || b.type !== 'image/webp') b = await encode(c, 'image/png');
  if (!b) throw new BgError('decode'); return b;
}
interface Prepared { kind: BgItem['kind']; type: string; file: Blob; thumb: Blob; w: number; h: number; dur?: number; pal: string[]; still?: boolean }
type Decoder = { tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number; animated?: boolean } }; decode(o: { frameIndex: number }): Promise<{ image: VideoFrame }>; close(): void };
type DecoderCtor = new (o: { data: Uint8Array | ReadableStream | Blob | ArrayBuffer; type: string }) => Decoder;
/** The web view's own frame decoder for moving pictures (Chromium's ImageDecoder), where it has one. */
export const imageDecoder = (): DecoderCtor | null => (window as unknown as { ImageDecoder?: DecoderCtor }).ImageDecoder ?? null;
/** A picture checked and made ready to keep. */
async function preparePicture(bytes: Uint8Array, type: string): Promise<Prepared> {
  const dim = imageSize(bytes);
  if (dim && (dim.w * dim.h > MAX_PIXELS || !dim.w || !dim.h)) throw new BgError('tooBig');
  // (A moving picture: kept as it is, when this web view can draw its frames.)
  const Dec = imageDecoder();
  if ((type === 'image/gif' || type === 'image/png' || type === 'image/webp') && Dec) {
    let dec: Decoder | null = null;
    try {
      dec = new Dec({ data: bytes, type }); await withTimeout(dec.tracks.ready, META_MS);
      const n = dec.tracks.selectedTrack?.frameCount ?? 1;
      if (n > 1) {
        if (bytes.length > ANIM_MAX_IN) throw new BgError('tooLarge');
        if (n > ANIM_MAX_FRAMES) throw new BgError('tooLong');
        const { image } = await withTimeout(dec.decode({ frameIndex: 0 }), META_MS);
        try {
          const w = image.displayWidth, h = image.displayHeight;
          if (w * h > ANIM_MAX_PX || w > SIDE_MAX || h > SIDE_MAX) throw new BgError('tooBig');
          return { kind: 'anim', type, file: new Blob([bytes as BlobPart], { type }), thumb: await thumbOf(image, w, h), w, h, pal: swatchesOf(new Uint8ClampedArray(sample(image, w, h))) };
        } finally { image.close(); }
      }
    } catch (e) { if (e instanceof BgError) throw e; /* not readable as frames: a still below */ } finally { try { dec?.close(); } catch { /* closed */ } }
  }
  if (bytes.length > PIC_MAX_IN) throw new BgError('tooLarge');
  let bmp: ImageBitmap; try { bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type })); } catch { throw new BgError('decode'); }
  try {
    if (bmp.width * bmp.height > MAX_PIXELS) throw new BgError('tooBig');
    const k = Math.min(1, PIC_BOX_W / bmp.width, PIC_BOX_H / bmp.height); const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const [cv, g] = mk(w, h); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h);
    let file = await encode(cv, 'image/webp', 0.92); if (!file || file.type !== 'image/webp') file = await encode(cv, 'image/png');
    if (!file) throw new BgError('decode');
    const anim = type === 'image/gif' || (type === 'image/webp' && /ANIM/.test(String.fromCharCode(...bytes.subarray(12, 40))));
    const out: Prepared = { kind: 'image', type: file.type, file, thumb: await thumbOf(cv, w, h), w, h, pal: swatchesOf(new Uint8ClampedArray(sample(cv, w, h))) };
    // (A GIF or animated WebP where this web view has no frame decoder: kept still, and the picker says so.)
    if (anim && !Dec) out.still = true;
    cv.width = cv.height = 0; return out;
  } finally { bmp.close(); }
}
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let tm = 0; return Promise.race([p.finally(() => clearTimeout(tm)), new Promise<T>((_, rej) => { tm = window.setTimeout(() => rej(new BgError('decode')), ms); })]);
}
/** One event of a media element awaited (or its error), within `ms`. */
function once(el: HTMLMediaElement, ev: string, ms: number): Promise<void> {
  return new Promise((res, rej) => {
    const done = (ok: boolean) => { clearTimeout(tm); el.removeEventListener(ev, onOk); el.removeEventListener('error', onErr); if (ok) res(); else rej(new BgError('decode')); };
    const onOk = () => done(true), onErr = () => done(false); const tm = window.setTimeout(() => done(false), ms);
    el.addEventListener(ev, onOk); el.addEventListener('error', onErr);
  });
}
/** A video checked (its size, length and first frames, through a <video> element, muted) and made ready to keep. */
async function prepareVideo(blob: Blob, type: string): Promise<Prepared> {
  if (blob.size > VID_MAX_IN) throw new BgError('tooLarge');
  const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.playsInline = true;
  const url = URL.createObjectURL(blob);
  try {
    v.src = url; await once(v, 'loadedmetadata', META_MS);
    // (A recorder's WebM says no length until it is sought far past its end.)
    if (!Number.isFinite(v.duration)) { const p = once(v, 'durationchange', META_MS); v.currentTime = 1e7; await p.catch(() => undefined); }
    const dur = v.duration, w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) throw new BgError('decode');
    if (w * h > VID_MAX_PX || w > SIDE_MAX || h > SIDE_MAX) throw new BgError('tooBig');
    if (!Number.isFinite(dur) || dur > VID_MAX_SEC) throw new BgError('tooLong');
    if (dur < 0.5) throw new BgError('tooShort');
    // (Four frames for the colours; the first of them for its small picture.)
    const px: number[] = []; let thumb: Blob | null = null;
    for (const f of [0.1, 0.35, 0.6, 0.85]) {
      const p = once(v, 'seeked', 6000); v.currentTime = Math.min(dur - 0.05, dur * f); await p;
      sample(v, w, h, px); if (!thumb) thumb = await thumbOf(v, w, h);
    }
    return { kind: 'video', type, file: blob.type === type ? blob : new Blob([blob], { type }), thumb: thumb!, w, h, dur, pal: swatchesOf(new Uint8ClampedArray(px)) };
  } finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }
}
let seq = 0;
const newId = (taken: string[]): string => { for (;;) { const id = `bg${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`.slice(0, 24); if (!taken.includes(id)) return id; } };
/** The base of a file's name, for its first name in the list. */
export const baseName = (n: string): string => cleanName(n.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ')) || 'Background';
/** A file (chosen on the computer, or read from a wallpaper's folder) checked, copied into the app's storage and added
 *  to the list. Throws BgError with why it was refused. */
export async function addFile(file: Blob, name: string, from: 'file' | 'we' = 'file'): Promise<BgItem> {
  const list = libItems(); if (list.length >= MAX_ITEMS) throw new BgError('full');
  if (file.size > VID_MAX_IN) throw new BgError('tooLarge');
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const vt = sniffVideo(head); const it = vt ? null : sniffImage(head);
  if (!vt && !it) throw new BgError('notMedia');
  if (!vt && file.size > PIC_MAX_IN) throw new BgError('tooLarge');
  const p = vt ? await prepareVideo(file, vt) : await preparePicture(new Uint8Array(await file.arrayBuffer()), it!);
  const bytes = p.file.size + p.thumb.size;
  if (storageUsed() + bytes > MAX_TOTAL) throw new BgError('total');
  const id = newId(list.map((x) => x.id));
  // (Its id first in the trash list: a quit between the files and the list leaves no file that nothing would remove.)
  adding.add(id); keepTrash([...trash(), id]);
  try { await db.putFile(fileKey(id), p.file); await db.putFile(thumbKey(id), p.thumb); }
  catch { adding.delete(id); await db.deleteFile(fileKey(id)).catch(() => undefined); await db.deleteFile(thumbKey(id)).catch(() => undefined); keepTrash(trash().filter((x) => x !== id)); throw new BgError('store'); }
  const item = cleanItem({ id, name: cleanName(name) || 'Background', kind: p.kind, type: p.type, bytes, w: p.w, h: p.h, dur: p.dur, at: Date.now(), from, still: p.still, ...DEFAULTS, pal: p.pal, col: { accent: 'auto', accent2: 'auto', tint: 'auto' } })!;
  // (The list written after the files: a crash between leaves a file no entry names, swept at the next open.)
  updateSettings({ animBgLib: [...libItems(), item] });
  adding.delete(id); keepTrash(trash().filter((x) => x !== id));
  return item;
}
/** An entry's settings changed (the controls sheet). */
export function saveItem(it: BgItem): void { const c = cleanItem(it); if (!c) return; updateSettings({ animBgLib: libItems().map((x) => (x.id === c.id ? c : x)) }); }
export function renameItem(id: string, name: string): boolean { const n = cleanName(name); if (!n) return false; updateSettings({ animBgLib: libItems().map((x) => (x.id === id ? { ...x, name: n } : x)) }); return true; }

/* ---------- deleting, with Undo ---------- */
// (An entry deleted leaves the list at once; its files stay until the Undo is no longer offered, then go. The ids
//  waiting are kept in localStorage — not the backup —, so a quit in between still has them removed at the next open.)
const TRASH = 'kt.cache.bgTrash';
const trash = (): string[] => { try { const v = JSON.parse(localStorage.getItem(TRASH) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && ID_RE.test(x)) : []; } catch { return []; } };
const keepTrash = (ids: string[]): void => { try { if (ids.length) localStorage.setItem(TRASH, JSON.stringify(ids)); else localStorage.removeItem(TRASH); } catch { /* full */ } };
const timers = new Map<string, number>();
const adding = new Set<string>();
/** An entry out of the list; its files removed after `undoMs` unless `restore` (returned) is called first. */
export function deleteItem(id: string, undoMs: number): { item: BgItem | null; restore: () => void } {
  const s = getSettings(); const list = libItems(); const item = list.find((x) => x.id === id) ?? null;
  if (!item) return { item: null, restore: () => undefined };
  const before = { animBgLib: s.animBgLib, animBg: s.animBg };
  const using = s.animBg === `scene:user:${id}`;
  keepTrash([...trash().filter((x) => x !== id), id]);
  updateSettings({ animBgLib: list.filter((x) => x.id !== id), ...(using ? { animBg: 'off' as const } : {}) });
  clearTimeout(timers.get(id)); timers.set(id, window.setTimeout(() => { timers.delete(id); void sweep(); }, undoMs + 500));
  return { item, restore: () => { clearTimeout(timers.get(id)); timers.delete(id); keepTrash(trash().filter((x) => x !== id)); updateSettings(before); } };
}
/** The files of entries deleted (and no longer offered back) removed. */
export async function sweep(): Promise<void> {
  const keep = new Set(libItems().map((x) => x.id)); const left: string[] = [];
  for (const id of trash()) {
    if (keep.has(id) || timers.has(id) || adding.has(id)) { if (!keep.has(id)) left.push(id); continue; }
    try { await db.deleteFile(fileKey(id)); await db.deleteFile(thumbKey(id)); thumbs.delete(id); } catch { left.push(id); }
  }
  keepTrash(left);
}
/** Everything waiting let go (the tests' leak check; nothing is lost: the trash list stays for the next open). */
export function dropTimers(): void { for (const t of timers.values()) clearTimeout(t); timers.clear(); }
