// A show's own cover, chosen by the user — a picture from the device or one fetched once from an address — made
// small (at most 600×900, WebP or JPEG), kept in the app's IndexedDB beside the theme pictures (not in localStorage:
// only a few bytes a show there, to know which shows have one), and shown wherever that show's cover is drawn.
// The original stays in the show's data (and in what downloads and history keep): «Back to the original» only forgets
// the picture.
import { db } from '../db';
import { request } from '../http';

export interface CoverInfo { at: number; from: 'file' | 'url'; /** The site it came from (only its name: the address itself is not kept). */ host?: string; bytes: number; w: number; h: number }
export type CoverFault = 'badUrl' | 'notImage' | 'tooLarge' | 'tooBig' | 'http' | 'decode' | 'store';
/** A picture refused, with why (the views say it in the user's language). */
export class CoverError extends Error { constructor(public fault: CoverFault, public status = 0) { super(fault); } }

// (kt.cache: not in the settings backup — the pictures themselves are not either.)
const IDX = 'kt.cache.animeCovers';
const fileKey = (id: number) => `anime-cover:${id}`;
/** The largest picture taken in (a file or an address's answer), before it is made small. */
export const MAX_IN = 20 << 20;
/** The most pixels a picture may have (about 40 megapixels), read from its header before it is decoded. */
export const MAX_PIXELS = 40e6;
const BOX_W = 600, BOX_H = 900;
const urls = new Map<number, string>();
let readyP: Promise<void> | null = null;

export function coverIndex(): Record<string, CoverInfo> { try { return JSON.parse(localStorage.getItem(IDX) ?? '{}') as Record<string, CoverInfo>; } catch { return {}; } }
const keepIndex = (x: Record<string, CoverInfo>): boolean => { try { localStorage.setItem(IDX, JSON.stringify(x)); return true; } catch { return false; } };
/** The covers chosen, read once (a few small pictures) — awaited before shows are drawn. */
export function coversReady(): Promise<void> {
  // (A stuck IndexedDB waited for 1.5 s at most: the shows are drawn then, with the covers that came.)
  readyP ??= Promise.race([(async () => {
    await Promise.all(Object.keys(coverIndex()).map(async (k) => { const id = Number(k); try { const b = await db.getFile(fileKey(id)); if (b && !urls.has(id)) urls.set(id, URL.createObjectURL(b)); } catch { /* none */ } }));
  })(), new Promise<void>((r) => setTimeout(r, 1500))]);
  return readyP;
}
export const customCover = (id: number | undefined): string | undefined => (id ? urls.get(id) : undefined);
/** The cover to show: the user's own, else the show's. */
export const coverOf = (a: { id: number; cover?: string }): string | undefined => urls.get(a.id) ?? a.cover;
/** The same for what only knows the show's id and the cover it kept (history, downloads). */
export const coverFor = (id: number | undefined, kept?: string): string | undefined => (id ? urls.get(id) : undefined) ?? kept;

