// A pack chosen by the user from his own files: a folder (the system's folder chooser) or a zip, read into memory
// within the limits (count, each file's size, the total) before anything is decoded; then its frames made into PNG
// pictures of their own (a strip's cells cut, a GIF's frames composed), ready for the library.
import { LIMITS, imageKind } from './model';
import { PackError, checkFrameBudget, picInfo, type FrameSrc, type PackFile } from './source';
import { GifDecoder } from './gif';

const WANTED = /\.(png|webp|gif|json|xml|txt|md)$/i;
function choose(o: { dir?: boolean; accept?: string }): Promise<File[] | null> {
  return new Promise((res) => {
    const f = document.createElement('input'); f.type = 'file'; f.style.display = 'none';
    if (o.dir) { f.setAttribute('webkitdirectory', ''); f.setAttribute('directory', ''); f.multiple = true; }
    if (o.accept) f.accept = o.accept;
    const done = (v: File[] | null) => { res(v); f.remove(); };
    f.addEventListener('change', () => done(f.files && f.files.length ? Array.from(f.files) : null));
    f.addEventListener('cancel', () => done(null));
    document.body.append(f); f.click();
  });
}
/** The files of a folder the user picks (null when the chooser was closed). */
export async function pickFolder(): Promise<PackFile[] | null> {
  const files = await choose({ dir: true }); if (!files) return null;
  return readFiles(files.map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f })));
}
/** A zip the user picks. */
export async function pickZip(): Promise<PackFile[] | null> {
  const files = await choose({ accept: '.zip,application/zip' }); if (!files?.[0]) return null;
  return readZip(files[0]);
}
export async function readFiles(list: { path: string; file: Blob }[]): Promise<PackFile[]> {
  const keep = list.filter((x) => WANTED.test(x.path));
  if (keep.length > LIMITS.files) throw new PackError('tooManyFiles');
  let total = 0; for (const x of keep) if (x.file.size <= LIMITS.fileBytes) total += x.file.size;
  if (total > LIMITS.totalBytes) throw new PackError('tooBig');
  const out: PackFile[] = [];
  for (const x of keep) { if (x.file.size > LIMITS.fileBytes) { out.push({ path: x.path, bytes: new Uint8Array(LIMITS.fileBytes + 1) }); continue; } out.push({ path: x.path, bytes: new Uint8Array(await x.file.arrayBuffer()) }); }
  // (Files of other kinds are named, not read, so the report can say they were left out.)
  for (const x of list) if (!WANTED.test(x.path)) out.push({ path: x.path, bytes: new Uint8Array(0) });
  return out;
}
/** An entry's name: as written when the zip says UTF-8 or the bytes are valid UTF-8; else Shift_JIS (the Japanese packs
 *  zipped on Windows), where the platform can read it. */
export function zipName(e: { name: string; raw?: Uint8Array; utf8?: boolean }): string {
  if (e.utf8 || !e.raw) return e.name;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(e.raw); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('shift_jis', { fatal: true }).decode(e.raw); } catch { return e.name; }
}
export async function readZip(b: Blob): Promise<PackFile[]> {
  const { zipEntries, zipRead } = await import('../ipa/zip');
  let entries; try { entries = await zipEntries(b); } catch { throw new PackError('notZip'); }
  entries = entries.filter((e) => !e.name.endsWith('/')).map((e) => ({ ...e, name: zipName(e) }));
  if (entries.length > LIMITS.files * 2) throw new PackError('tooManyFiles');
  const out: PackFile[] = []; let total = 0;
  for (const e of entries) {
    if (!WANTED.test(e.name)) { out.push({ path: e.name, bytes: new Uint8Array(0) }); continue; }
    if (e.usize > LIMITS.fileBytes) { out.push({ path: e.name, bytes: new Uint8Array(LIMITS.fileBytes + 1) }); continue; }
    // (What a deflated entry really unpacks to is counted, not what it claims: a bomb stops at the limit.)
    const bytes = await zipRead(b, e, LIMITS.fileBytes + 1).catch(() => null); if (!bytes) continue;
    total += bytes.length; if (total > LIMITS.totalBytes) throw new PackError('tooBig');
    out.push({ path: e.name, bytes });
  }
  return out;
}

/* ---------- frames into pictures ---------- */
function canvasOf(w: number, h: number): HTMLCanvasElement { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const toPng = (c: HTMLCanvasElement): Promise<Blob> => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new PackError('encode'))), 'image/png'));
/** A moment for the page between two frames (a long import never holds the window), and the cancel checked. */
const breathe = (signal?: AbortSignal): Promise<void> => new Promise((res, rej) => setTimeout(() => (signal?.aborted ? rej(new PackError('cancelled')) : res()), 0));
/** Each frame as its own PNG, with its size; `progress` told as they are made; `signal` cancels. Checked against the
 *  limits before anything is decoded; then one picture at a time — a sheet decoded, its cells cut, let go; a GIF's
 *  frames composed in order on one buffer, only up to the last frame used. */
export async function makeFrames(frames: FrameSrc[], files: PackFile[], progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<{ blobs: Blob[]; sizes: [number, number][] }> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  checkFrameBudget(frames, (p) => { const f = byPath.get(p); return f ? picInfo(f) : null; });
  const blobs: Blob[] = new Array(frames.length); const sizes: [number, number][] = new Array(frames.length);
  const order = new Map<string, number[]>(); frames.forEach((fr, i) => { const l = order.get(fr.file); if (l) l.push(i); else order.set(fr.file, [i]); });
  let done = 0;
  const keep = async (i: number, c: HTMLCanvasElement) => { blobs[i] = await toPng(c); sizes[i] = [c.width, c.height]; c.width = c.height = 0; progress?.(++done, frames.length); await breathe(signal); };
  for (const [file, idxs] of order) {
    const f = byPath.get(file); if (!f) throw new PackError('missing');
    if (imageKind(f.bytes) === 'gif') {
      let d: GifDecoder; try { d = new GifDecoder(f.bytes, LIMITS.framePx); } catch { throw new PackError('badPicture'); }
      for (const i of [...idxs].sort((a, b) => (frames[a].gif ?? 0) - (frames[b].gif ?? 0))) {
        let rgba: Uint8ClampedArray; try { rgba = d.frame(frames[i].gif ?? 0); } catch { throw new PackError('badPicture'); }
        const c = canvasOf(d.w, d.h); c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), d.w, d.h), 0, 0);
        await keep(i, c);
      }
      continue;
    }
    let bm: ImageBitmap; try { bm = await createImageBitmap(new Blob([f.bytes as BlobPart], { type: imageKind(f.bytes) === 'webp' ? 'image/webp' : 'image/png' })); } catch { throw new PackError('badPicture'); }
    try {
      for (const i of idxs) {
        const [x, y, w, h] = frames[i].cell ?? [0, 0, bm.width, bm.height];
        if (w > LIMITS.framePx || h > LIMITS.framePx || x + w > bm.width || y + h > bm.height) throw new PackError('frameTooBig');
        const c = canvasOf(w, h); c.getContext('2d')!.drawImage(bm, x, y, w, h, 0, 0, w, h);
        await keep(i, c);
      }
    } finally { bm.close(); }
  }
  return { blobs, sizes };
}
