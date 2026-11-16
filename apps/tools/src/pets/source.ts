// What every importer works from and gives back: the pack's files (a folder or a zip, read into memory, checked), and
// the frames to cut from them (a whole picture, a cell of a strip or sheet, a frame of a GIF). Pure: no DOM here,
// so the unit tests run it in Node.
import { safePath, imageKind, imageSize, LIMITS, type PetPack, type ImportReport } from './model';
import { gifInfo } from './gif';

export interface PackFile { path: string; bytes: Uint8Array }
export interface FrameSrc { file: string; cell?: [number, number, number, number]; gif?: number }
export interface ImportResult { pack: PetPack; frames: FrameSrc[]; report: ImportReport }
export interface PicInfo { w: number; h: number; kind: 'png' | 'webp' | 'gif'; gifFrames: number }

export class PackError extends Error {}

/** The files of a pack, each checked: a safe path, sizes within the limits; a common top folder (a zip's) taken off.
 *  Files that are not pictures, JSON, XML or text are left out and named in the report — no code is ever kept. */
export function cleanFiles(raw: PackFile[], report: ImportReport): PackFile[] {
  if (raw.length > LIMITS.files) throw new PackError('tooManyFiles');
  let total = 0; const out: PackFile[] = []; const seen = new Set<string>();
  for (const f of raw) {
    const p = safePath(f.path); if (!p) { report.skipped.push(`path: ${String(f.path).slice(0, 80)}`); continue; }
    if (/(^|\/)(__MACOSX|\.git)(\/|$)|(^|\/)\.DS_Store$|(^|\/)Thumbs\.db$/i.test(p)) continue;
    if (!/\.(png|webp|gif|json|xml|txt|md)$/i.test(p)) { report.skipped.push(`file: ${p}`); continue; }
    if (f.bytes.length > LIMITS.fileBytes) { report.skipped.push(`tooBig: ${p}`); continue; }
    total += f.bytes.length; if (total > LIMITS.totalBytes) throw new PackError('tooBig');
    const key = p.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
    out.push({ path: p, bytes: f.bytes });
  }
  // (One folder holding everything — a zip of a folder, perhaps in another —: its name taken off every path; not
  // Shimeji's own img/ or conf/.)
  for (let guard = 0; guard < 4 && out.length; guard++) {
    const tops = new Set(out.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')));
    if (tops.size !== 1 || tops.has('')) break;
    const top = [...tops][0]; if (/^(img|conf)$/i.test(top)) break;
    for (const f of out) f.path = f.path.slice(top.length + 1);
  }
  return out;
}

/** A picture's size and kind (from its header), or null when it is not a PNG, WebP or GIF within the limits. */
export function picInfo(f: PackFile): PicInfo | null {
  const kind = imageKind(f.bytes); if (!kind) return null;
  const sz = imageSize(f.bytes); if (!sz || !sz[0] || !sz[1] || sz[0] > LIMITS.sheetPx || sz[1] > LIMITS.sheetPx) return null;
  let gifFrames = 1;
  if (kind === 'gif') { try { const g = gifInfo(f.bytes, LIMITS.framePx); gifFrames = g.frames; } catch { return null; } }
  return { w: sz[0], h: sz[1], kind, gifFrames };
}

/** Frames and their sizes added up against the limits before anything is decoded: how many, their pixels, and the
 *  pixels decoding them takes (each picture once; a GIF's screen for every frame composed up to the last one used). */
export function checkFrameBudget(frames: FrameSrc[], info: (file: string) => PicInfo | null): void {
  if (frames.length > LIMITS.frames) throw new PackError('tooManyFrames');
  let px = 0; const work = new Map<string, number>();
  for (const fr of frames) {
    const i = info(fr.file); if (!i) throw new PackError('badPicture');
    const w = fr.cell ? fr.cell[2] : i.w, h = fr.cell ? fr.cell[3] : i.h;
    if (w > LIMITS.framePx || h > LIMITS.framePx || w < 1 || h < 1) throw new PackError('frameTooBig');
    if (fr.cell && (fr.cell[0] < 0 || fr.cell[1] < 0 || fr.cell[0] + w > i.w || fr.cell[1] + h > i.h)) throw new PackError('badCell');
    px += w * h; if (px > LIMITS.totalPixels) throw new PackError('tooManyPixels');
    const cost = fr.gif !== undefined ? (fr.gif + 1) * i.w * i.h : i.w * i.h;
    work.set(fr.file, Math.max(work.get(fr.file) ?? 0, cost));
  }
  let sum = 0; for (const v of work.values()) sum += v;
  if (sum > LIMITS.decodePixels) throw new PackError('tooManyPixels');
}
/** Text of a file (UTF-8, a BOM taken off). */
export const textOf = (f: PackFile): string => new TextDecoder('utf-8').decode(f.bytes).replace(/^﻿/, '');
/** A short string from a pack (names, credits): control characters out, trimmed, capped. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, max);
}
/** The frames listed once each (the same picture or cell used twice is one frame). */
export class FrameList {
  list: FrameSrc[] = []; private at = new Map<string, number>();
  add(f: FrameSrc): number { const k = `${f.file}|${f.cell?.join(',') ?? ''}|${f.gif ?? ''}`; let i = this.at.get(k); if (i === undefined) { i = this.list.length; this.list.push(f); this.at.set(k, i); } return i; }
}