/** What a picture's first bytes say it is (the formats a web view draws; no SVG). */
export function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(0, 0x42, 0x4d)) return 'image/bmp';
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'image/avif';
  return null;
}
/** A picture's width and height from its header (PNG, JPEG, GIF, WebP, BMP), before anything is decoded. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const u16 = (i: number, le = false) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]); const u32 = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const t = sniffImage(b);
  if (t === 'image/png' && b.length >= 24) return { w: u32(16), h: u32(20) };
  if (t === 'image/gif' && b.length >= 10) return { w: u16(6, true), h: u16(8, true) };
  if (t === 'image/bmp' && b.length >= 26) { const dv = new DataView(b.buffer, b.byteOffset); return { w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)) }; }
  if (t === 'image/webp' && b.length >= 30) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8 ') return { w: u16(26, true) & 0x3fff, h: u16(28, true) & 0x3fff };
    if (kind === 'VP8L') { const x = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { w: (x & 0x3fff) + 1, h: ((x >>> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  if (t === 'image/jpeg') {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16(i + 7), h: u16(i + 5) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + u16(i + 2);
    }
  }
  return null;
}
const encode = (cv: HTMLCanvasElement, type: string): Promise<Blob | null> => new Promise((res) => cv.toBlob(res, type, 0.88));
/** The picture made small: fitted in 600×900 (never made larger), WebP where the web view writes it, else JPEG. */
async function shrink(bytes: Uint8Array): Promise<{ blob: Blob; w: number; h: number }> {
  const type = sniffImage(bytes); if (!type) throw new CoverError('notImage');
  // (Its size read from its header: a small file can claim a huge picture — refused before it is decoded.)
  const dim = imageSize(bytes); if (dim && dim.w * dim.h > MAX_PIXELS) throw new CoverError('tooBig');
  let bmp: ImageBitmap; try { bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type })); } catch { throw new CoverError('decode'); }
  try {
    const k = Math.min(1, BOX_W / bmp.width, BOX_H / bmp.height); const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const c = cv.getContext('2d'); if (!c) throw new CoverError('decode');
    c.imageSmoothingQuality = 'high'; c.drawImage(bmp, 0, 0, w, h);
    let blob = await encode(cv, 'image/webp'); if (!blob || blob.type !== 'image/webp') blob = await encode(cv, 'image/jpeg');
    if (!blob) throw new CoverError('decode');
    return { blob, w, h };
  } finally { bmp.close(); }
}
async function keep(id: number, bytes: Uint8Array, from: 'file' | 'url', host?: string): Promise<string> {
  if (bytes.length > MAX_IN) throw new CoverError('tooLarge');
  const { blob, w, h } = await shrink(bytes);
  const prev = coverIndex()[id];
  try { await db.putFile(fileKey(id), blob); } catch { throw new CoverError('store'); }
  // (The index not written — storage full —: the picture taken away again, no file left without its entry.)
  const idx = coverIndex(); idx[id] = { at: Date.now(), from, host, bytes: blob.size, w, h };
  if (!keepIndex(idx)) { if (!prev) await db.deleteFile(fileKey(id)).catch(() => undefined); throw new CoverError('store'); }
  const was = urls.get(id); const now = URL.createObjectURL(blob); urls.set(id, now);
  if (was) setTimeout(() => URL.revokeObjectURL(was), 4000);
  return now;
}
/** A picture chosen on the device (the system's picker on the phone, the file dialog on the computer). */
export async function setCoverFromFile(id: number, f: Blob): Promise<string> {
  if (f.size > MAX_IN) throw new CoverError('tooLarge');
  return keep(id, new Uint8Array(await f.arrayBuffer()), 'file');
}
/** A picture's address: fetched once, through the app's own way of reaching sites, and kept like a file. */
export async function setCoverFromUrl(id: number, raw: string): Promise<string> {
  const url = raw.trim(); let ok = false; try { const u = new URL(url); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch { ok = false; }
  if (!ok) throw new CoverError('badUrl');
  // (Its size asked first — a larger one is not fetched at all —; then fetched with a range that stops one byte past
  // the limit, so a server that does not say its size still cannot send more than that.)
  const head = await request(url, { method: 'HEAD', timeoutMs: 15000 }).catch(() => null);
  if (head && Number(head.headers['content-length']) > MAX_IN) throw new CoverError('tooLarge');
  if (head && head.status === 200) { const ct0 = (head.headers['content-type'] ?? '').toLowerCase(); if (ct0 && !/^(image\/|application\/octet-stream|binary\/)/.test(ct0)) throw new CoverError('notImage'); }
  const r = await request(url, { binary: true, timeoutMs: 30000, headers: { Range: `bytes=0-${MAX_IN}` } }).catch(() => { throw new CoverError('http'); });
  if (r.status !== 200 && r.status !== 206) throw new CoverError('http', r.status);
  const ct = (r.headers['content-type'] ?? '').toLowerCase();
  if (ct && !ct.startsWith('image/') && !ct.startsWith('application/octet-stream') && !ct.startsWith('binary/')) throw new CoverError('notImage');
  if (Number(r.headers['content-length']) > MAX_IN + 1 || r.body.length * 0.75 > MAX_IN) throw new CoverError('tooLarge');
  let bin: string; try { bin = atob(r.body); } catch { throw new CoverError('notImage'); }
  const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return keep(id, bytes, 'url', new URL(url).host);
}
/** Back to the show's own cover. */
export async function resetCover(id: number): Promise<void> {
  await db.deleteFile(fileKey(id)).catch(() => undefined);
  const idx = coverIndex(); delete idx[id]; keepIndex(idx);
  const was = urls.get(id); urls.delete(id); if (was) setTimeout(() => URL.revokeObjectURL(was), 4000);
}
